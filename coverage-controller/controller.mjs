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
 *
 * Usage:
 *   node controller.mjs [options]
 *
 * Options:
 *   --port        Port du panel de contrôle        (défaut: 9223)
 *   --target      Host:port de l'app Quarkus        (défaut: localhost:8080)
 *   --cdp-port    Port CDP (bout local du tunnel)   (défaut: 9222)
 *   --sessions    Dossier sessions                  (défaut: ./coverage-sessions)
 *   --report      Dossier rapport HTML              (défaut: ./coverage-report)
 *   --src-prefix  Préfixe des sources à inclure     (défaut: src/)
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
const SRC_PREFIX      = getArg('--src-prefix', 'src/');

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
const NEEDED  = ['v8-to-istanbul', '@bcoe/v8-coverage', 'nyc'];
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

ensureDir(SESSIONS_DIR);
ensureDir(REPORT_DIR);

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
  log('Cache bundles vidé');
}

/**
 * Récupère la liste de tous les fichiers sources depuis main.js.map
 * (propriété sources[] du source map).
 * Filtre sur SRC_PREFIX pour ne garder que le code applicatif.
 */
async function fetchAllSourcesFromMainMap() {
  const { map } = await fetchBundle('main.js');
  if (!map.sources) return [];
  return map.sources.filter(s => s.includes(SRC_PREFIX));
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

async function connectCDP() {
  const puppeteer = await import('puppeteer-core');
  browser = await puppeteer.connect({
    browserURL:      CDP_URL,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  page = pages[0] || await browser.newPage();
  if (!page.url().startsWith(APP_URL)) {
    await page.goto(APP_URL, { waitUntil: 'networkidle2' });
  }
  cdpSession = await page.createCDPSession();
  ok(`CDP connecté → ${CDP_URL}`);
}

async function startPreciseCoverage() {
  await cdpSession.send('Profiler.enable');
  await cdpSession.send('Profiler.startPreciseCoverage', {
    callCount:             true,
    detailed:              true,
    allowTriggeredUpdates: false,
  });
  sessionStart = Date.now();
  isRecording  = true;
  ok('Collecte précise démarrée');
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
 * Écrit un fichier JS temporaire sur disque + son .map
 * pour que v8-to-istanbul puisse les lire (il a besoin de vrais fichiers).
 * Retourne le chemin du fichier JS temporaire.
 */
async function writeTempBundle(tmpDir, bundleName, js, map) {
  const jsPath  = path.join(tmpDir, bundleName);
  const mapPath = jsPath + '.map';

  // S'assurer que le JS pointe vers le bon .map (nom simple, pas d'URL)
  const jsWithMap = js.replace(
    /\/\/# sourceMappingURL=.*/,
    `//# sourceMappingURL=${bundleName}.map`
  );

  fs.writeFileSync(jsPath,  jsWithMap);
  fs.writeFileSync(mapPath, JSON.stringify(map));
  return jsPath;
}

/**
 * Construit une entrée Istanbul à 0% pour un fichier source
 * dont le contenu est dans sourcesContent du .map.
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
  // Vider le cache pour avoir les .map à jour
  clearBundleCache();

  const nycOutput = path.join(REPORT_DIR, '.nyc_output');
  const tmpDir    = path.join(REPORT_DIR, '.tmp_bundles');
  ensureDir(nycOutput);
  ensureDir(tmpDir);

  // Nettoyer les sorties précédentes
  for (const d of [nycOutput, tmpDir]) {
    fs.readdirSync(d).forEach(f => fs.unlinkSync(path.join(d, f)));
  }

  // Charger et fusionner les sessions
  const allSessions = sessionIds.map(id => {
    const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
    return { result: raw.result };
  });
  const merged = allSessions.length === 1
    ? allSessions[0].result
    : mergeProcessCovs(allSessions).result;

  // Récupérer la liste complète des sources depuis main.js.map
  const allSources = await fetchAllSourcesFromMainMap();
  log(`${allSources.length} fichiers sources référencés dans main.js.map`);

  const coveredFiles = new Set(); // clés relatives ex: "src/app/foo.component.ts"
  let fileIdx = 0;

  // Convertir chaque bundle
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

    // Écrire le bundle temporairement sur disque pour v8-to-istanbul
    const tmpJsPath = await writeTempBundle(tmpDir, bundleName, bundle.js, bundle.map);

    try {
      const converter = v8toIstanbul(tmpJsPath);
      await converter.load();
      // entry.functions = format V8 natif (Profiler.takePreciseCoverage) → fonctions OK ✅
      converter.applyCoverage(entry.functions || []);
      const data = converter.toIstanbul();

      for (const [filePath, fileData] of Object.entries(data)) {
        const norm = filePath.replace(/\\/g, '/');
        if (!norm.includes(SRC_PREFIX)) continue;

        const relKey  = norm.slice(norm.indexOf(SRC_PREFIX));
        fileData.path = relKey;
        coveredFiles.add(relKey);

        fs.writeFileSync(
          path.join(nycOutput, `bundle-${fileIdx++}.json`),
          JSON.stringify({ [relKey]: fileData }, null, 2)
        );
      }
      ok(`Converti : ${bundleName}`);
    } catch (err) {
      warn(`Conversion échouée pour ${bundleName}: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }
  }

  // Ajouter les fichiers jamais chargés à 0%
  // Le contenu vient de sourcesContent dans main.js.map
  const mainMap    = (await fetchBundle('main.js')).map;
  const srcContent = mainMap.sourcesContent || [];
  let zeroCount = 0;

  for (let i = 0; i < allSources.length; i++) {
    const rawPath = allSources[i];
    const norm    = rawPath.replace(/\\/g, '/');
    const relKey  = norm.includes(SRC_PREFIX)
      ? norm.slice(norm.indexOf(SRC_PREFIX))
      : norm;

    if (coveredFiles.has(relKey)) continue;

    const content = srcContent[i] || '';
    if (!content.trim()) continue; // fichier vide, on ignore

    fs.writeFileSync(
      path.join(nycOutput, `zero-${zeroCount++}.json`),
      JSON.stringify({ [relKey]: buildZeroEntry(content, relKey) }, null, 2)
    );
  }

  ok(`${coveredFiles.size} fichier(s) couverts, ${zeroCount} à 0%`);

  // Générer le rapport HTML
  const nycBin = path.resolve(__dirname, 'node_modules/.bin/nyc');
  execSync(
    `"${nycBin}" report --reporter=html --reporter=text-summary` +
    ` --report-dir="${REPORT_DIR}" --temp-dir="${nycOutput}"`,
    { stdio: 'pipe', cwd: __dirname }
  );

  ok(`Rapport généré → ${REPORT_DIR}/index.html`);
  return { coveredFiles: coveredFiles.size, zeroFiles: zeroCount };
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
  });
});

app.get('/api/sessions', (_req, res) => res.json(listSessions()));

app.delete('/api/sessions', (req, res) => {
  const { ids } = req.body;
  for (const id of ids) {
    const f = path.join(SESSIONS_DIR, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
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
      try {
        await page.reload({ waitUntil: 'networkidle2' });
      } catch {
        await connectCDP();
        await page.goto(APP_URL, { waitUntil: 'networkidle2' });
      }
    }

    // On vide le cache bundles pour que chaque session parte
    // avec les fichiers .js/.map effectivement servis à ce moment-là
    clearBundleCache();

    await startPreciseCoverage();
    res.json({ ok: true, startedAt: sessionStart });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/stop', async (req, res) => {
  try {
    if (!isRecording) return res.status(400).json({ error: 'Aucune session en cours' });
    const result = await stopAndCollect(req.body.label || '');
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
    res.json({ ok: true, ...result });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use('/report', express.static(REPORT_DIR));

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(CONTROLLER_PORT, '0.0.0.0', () => {
  ok(`Panel → http://localhost:${CONTROLLER_PORT}`);
  log(`App    : ${APP_URL}`);
  log(`CDP    : ${CDP_URL}  (tunnel SSH requis)`);
  log('');
  log('Avant de démarrer, ouvrez le tunnel SSH :');
  log(`  ssh -L ${CDP_PORT}:localhost:${CDP_PORT} user@machineA`);
});
