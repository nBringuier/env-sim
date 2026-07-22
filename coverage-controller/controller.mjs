#!/usr/bin/env node
/**
 * controller.mjs
 *
 * Tourne sur la machine B (WSL).
 * - Se connecte au CDP de Chromium sur machine A via tunnel SSH
 *   (tunnel à ouvrir manuellement : ssh -L 9222:localhost:9222 user@machineA)
 * - Télécharge les .js et .js.map depuis Quarkus (machine A :8080)
 *   les .map contiennent sourcesContent → pas besoin de src/ en local
 * - Génère un rapport HTML Istanbul avec couverture par fonction
 * - En parallèle (si --java-repo fourni), pilote la couverture backend
 *   Java via un agent JaCoCo en mode tcpserver (module jacoco-coverage.mjs)
 *
 * Usage:
 *   node controller.mjs [options]
 *
 * Options:
 *   --port              Port du panel de contrôle        (défaut: 9223)
 *   --target            Host:port de l'app Quarkus        (défaut: localhost:8080)
 *   --cdp-port          Port CDP (bout local du tunnel)   (défaut: 9222)
 *   --sessions          Dossier sessions                  (défaut: ./coverage-sessions)
 *   --report            Dossier rapport HTML              (défaut: ./coverage-report)
 *   --include-prefixes  Préfixes des sources à inclure,   (défaut: src/)
 *                        séparés par des virgules.
 *                        Ex: "src/,node_modules/ma-lib-maison/"
 *
 *   --java-repo         Clone git local du projet Java.   (optionnel — active JaCoCo
 *                        Doit être tenu à jour (git pull   si fourni)
 *                        + mvn compile) par le testeur.
 *   --jacoco-cli        Chemin vers jacococli.jar.         (optionnel — auto-téléchargé
 *                                                            depuis Maven Central sinon)
 *   --jacoco-host       Host de l'agent JaCoCo tcpserver.  (défaut: localhost)
 *   --jacoco-port       Port de l'agent JaCoCo tcpserver.  (défaut: 6300)
 */

import express           from 'express';
import { WebSocketServer } from 'ws';
import http              from 'node:http';
import fs                from 'node:fs';
import path              from 'node:path';
import { execSync }      from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : fallback;
}

const CONTROLLER_PORT = parseInt(getArg('--port',       '9223'));
const TARGET          = getArg('--target',    'localhost:8080');
const CDP_PORT        = parseInt(getArg('--cdp-port',   '9222'));
const SESSIONS_DIR    = path.resolve(getArg('--sessions', './coverage-sessions'));
const REPORT_DIR      = path.resolve(getArg('--report',   './coverage-report'));

// Liste des préfixes de chemins à inclure dans le rapport front.
// Un fichier référencé dans les .map est retenu si son chemin contient
// AU MOINS UN de ces préfixes. Permet d'inclure des libs maison
// situées dans node_modules/ en plus du code applicatif dans src/.
const INCLUDE_PREFIXES = getArg('--include-prefixes', 'src/')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);

// ── JaCoCo (backend Java) — tout est optionnel, désactivé si --java-repo absent ──
const JAVA_REPO_DIR  = getArg('--java-repo',   null);
const JACOCO_CLI_JAR = getArg('--jacoco-cli',  null); // optionnel — auto-téléchargé sinon
const JACOCO_HOST    = getArg('--jacoco-host', 'localhost');
const JACOCO_PORT    = parseInt(getArg('--jacoco-port', '6300'));
const JACOCO_ENABLED = !!JAVA_REPO_DIR;

