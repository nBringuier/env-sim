#!/usr/bin/env node
/**
 * coverage-controller.mjs
 *
 * Tourne sur la machine du TESTEUR.
 * Se connecte au Chromium de la machine CIBLE via CDP réseau direct
 * (Chromium lancé avec --remote-debugging-address=0.0.0.0).
 *
 * Usage:
 *   node controller.mjs [options]
 *
 * Options:
 *   --port        Port du serveur de contrôle         (défaut: 9223)
 *   --target      IP/hostname de la machine cible     (défaut: localhost)
 *   --cdp-port    Port CDP sur la machine cible        (défaut: 9222)
 *   --app-port    Port de l'app sur la machine cible   (défaut: 8080)
 *   --dist        Dossier de build Angular avec .map   (défaut: ./dist/app-angular/browser)
 *   --src         Dossier source TypeScript            (défaut: ./src)
 *   --sessions    Dossier de stockage des sessions     (défaut: ./coverage-sessions)
 *   --report      Dossier de sortie des rapports       (défaut: ./coverage-report)
 *
 * Exemple:
 *   node controller.mjs --target 192.168.1.42
 *
 * Prérequis sur la machine cible :
 *   chromium --remote-debugging-port=9222 \
 *            --remote-debugging-address=0.0.0.0 \
 *            --no-sandbox \
 *            http://localhost:8080
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

const CONTROLLER_PORT = parseInt(getArg('--port',      '9223'));
const TARGET_HOST     = getArg('--target',   'localhost');
const CDP_PORT        = parseInt(getArg('--cdp-port',  '9222'));
const APP_PORT        = parseInt(getArg('--app-port',  '8080'));
const DIST_DIR        = path.resolve(getArg('--dist',    './dist/app-angular/browser'));
const SRC_DIR         = path.resolve(getArg('--src',     './src'));
const SESSIONS_DIR    = path.resolve(getArg('--sessions','./coverage-sessions'));
const REPORT_DIR      = path.resolve(getArg('--report',  './coverage-report'));

// URL de l'app telle qu'elle est vue depuis la machine cible elle-même
// (Chromium tourne sur la cible, donc localhost:8080 est correct pour lui)
const APP_URL_LOCAL  = `http://localhost:${APP_PORT}`;

// URL CDP : depuis la machine testeur, on pointe vers la cible
const CDP_URL        = `http://${TARGET_HOST}:${CDP_PORT}`;

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
        filename: f,
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

// ─── State ────────────────────────────────────────────────────────────────────

let browser      = null;
let page         = null;
let cdpSession   = null;
let sessionStart = null;
let isRecording  = false;

// ─── CDP connection ───────────────────────────────────────────────────────────

async function checkCdpReachable() {
  // Vérifie que Chromium sur la cible est bien accessible
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function connectCDP() {
  const puppeteer = await import('puppeteer-core');

  browser = await puppeteer.connect({
    browserURL:      CDP_URL,   // ← pointe directement vers la machine cible
    defaultViewport: null,
  });

  const pages = await browser.pages();
  page = pages[0] || await browser.newPage();

  // Si la page n'est pas sur l'app, on y navigue
  // (localhost ici = localhost VU PAR CHROMIUM, donc la machine cible)
  if (!page.url().startsWith(APP_URL_LOCAL)) {
    await page.goto(APP_URL_LOCAL, { waitUntil: 'networkidle2' });
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
  ok('Collecte précise démarrée (fonctions incluses)');
}

async function stopAndCollect(label) {
  const { result } = await cdpSession.send('Profiler.takePreciseCoverage');
  await cdpSession.send('Profiler.stopPreciseCoverage');
  await cdpSession.send('Profiler.disable');
  isRecording = false;

  const duration = Date.now() - sessionStart;
  const id       = sessionId();

  // On garde uniquement les bundles de l'app (filtre sur l'URL)
  const appOrigin = `http://localhost:${APP_PORT}`;
  const filtered  = result.filter(e =>
    e.url && e.url.startsWith(appOrigin) && e.url.endsWith('.js')
  );

  const sessionData = {
    _meta:  { id, label, duration, date: new Date().toISOString(), target: TARGET_HOST },
    result: filtered,
  };

  const outFile = path.join(SESSIONS_DIR, `${id}.json`);
  fs.writeFileSync(outFile, JSON.stringify(sessionData, null, 2));
  ok(`Session sauvegardée : ${id}  (${filtered.length} bundle(s), ${(duration/1000).toFixed(0)}s)`);
  return { id, duration, bundleCount: filtered.length };
}

// ─── Report generation ───────────────────────────────────────────────────────

function findAllTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllTsFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

function buildZeroEntry(absPath, relKey) {
  const lines        = fs.readFileSync(absPath, 'utf8').split('\n');
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
  const nycOutput = path.join(REPORT_DIR, '.nyc_output');
  ensureDir(nycOutput);
  fs.readdirSync(nycOutput).forEach(f => fs.unlinkSync(path.join(nycOutput, f)));

  const allSessions = sessionIds.map(id => {
    const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
    return { result: raw.result };
  });

  const merged = allSessions.length === 1
    ? allSessions[0].result
    : mergeProcessCovs(allSessions).result;

  const SRC_PREFIX   = path.relative(process.cwd(), SRC_DIR).replace(/\\/g, '/') + '/';
  const coveredFiles = new Set();
  let fileIdx = 0;

  for (const entry of merged) {
    if (!entry.url?.endsWith('.js')) continue;

    const bundleName = path.basename(new URL(entry.url).pathname);
    const bundlePath = path.join(DIST_DIR, bundleName);
    if (!fs.existsSync(bundlePath) || !fs.existsSync(bundlePath + '.map')) {
      warn(`Bundle ou .map absent, ignoré : ${bundleName}`);
      continue;
    }

    try {
      const converter = v8toIstanbul(bundlePath);
      await converter.load();
      // entry.functions est au format natif V8 → colonnes Functions correctes ✅
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
    } catch (err) {
      warn(`Conversion échouée pour ${bundleName}: ${err.message}`);
    }
  }

  // Fichiers jamais chargés → 0% sur toutes les colonnes
  let zeroCount = 0;
  for (const absPath of findAllTsFiles(SRC_DIR)) {
    const relKey = path.relative(process.cwd(), absPath).replace(/\\/g, '/');
    if (coveredFiles.has(relKey)) continue;
    fs.writeFileSync(
      path.join(nycOutput, `zero-${zeroCount++}.json`),
      JSON.stringify({ [relKey]: buildZeroEntry(absPath, relKey) }, null, 2)
    );
  }

  const nycBin = path.resolve(__dirname, 'node_modules/.bin/nyc');
  execSync(
    `"${nycBin}" report --reporter=html --reporter=text-summary --report-dir="${REPORT_DIR}" --temp-dir="${nycOutput}"`,
    { stdio: 'pipe', cwd: __dirname }
  );

  ok(`Rapport généré : ${REPORT_DIR}/index.html`);
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

// Push timer toutes les secondes
setInterval(() => {
  if (isRecording && sessionStart) {
    broadcast({ type: 'tick', elapsed: Date.now() - sessionStart });
  }
}, 1000);

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const cdpReachable = browser ? true : await checkCdpReachable();
  res.json({
    isRecording,
    elapsed:       sessionStart ? Date.now() - sessionStart : 0,
    target:        TARGET_HOST,
    cdpUrl:        CDP_URL,
    appUrl:        `http://${TARGET_HOST}:${APP_PORT}`,
    chromiumReady: !!browser,
    cdpReachable,
  });
});

app.get('/api/sessions', (_req, res) => {
  res.json(listSessions());
});

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
        error: `Chromium non accessible sur ${CDP_URL}.\n` +
               `Lancez-le sur la machine cible avec :\n` +
               `  chromium --remote-debugging-port=${CDP_PORT} --remote-debugging-address=0.0.0.0 --no-sandbox http://localhost:${APP_PORT}`
      });
    }

    if (!browser) {
      await connectCDP();
    } else {
      // Nouvelle session : on recharge la page pour repartir d'un état propre
      try {
        await page.reload({ waitUntil: 'networkidle2' });
      } catch {
        // Page perdue (ex: navigation manuelle), on reconnecte
        await connectCDP();
        await page.goto(APP_URL_LOCAL, { waitUntil: 'networkidle2' });
      }
    }

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
    if (!sessionIds?.length) return res.status(400).json({ error: 'Aucune session sélectionnée' });
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
  ok(`Controller démarré → http://0.0.0.0:${CONTROLLER_PORT}`);
  log(`Machine cible    : ${TARGET_HOST}`);
  log(`CDP cible        : ${CDP_URL}`);
  log(`App cible        : http://${TARGET_HOST}:${APP_PORT}`);
  log(`Sessions         : ${SESSIONS_DIR}`);
  log(`Rapports         : ${REPORT_DIR}`);
  log(`Dist (.map)      : ${DIST_DIR}`);
  log('');
  log('Prérequis sur la machine cible :');
  log(`  chromium --remote-debugging-port=${CDP_PORT} \\`);
  log(`           --remote-debugging-address=0.0.0.0 \\`);
  log(`           --no-sandbox \\`);
  log(`           http://localhost:${APP_PORT}`);
});
