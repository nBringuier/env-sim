/**
 * web-coverage.mjs
 *
 * Module autonome de pilotage de la couverture front (Angular/TypeScript)
 * via CDP (Chrome DevTools Protocol). Suit le même patron que
 * jacoco-coverage.mjs : configuration interne + fonctions publiques
 * calquées sur le cycle de vie start / stop / report.
 *
 * Responsabilités :
 *   - Connexion CDP à Chromium (tunnel SSH côté appelant)
 *   - Démarrage/arrêt de la collecte précise V8 (Profiler.*PreciseCoverage)
 *   - Téléchargement des bundles .js/.js.map depuis Quarkus
 *   - Résolution du bundle "main" même avec outputHashing actif
 *   - Conversion V8 → Istanbul (via v8-to-istanbul, en mémoire)
 *   - Génération du rapport HTML (via istanbul-lib-report / istanbul-reports)
 *
 * Convention de fichiers :
 *   coverage-sessions/<id>.json   — coverage V8 brute de la session front
 *   coverage-report/index.html    — rapport HTML Istanbul
 *   coverage-report/coverage-final.json — export JSON brut (pour requirement-coverage.mjs)
 */

import fs                from 'node:fs';
import path              from 'node:path';
import { execSync }      from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

function log(msg)  { console.log(`\x1b[36m[web-coverage]\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m[web-coverage]\x1b[0m ✔ ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[web-coverage]\x1b[0m ⚠ ${msg}`); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function sessionId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ─── Config (résolue une fois, passée par controller.mjs) ────────────────────

let config = null;
let libCoverage, libReport, istanbulReports, v8toIstanbul, mergeProcessCovs;

function ensureConfigured() {
  if (!config) throw new Error('web-coverage.mjs non configuré — appelez configureWebCoverage() au démarrage');
}

/**
 * À appeler une fois au démarrage du controller pour configurer le module.
 * Installe les dépendances npm manquantes si besoin (comme jacoco-coverage.mjs
 * télécharge jacococli.jar automatiquement).
 *
 * @param {object} opts
 * @param {string} opts.appUrl          - URL de l'app côté Chromium (ex: http://localhost:8080)
 * @param {string} opts.cdpUrl          - URL du CDP (ex: http://localhost:9222, via tunnel SSH)
 * @param {string} opts.sessionsDir     - dossier de stockage des sessions
 * @param {string} opts.reportDir       - dossier de sortie du rapport HTML
 * @param {string[]} opts.includePrefixes - préfixes de chemins à inclure (ex: ['src/'])
 */
export async function configureWebCoverage(opts) {
  config = {
    appUrl:          opts.appUrl,
    cdpUrl:          opts.cdpUrl,
    sessionsDir:     opts.sessionsDir,
    reportDir:       opts.reportDir,
    includePrefixes: opts.includePrefixes || ['src/'],
  };

  ensureDir(config.sessionsDir);
  ensureDir(config.reportDir);

  log('Vérification des dépendances…');
  const NEEDED = [
    'v8-to-istanbul', '@bcoe/v8-coverage',
    'istanbul-lib-coverage', 'istanbul-lib-report', 'istanbul-reports',
  ];
  const missing = NEEDED.filter(pkg => {
    try { require.resolve(pkg); return false; } catch { return true; }
  });
  if (missing.length) {
    log(`Installation: ${missing.join(', ')}`);
    execSync(`npm install --save-dev ${missing.join(' ')}`, { stdio: 'inherit', cwd: __dirname });
  }
  ok('Dépendances OK');

  ({ mergeProcessCovs } = await import('@bcoe/v8-coverage'));
  v8toIstanbul    = (await import('v8-to-istanbul')).default;
  libCoverage     = require('istanbul-lib-coverage');
  libReport       = require('istanbul-lib-report');
  istanbulReports = require('istanbul-reports');

  log(`Préfixes inclus (front) : ${config.includePrefixes.join(', ')}`);
}

// ─── Helpers de préfixes ──────────────────────────────────────────────────────

function isIncluded(normalisedPath) {
  return config.includePrefixes.some(prefix => normalisedPath.includes(prefix));
}

function relativeKeyFor(normalisedPath) {
  for (const prefix of config.includePrefixes) {
    const idx = normalisedPath.indexOf(prefix);
    if (idx !== -1) return normalisedPath.slice(idx);
  }
  return null;
}

// ─── Sessions (listing) ───────────────────────────────────────────────────────

/**
 * Liste toutes les sessions front enregistrées, triées de la plus récente
 * à la plus ancienne.
 */
export function listWebSessions() {
  ensureConfigured();
  if (!fs.existsSync(config.sessionsDir)) return [];
  return fs.readdirSync(config.sessionsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fullPath = path.join(config.sessionsDir, f);
      const stat     = fs.statSync(fullPath);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(fullPath, 'utf8'))._meta || {}; } catch {}
      return {
        id:       path.basename(f, '.json'),
        size:     stat.size,
        date:     stat.mtime.toISOString(),
        label:    meta.label    || '',
        duration: meta.duration || 0,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Supprime les fichiers de session front pour les ids donnés.
 */
export function deleteWebSessions(ids) {
  ensureConfigured();
  for (const id of ids) {
    const f = path.join(config.sessionsDir, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  return { deleted: ids };
}

// ─── Fetching bundles depuis Quarkus ─────────────────────────────────────────

// Cache en mémoire pour éviter de re-télécharger à chaque rapport
const bundleCache = new Map(); // bundleName → { js: string, map: object }
let mainBundleNameCache = null;

async function fetchBundle(bundleName) {
  if (bundleCache.has(bundleName)) return bundleCache.get(bundleName);

  const jsUrl  = `${config.appUrl}/${bundleName}`;
  const mapUrl = `${config.appUrl}/${bundleName}.map`;

  const [jsRes, mapRes] = await Promise.all([
    fetch(jsUrl),
    fetch(mapUrl),
  ]);

  if (!jsRes.ok)  throw new Error(`Impossible de télécharger ${jsUrl} (${jsRes.status})`);
  if (!mapRes.ok) throw new Error(`Impossible de télécharger ${mapUrl} (${mapRes.status})`);

  const js  = await jsRes.text();
  const map = await mapRes.json();

  const bundle = { js, map };
  bundleCache.set(bundleName, bundle);
  ok(`Bundle téléchargé : ${bundleName} (${(js.length/1024).toFixed(0)} KB)`);
  return bundle;
}

/**
 * Vide le cache de bundles téléchargés. À appeler à chaque nouvelle session
 * pour être sûr de récupérer les fichiers effectivement servis à ce moment-là
 * (utile après un redéploiement, un changement de hash, etc.).
 */
export function clearBundleCache() {
  bundleCache.clear();
  mainBundleNameCache = null;
  log('Cache bundles vidé');
}

/**
 * Résout le vrai nom de fichier du bundle "main" en cherchant dans index.html.
 * Sans outputHashing, c'est simplement "main.js". Avec outputHashing: "all"
 * ou "bundles", Angular génère "main.<hash>.js" ou "main-<hash>.js" — le nom
 * exact ne peut être connu qu'en lisant les <script> réellement injectés dans
 * index.html, qui est la seule source de vérité (Angular réécrit ces balises
 * à chaque build).
 */
async function resolveMainBundleName() {
  if (mainBundleNameCache) return mainBundleNameCache;

  const res = await fetch(`${config.appUrl}/index.html`);
  if (!res.ok) {
    throw new Error(
      `Impossible de télécharger ${config.appUrl}/index.html (${res.status}) ` +
      `pour résoudre le nom du bundle main (outputHashing actif ?)`
    );
  }
  const html = await res.text();

  // Cherche <script src="main.js"> ou <script src="main.HASH.js"> ou "main-HASH.js"
  // Le nom peut être suivi de . ou - avant le hash, selon la config Angular.
  const match = html.match(/<script[^>]+src="([^"]*main[^"]*\.js)"/);
  if (!match) {
    throw new Error(
      `Aucune balise <script src="main...js"> trouvée dans index.html. ` +
      `Vérifiez que ${config.appUrl}/index.html correspond bien au build Angular attendu.`
    );
  }

  // Le src peut être un chemin relatif (ex: "./main.abc123.js") — on ne garde que le nom de fichier
  mainBundleNameCache = path.basename(match[1]);
  log(`Bundle main résolu depuis index.html : ${mainBundleNameCache}`);
  return mainBundleNameCache;
}

// ─── CDP / Puppeteer ─────────────────────────────────────────────────────────

let browser      = null;
let page         = null;
let cdpSession   = null;
let sessionStart = null;
let isRecording  = false;

/**
 * Vérifie que le CDP de Chromium est joignable (via le tunnel SSH ou direct).
 */
export async function checkCdpReachable() {
  ensureConfigured();
  try {
    const res = await fetch(`${config.cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

/**
 * Connecte puppeteer au Chromium distant et localise l'onglet de l'app.
 *
 * IMPORTANT : cette fonction NE RECHARGE PAS la page volontairement, même
 * si elle en crée une nouvelle ou en réutilise une déjà ouverte. Le reload
 * est délibérément différé à startWebSession(), qui active la collecte
 * PUIS recharge — car V8 n'active le block coverage (isBlockCoverage: true,
 * nécessaire aux branches) que sur des scripts pas encore compilés. Un reload
 * ici serait soit inutile (scripts compilés sans coverage), soit redondant.
 */
async function connectCDP() {
  const puppeteer = await import('puppeteer-core');
  browser = await puppeteer.connect({
    browserURL:      config.cdpUrl,
    defaultViewport: null,
  });

  const pages = await browser.pages();

  // Chercher parmi tous les onglets ouverts celui qui pointe déjà sur l'app.
  // Évite de piloter par erreur un onglet quelconque (about:blank, devtools,
  // ou toute autre page ouverte par le testeur en parallèle).
  page = pages.find(p => p.url().startsWith(config.appUrl)) || null;

  if (!page) {
    // Aucun onglet sur l'app : réutiliser un onglet vierge s'il y en a un,
    // sinon en créer un nouveau, puis y naviguer.
    page = pages.find(p => p.url() === 'about:blank') || await browser.newPage();
    await page.goto(config.appUrl, { waitUntil: 'networkidle2' });
    log(`Aucun onglet sur ${config.appUrl} trouvé — navigation effectuée sur un onglet dédié`);
  } else {
    log(`Onglet existant sur ${config.appUrl} réutilisé`);
  }

  cdpSession = await page.createCDPSession();
  ok(`CDP connecté → ${config.cdpUrl}`);
}

// ─── Cycle de vie : start / stop / report ────────────────────────────────────

/**
 * Démarre une session de collecte front : connecte (ou reconnecte) le CDP,
 * active le block coverage précis, puis recharge la page dans le bon ordre.
 */
export async function startWebSession() {
  ensureConfigured();

  if (!await checkCdpReachable()) {
    throw new Error(
      `CDP non accessible sur ${config.cdpUrl}. ` +
      `Vérifiez le tunnel SSH ou la connectivité réseau vers Chromium.`
    );
  }

  if (!browser) {
    await connectCDP();
  } else {
    // Vérifier que la session CDP est encore vivante
    try {
      await cdpSession.send('Runtime.enable');
    } catch {
      // Session perdue (ex: navigation manuelle), on reconnecte
      await connectCDP();
    }
  }

  // Vider le cache bundles — le reload qui suit va re-servir les fichiers
  clearBundleCache();

  // IMPORTANT : activer le block coverage AVANT le reload de la page.
  // Si on active après que les scripts sont déjà compilés par V8,
  // isBlockCoverage restera false et les branches ne seront pas collectées.
  await cdpSession.send('Profiler.enable');
  await cdpSession.send('Profiler.startPreciseCoverage', {
    callCount:             true,
    detailed:              true,   // ← active le block coverage (branches)
    allowTriggeredUpdates: false,
  });
  ok('Collecte précise activée — rechargement de la page…');

  // Recharger la page APRÈS avoir activé la collecte :
  // V8 recompile les scripts avec le block coverage actif → isBlockCoverage: true
  await page.reload({ waitUntil: 'networkidle2' });

  sessionStart = Date.now();
  isRecording  = true;
  ok('Page rechargée — collecte démarrée (branches incluses)');

  return { ok: true, startedAt: sessionStart };
}

/**
 * Arrête la collecte front en cours, sauvegarde la coverage V8 brute
 * dans coverage-sessions/<id>.json.
 * @param {string} label - libellé optionnel de la session
 */
export async function stopWebSession(label) {
  ensureConfigured();
  if (!isRecording) throw new Error('Aucune session front en cours');

  const { result } = await cdpSession.send('Profiler.takePreciseCoverage');
  await cdpSession.send('Profiler.stopPreciseCoverage');
  await cdpSession.send('Profiler.disable');
  isRecording = false;

  const duration = Date.now() - sessionStart;
  const id       = sessionId();

  // Ne garder que les bundles JS de l'app
  const filtered = result.filter(e =>
    e.url && e.url.startsWith(config.appUrl) && e.url.endsWith('.js')
  );

  fs.writeFileSync(
    path.join(config.sessionsDir, `${id}.json`),
    JSON.stringify({
      _meta:  { id, label, duration, date: new Date().toISOString() },
      result: filtered,
    }, null, 2)
  );

  ok(`Session sauvegardée : ${id}  (${filtered.length} bundle(s), ${(duration/1000).toFixed(0)}s)`);
  return { id, duration, bundleCount: filtered.length };
}

// ─── Rapport ─────────────────────────────────────────────────────────────────

/**
 * Normalise une clé absolue produite par v8-to-istanbul vers une clé relative
 * ex: /home/user/.../virtual/src/app/foo.ts → src/app/foo.ts
 * ex: /home/user/.../virtual/node_modules/ma-lib/foo.ts → node_modules/ma-lib/foo.ts
 */
function normaliseKey(absKey) {
  const norm = absKey.replace(/\\/g, '/');
  return relativeKeyFor(norm);
}

/**
 * Construit une entrée Istanbul à 0% (fichier jamais chargé).
 * Le contenu TypeScript vient de sourcesContent dans le .map.
 */
function buildZeroEntry(sourceContent, relKey) {
  const lines        = sourceContent.split('\n');
  const statementMap = {};
  const s            = {};
  let idx = 0;
  lines.forEach((line, lineNum) => {
    if (!line.trim()) return;
    statementMap[idx] = {
      start: { line: lineNum + 1, column: 0 },
      end:   { line: lineNum + 1, column: line.length },
    };
    s[idx] = 0;
    idx++;
  });
  return { path: relKey, statementMap, fnMap: {}, branchMap: {}, s, f: {}, b: {} };
}

/**
 * Génère le rapport HTML front (Istanbul) pour une ou plusieurs sessions.
 * @param {string[]} sessionIds
 * @returns {object} { coveredFiles, zeroFiles, sourceContents, allIstanbulData }
 *   sourceContents et allIstanbulData sont ré-exposés pour permettre
 *   au controller de les transmettre à requirement-coverage.mjs sans
 *   dupliquer le téléchargement/la conversion.
 */
export async function generateWebReport(sessionIds) {
  ensureConfigured();
  clearBundleCache();

  // ── 1. Charger et fusionner les sessions ───────────────────────────────────
  const allSessions = sessionIds.map(id => {
    const raw = JSON.parse(fs.readFileSync(path.join(config.sessionsDir, `${id}.json`), 'utf8'));
    return { result: raw.result };
  });
  const merged = allSessions.length === 1
    ? allSessions[0].result
    : mergeProcessCovs(allSessions).result;

  // ── 2. Référentiel complet des sources depuis le .map du bundle main ───────
  const mainBundleName = await resolveMainBundleName();
  const mainBundle = await fetchBundle(mainBundleName);
  const mainMap    = mainBundle.map;
  const allSources = (mainMap.sources || []).filter(s => isIncluded(s.replace(/\\/g, '/')));
  log(`${allSources.length} fichiers sources référencés dans ${mainBundleName}.map (préfixes: ${config.includePrefixes.join(', ')})`);

  // Table relKey → contenu TypeScript (depuis sourcesContent)
  // Indexé par la position dans sources[] pour correspondance exacte
  const sourceContents = {}; // relKey → string
  (mainMap.sourcesContent || []).forEach((content, i) => {
    if (!mainMap.sources[i]) return;
    const norm   = mainMap.sources[i].replace(/\\/g, '/');
    const relKey = relativeKeyFor(norm);
    if (relKey) sourceContents[relKey] = content || '';
  });

  // ── 3. Convertir chaque bundle en données Istanbul ─────────────────────────
  // Tout se passe en mémoire : on passe source + sourceMap directement
  // à v8-to-istanbul via l'option sources{} — pas de fichier temporaire.
  const allIstanbulData = {}; // relKey → CoverageData (fusionné si plusieurs bundles)

  for (const entry of merged) {
    if (!entry.url?.endsWith('.js')) continue;

    const bundleName = path.basename(new URL(entry.url).pathname);
    let bundle;
    try {
      bundle = await fetchBundle(bundleName);
    } catch (err) {
      warn(`Impossible de récupérer ${bundleName}: ${err.message}`);
      continue;
    }

    try {
      // On passe le JS et le sourceMap directement en mémoire :
      // v8-to-istanbul utilisera sourcesContent depuis le map → pas de lecture disque
      const converter = v8toIstanbul(
        `virtual/${bundleName}`,  // chemin fictif — jamais lu depuis le disque
        0,
        {
          source:    bundle.js,
          sourceMap: { sourcemap: bundle.map },
        }
      );
      await converter.load();
      converter.applyCoverage(entry.functions || []);
      const data = converter.toIstanbul();

      for (const [absKey, fileData] of Object.entries(data)) {
        const relKey = normaliseKey(absKey);
        if (!relKey) continue;
        fileData.path = relKey;
        allIstanbulData[relKey] = fileData;
      }
      ok(`Converti : ${bundleName} (${Object.keys(data).length} entrées)`);
    } catch (err) {
      warn(`Conversion échouée pour ${bundleName}: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }
  }

  // ── 4. Ajouter les fichiers jamais chargés à 0% ────────────────────────────
  let zeroCount = 0;
  for (const rawPath of allSources) {
    const norm   = rawPath.replace(/\\/g, '/');
    const relKey = relativeKeyFor(norm) || norm;
    if (allIstanbulData[relKey]) continue;          // déjà couvert
    const content = sourceContents[relKey] || '';
    if (!content.trim()) continue;                  // fichier vide
    allIstanbulData[relKey] = buildZeroEntry(content, relKey);
    zeroCount++;
  }

  const coveredCount = Object.keys(allIstanbulData).length - zeroCount;
  ok(`${coveredCount} fichier(s) couverts, ${zeroCount} à 0%`);

  // ── 5. Générer le rapport HTML via l'API Istanbul directe ──────────────────
  // sourceFinder : retourne le source TypeScript depuis notre cache en mémoire
  // (évite toute lecture disque → résout l'erreur ENOENT)
  ensureDir(config.reportDir);

  const coverageMap = libCoverage.createCoverageMap(allIstanbulData);
  const context = libReport.createContext({
    dir: config.reportDir,
    coverageMap,
    sourceFinder: (relPath) => {
      if (sourceContents[relPath] !== undefined) return sourceContents[relPath];
      // Tentative de correspondance partielle (certains reporters normalisent le chemin)
      const match = Object.keys(sourceContents).find(k => k.endsWith(relPath) || relPath.endsWith(k));
      if (match) return sourceContents[match];
      warn(`Source introuvable en mémoire : ${relPath}`);
      return `// Source non disponible: ${relPath}`;
    },
  });

  istanbulReports.create('html').execute(context);
  istanbulReports.create('text-summary').execute(context);
  // Export JSON brut pour le rapport d'exigences
  istanbulReports.create('json').execute(context);

  ok(`Rapport généré → ${config.reportDir}/index.html`);
  return { coveredFiles: coveredCount, zeroFiles: zeroCount, sourceContents, allIstanbulData };
}

// ─── Statut / accesseurs pour le controller ──────────────────────────────────

/**
 * Retourne l'état courant de la collecte front, pour /api/status.
 */
export function getWebStatus() {
  return {
    isRecording,
    elapsed:       sessionStart ? Date.now() - sessionStart : 0,
    chromiumReady: !!browser,
  };
}