const APP_URL         = `http://${TARGET}`;
const CDP_URL         = `http://localhost:${CDP_PORT}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`\x1b[36m[controller]\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m[controller]\x1b[0m ✔ ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[controller]\x1b[0m ⚠ ${msg}`); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function sessionId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Teste si un chemin normalisé (slashes uniquement) contient
 * au moins un des préfixes d'inclusion configurés.
 */
function isIncluded(normalisedPath) {
  return INCLUDE_PREFIXES.some(prefix => normalisedPath.includes(prefix));
}

/**
 * Retourne la clé relative à partir du premier préfixe d'inclusion trouvé.
 * Ex: "/home/x/node_modules/ma-lib/foo.ts" avec prefix "node_modules/ma-lib/"
 *     → "node_modules/ma-lib/foo.ts"
 * Retourne null si aucun préfixe ne matche.
 */
function relativeKeyFor(normalisedPath) {
  for (const prefix of INCLUDE_PREFIXES) {
    const idx = normalisedPath.indexOf(prefix);
    if (idx !== -1) return normalisedPath.slice(idx);
  }
  return null;
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fullPath = path.join(SESSIONS_DIR, f);
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

// ─── Dependency check ────────────────────────────────────────────────────────

log('Vérification des dépendances…');
const NEEDED  = [
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

const { mergeProcessCovs } = await import('@bcoe/v8-coverage');
const v8toIstanbul          = (await import('v8-to-istanbul')).default;
const libCoverage           = require('istanbul-lib-coverage');
const libReport             = require('istanbul-lib-report');
const istanbulReports       = require('istanbul-reports');

ensureDir(SESSIONS_DIR);
ensureDir(REPORT_DIR);

log(`Préfixes inclus (front) : ${INCLUDE_PREFIXES.join(', ')}`);

// ── Module JaCoCo optionnel — n'importe rien si --java-repo absent ──────────
let jacocoModule = null;
if (JACOCO_ENABLED) {
  jacocoModule = await import('./jacoco-coverage.mjs');
  jacocoModule.configureJacoco({
    jacocoCliJar: JACOCO_CLI_JAR,
    javaRepoDir:  JAVA_REPO_DIR,
    jacocoHost:   JACOCO_HOST,
    jacocoPort:   JACOCO_PORT,
    sessionsDir:  SESSIONS_DIR,
    reportDir:    REPORT_DIR,
  });
  ok(`JaCoCo activé — repo: ${JAVA_REPO_DIR}, agent: ${JACOCO_HOST}:${JACOCO_PORT}`);
} else {
  log("JaCoCo désactivé (--java-repo requis pour l'activer)");
}

// ─── Fetching bundles depuis Quarkus ─────────────────────────────────────────

// Cache en mémoire pour éviter de re-télécharger à chaque rapport
const bundleCache = new Map(); // bundleName → { js: string, map: object }

async function fetchBundle(bundleName) {
  if (bundleCache.has(bundleName)) return bundleCache.get(bundleName);

  const jsUrl  = `${APP_URL}/${bundleName}`;
  const mapUrl = `${APP_URL}/${bundleName}.map`;

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

function clearBundleCache() {
  bundleCache.clear();
  mainBundleNameCache = null;
  log('Cache bundles vidé');
}

// Cache du vrai nom de fichier "main" résolu depuis index.html
// (nécessaire avec outputHashing: "all" → main.<hash>.js au lieu de main.js)
let mainBundleNameCache = null;

/**
 * Résout le vrai nom de fichier du bundle "main" en cherchant dans index.html.
 * Sans outputHashing, c'est simplement "main.js". Avec outputHashing: "all"
 * ou "bundles", Angular génère "main.<hash>.js" — le nom exact ne peut être
 * connu qu'en lisant les <script> réellement injectés dans index.html,
 * qui est la seule source de vérité (Angular réécrit ces balises à chaque build).
 */
async function resolveMainBundleName() {
  if (mainBundleNameCache) return mainBundleNameCache;

  const res = await fetch(`${APP_URL}/index.html`);
  if (!res.ok) {
    throw new Error(
      `Impossible de télécharger ${APP_URL}/index.html (${res.status}) ` +
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
      `Vérifiez que ${APP_URL}/index.html correspond bien au build Angular attendu.`
    );
  }

  // Le src peut être un chemin relatif (ex: "./main.abc123.js") — on ne garde que le nom de fichier
  mainBundleNameCache = path.basename(match[1]);
  log(`Bundle main résolu depuis index.html : ${mainBundleNameCache}`);
  return mainBundleNameCache;
}

/**
 * Récupère la liste de tous les fichiers sources depuis le .map du bundle main
 * (propriété sources[] du source map).
 * Filtre sur INCLUDE_PREFIXES pour ne garder que le code applicatif
 * (+ les libs maison explicitement incluses).
 */
async function fetchAllSourcesFromMainMap() {
  const mainBundleName = await resolveMainBundleName();
  const { map } = await fetchBundle(mainBundleName);
  if (!map.sources) return [];
  return map.sources.filter(s => isIncluded(s.replace(/\\/g, '/')));
}

// ─── CDP / Puppeteer ─────────────────────────────────────────────────────────

let browser      = null;
let page         = null;
let cdpSession   = null;
let sessionStart = null;
let isRecording  = false;

async function checkCdpReachable() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

/**
 * Connecte puppeteer au Chromium distant et localise l'onglet de l'app.
 *
 * IMPORTANT : cette fonction NE RECHARGE PAS la page volontairement, même
 * si elle en crée une nouvelle ou en réutilise une déjà ouverte. Le reload
 * est délibérément différé à startPreciseCoverage(), qui DOIT être appelée
 * juste après connectCDP() dans le flux de démarrage de session — car
 * V8 n'active le block coverage (isBlockCoverage: true, nécessaire aux
 * branches) que sur des scripts pas encore compilés. Un reload ici serait
 * soit inutile (scripts compilés sans coverage), soit redondant avec celui
 * de startPreciseCoverage (double reload à chaque démarrage de session).
 */
async function connectCDP() {
  const puppeteer = await import('puppeteer-core');
  browser = await puppeteer.connect({
    browserURL:      CDP_URL,
    defaultViewport: null,
  });

  const pages = await browser.pages();

  // Chercher parmi tous les onglets ouverts celui qui pointe déjà sur l'app.
  // Évite de piloter par erreur un onglet quelconque (about:blank, devtools,
  // ou toute autre page ouverte par le testeur en parallèle).
  page = pages.find(p => p.url().startsWith(APP_URL)) || null;

  if (!page) {
    // Aucun onglet sur l'app : réutiliser un onglet vierge s'il y en a un,
    // sinon en créer un nouveau, puis y naviguer.
    page = pages.find(p => p.url() === 'about:blank') || await browser.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle2' });
    log(`Aucun onglet sur ${APP_URL} trouvé — navigation effectuée sur un onglet dédié`);
  } else {
    log(`Onglet existant sur ${APP_URL} réutilisé`);
  }

  cdpSession = await page.createCDPSession();
  ok(`CDP connecté → ${CDP_URL}`);
}

async function startPreciseCoverage() {
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
}

async function stopAndCollect(label) {
  const { result } = await cdpSession.send('Profiler.takePreciseCoverage');
  await cdpSession.send('Profiler.stopPreciseCoverage');
  await cdpSession.send('Profiler.disable');
  isRecording = false;

  const duration = Date.now() - sessionStart;
  const id       = sessionId();

  // Ne garder que les bundles JS de l'app
  const filtered = result.filter(e =>
    e.url && e.url.startsWith(APP_URL) && e.url.endsWith('.js')
  );

  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${id}.json`),
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

async function generateReport(sessionIds) {
  clearBundleCache();

  // ── 1. Charger et fusionner les sessions ───────────────────────────────────
  const allSessions = sessionIds.map(id => {
    const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
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
  log(`${allSources.length} fichiers sources référencés dans ${mainBundleName}.map (préfixes: ${INCLUDE_PREFIXES.join(', ')})`);

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
  ensureDir(REPORT_DIR);

  const coverageMap = libCoverage.createCoverageMap(allIstanbulData);
  const context = libReport.createContext({
    dir: REPORT_DIR,
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

  ok(`Rapport généré → ${REPORT_DIR}/index.html`);
  return { coveredFiles: coveredCount, zeroFiles: zeroCount, sourceContents, allIstanbulData };
}

// ─── Express + WebSocket ─────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

setInterval(() => {
  if (isRecording && sessionStart)
    broadcast({ type: 'tick', elapsed: Date.now() - sessionStart });
}, 1000);

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  res.json({
    isRecording,
    elapsed:       sessionStart ? Date.now() - sessionStart : 0,
    appUrl:        APP_URL,
    cdpUrl:        CDP_URL,
    chromiumReady: !!browser,
    cdpReachable:  await checkCdpReachable(),
    jacocoEnabled: JACOCO_ENABLED,
  });
});

app.get('/api/sessions', (_req, res) => res.json(listSessions()));

app.delete('/api/sessions', (req, res) => {
  const { ids } = req.body;
  for (const id of ids) {
    const f = path.join(SESSIONS_DIR, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    // Nettoyer aussi le .exec backend associé, s'il existe
    const execF = path.join(SESSIONS_DIR, `${id}-backend.exec`);
    if (fs.existsSync(execF)) fs.unlinkSync(execF);
  }
  res.json({ deleted: ids });
});

app.post('/api/session/start', async (req, res) => {
  try {
    if (isRecording) return res.status(400).json({ error: 'Session déjà en cours' });

    if (!await checkCdpReachable()) {
      return res.status(503).json({
        error:   `CDP non accessible sur ${CDP_URL}`,
        hint:    `Ouvrez le tunnel SSH : ssh -L ${CDP_PORT}:localhost:${CDP_PORT} user@machineA`,
      });
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

    // Démarrer la collecte backend en parallèle du front (si configuré).
    // On le fait AVANT startPreciseCoverage pour que les deux collectes
    // démarrent au plus proche l'une de l'autre.
    if (jacocoModule) {
      try {
        await jacocoModule.startJacocoSession();
      } catch (err) {
        warn(`JaCoCo start ignoré : ${err.message}`);
      }
    }

    // startPreciseCoverage active la collecte PUIS recharge la page
    // dans le bon ordre pour avoir isBlockCoverage: true (branches)
    await startPreciseCoverage();
    res.json({ ok: true, startedAt: sessionStart, jacocoEnabled: JACOCO_ENABLED });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/stop', async (req, res) => {
  try {
    if (!isRecording) return res.status(400).json({ error: 'Aucune session en cours' });

    const result = await stopAndCollect(req.body.label || '');

    // Arrêter la collecte backend en parallèle (si configuré), même id de session
    if (jacocoModule) {
      try {
        const backendResult = await jacocoModule.stopJacocoSession(result.id);
        result.backend = backendResult;
      } catch (err) {
        warn(`JaCoCo stop ignoré : ${err.message}`);
        result.backend = { ok: false, reason: err.message };
      }
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/report', async (req, res) => {
  try {
    const { sessionIds } = req.body;
    if (!sessionIds?.length)
      return res.status(400).json({ error: 'Aucune session sélectionnée' });
    const result = await generateReport(sessionIds);

    // Générer les CSV d'exigences si le module est disponible
    try {
      const { generateRequirementCsv } = await import('./requirement-coverage.mjs');
      const csvResult = await generateRequirementCsv({
        sourceContents:  result.sourceContents,
        allIstanbulData: result.allIstanbulData,
        reportDir:       REPORT_DIR,
      });
      result.csvFiles = csvResult;
      ok(`CSV exigences → ${csvResult.details}, ${csvResult.summary}`);
    } catch (err) {
      warn(`CSV exigences non généré : ${err.message} (requirement-coverage.mjs absent ?)`);
    }

    // Générer le rapport backend JaCoCo en parallèle (si configuré)
    if (jacocoModule) {
      try {
        const backendReport = await jacocoModule.generateJacocoReport(sessionIds);
        result.backendReport = backendReport;
        if (backendReport.ok) ok(`Rapport backend → ${backendReport.reportDir}/index.html`);
      } catch (err) {
        warn(`Rapport JaCoCo non généré : ${err.message}`);
        result.backendReport = { ok: false, reason: err.message };
      }
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use('/report', express.static(REPORT_DIR));
app.use('/report/jacoco', express.static(path.join(REPORT_DIR, 'jacoco')));

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(CONTROLLER_PORT, '0.0.0.0', () => {
  ok(`Panel → http://localhost:${CONTROLLER_PORT}`);
  log(`App    : ${APP_URL}`);
  log(`CDP    : ${CDP_URL}  (tunnel SSH requis)`);
  if (JACOCO_ENABLED) {
    log(`JaCoCo : ${JACOCO_HOST}:${JACOCO_PORT}  (repo: ${JAVA_REPO_DIR})`);
  }
  log('');
  log('Avant de démarrer, ouvrez le tunnel SSH :');
  log(`  ssh -L ${CDP_PORT}:localhost:${CDP_PORT} user@machineA`);
  if (JACOCO_ENABLED) {
    log(`  ssh -L ${JACOCO_PORT}:localhost:${JACOCO_PORT} user@machineA   (peut être ajouté au même tunnel avec -L supplémentaire)`);
  }
});
