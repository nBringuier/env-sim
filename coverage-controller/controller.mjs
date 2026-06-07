#!/usr/bin/env node
/**
 * coverage-controller.mjs
 *
 * Serveur de contrôle de couverture de code pour tests manuels.
 * À lancer sur la machine cible (où tourne l'app Angular/Quarkus).
 *
 * Usage:
 *   node controller.mjs [options]
 *
 * Options:
 *   --port        Port du serveur de contrôle         (défaut: 9223)
 *   --app-url     URL de l'application à tester       (défaut: http://localhost:8080)
 *   --chromium    Chemin vers l'exécutable Chromium    (défaut: détection automatique)
 *   --dist        Dossier de build Angular             (défaut: ./dist/app-angular/browser)
 *   --src         Dossier source TypeScript            (défaut: ./src)
 *   --sessions    Dossier de stockage des sessions     (défaut: ./coverage-sessions)
 *   --report      Dossier de sortie des rapports       (défaut: ./coverage-report)
 */

import express    from 'express';
import { WebSocketServer } from 'ws';
import http       from 'node:http';
import fs         from 'node:fs';
import path       from 'node:path';
import { spawn, execSync }  from 'node:child_process';
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

const CONTROLLER_PORT = parseInt(getArg('--port',     '9223'));
const APP_URL         = getArg('--app-url',  'http://localhost:8080');
const DIST_DIR        = path.resolve(getArg('--dist',    './dist/app-angular/browser'));
const SRC_DIR         = path.resolve(getArg('--src',     './src'));
const SESSIONS_DIR    = path.resolve(getArg('--sessions','./coverage-sessions'));
const REPORT_DIR      = path.resolve(getArg('--report',  './coverage-report'));
const CDP_PORT        = 9222;

// ─── Chromium detection ───────────────────────────────────────────────────────

function findChromium() {
  if (args.includes('--chromium')) return getArg('--chromium', '');
  const candidates = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    // Linux
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

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
      const stat = fs.statSync(fullPath);
      let meta = {};
      try {
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        meta = raw._meta || {};
      } catch {}
      return {
        id:       path.basename(f, '.json'),
        filename: f,
        size:     stat.size,
        date:     stat.mtime.toISOString(),
        label:    meta.label || '',
        duration: meta.duration || 0,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ─── Dependency check ────────────────────────────────────────────────────────

log('Vérification des dépendances…');
const NEEDED = ['v8-to-istanbul', '@bcoe/v8-coverage', 'nyc'];
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

let chromiumProcess = null;
let cdpSession      = null;   // puppeteer CDPSession
let browser         = null;   // puppeteer Browser
let page            = null;   // puppeteer Page
let sessionStart    = null;
let isRecording     = false;

// ─── Chromium launch ─────────────────────────────────────────────────────────

async function launchChromium() {
  const chromiumPath = findChromium();
  if (!chromiumPath) throw new Error('Chromium introuvable. Utilisez --chromium <chemin>');

  log(`Lancement de Chromium: ${chromiumPath}`);

  // Kill any existing chromium on that debug port
  try { execSync(`pkill -f "remote-debugging-port=${CDP_PORT}"`, { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 500));

  chromiumProcess = spawn(chromiumPath, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--user-data-dir=/tmp/chromium-coverage-profile',
    APP_URL,
  ], { detached: true, stdio: 'ignore' });

  chromiumProcess.unref();

  // Wait for CDP to be ready
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (res.ok) { ok('Chromium démarré'); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Chromium n\'a pas répondu sur le port CDP');
}

async function connectCDP() {
  const puppeteer = await import('puppeteer-core');
  browser = await puppeteer.connect({
    browserURL: `http://localhost:${CDP_PORT}`,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  page = pages[0] || await browser.newPage();

  // Navigate to app if not already there
  if (!page.url().startsWith(APP_URL)) {
    await page.goto(APP_URL, { waitUntil: 'networkidle2' });
  }

  cdpSession = await page.createCDPSession();
  ok('CDP connecté');
}

async function startPreciseCoverage() {
  await cdpSession.send('Profiler.enable');
  await cdpSession.send('Profiler.startPreciseCoverage', {
    callCount:  true,
    detailed:   true,
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

  // Filter only app JS bundles
  const filtered = result.filter(e =>
    e.url && e.url.includes(APP_URL) && e.url.endsWith('.js')
  );

  const sessionData = {
    _meta: { id, label, duration, date: new Date().toISOString(), appUrl: APP_URL },
    result: filtered,
  };

  const outFile = path.join(SESSIONS_DIR, `${id}.json`);
  fs.writeFileSync(outFile, JSON.stringify(sessionData, null, 2));
  ok(`Session sauvegardée: ${id} (${filtered.length} bundles, ${duration}ms)`);
  return { id, duration, bundleCount: filtered.length };
}

// ─── Report generation ───────────────────────────────────────────────────────

function findAllTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findAllTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts'))
      results.push(full);
  }
  return results;
}

function buildZeroEntry(absPath, relKey) {
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  const statementMap = {}, s = {};
  let idx = 0;
  lines.forEach((line, lineNum) => {
    if (!line.trim()) return;
    statementMap[idx] = { start: { line: lineNum + 1, column: 0 }, end: { line: lineNum + 1, column: line.length } };
    s[idx] = 0; idx++;
  });
  return { path: relKey, statementMap, fnMap: {}, branchMap: {}, s, f: {}, b: {} };
}

async function generateReport(sessionIds, reportLabel) {
  const nycOutput = path.join(REPORT_DIR, '.nyc_output');
  ensureDir(nycOutput);

  // Clean previous nyc output
  fs.readdirSync(nycOutput).forEach(f => fs.unlinkSync(path.join(nycOutput, f)));

  // Load & merge selected sessions
  const allSessions = sessionIds.map(id => {
    const file = path.join(SESSIONS_DIR, `${id}.json`);
    const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { result: raw.result };
  });

  const merged = allSessions.length === 1
    ? allSessions[0].result
    : mergeProcessCovs(allSessions).result;

  const SRC_PREFIX = path.relative(process.cwd(), SRC_DIR).replace(/\\/g, '/') + '/';
  const coveredFiles = new Set();
  let fileIdx = 0;

  for (const entry of merged) {
    if (!entry.url || !entry.url.endsWith('.js')) continue;

    const bundleName = path.basename(new URL(entry.url).pathname);
    const bundlePath = path.join(DIST_DIR, bundleName);

    if (!fs.existsSync(bundlePath) || !fs.existsSync(bundlePath + '.map')) continue;

    try {
      // entry.functions est déjà au bon format V8 (Profiler.takePreciseCoverage)
      const converter = v8toIstanbul(bundlePath);
      await converter.load();
      converter.applyCoverage(entry.functions || []);

      const data = converter.toIstanbul();
      for (const [filePath, fileData] of Object.entries(data)) {
        const norm   = filePath.replace(/\\/g, '/');
        if (!norm.includes(SRC_PREFIX)) continue;
        const relKey = norm.slice(norm.indexOf(SRC_PREFIX));
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

  // Add zero-coverage files
  let zeroCount = 0;
  for (const absPath of findAllTsFiles(SRC_DIR)) {
    const relKey = path.relative(process.cwd(), absPath).replace(/\\/g, '/');
    if (coveredFiles.has(relKey)) continue;
    fs.writeFileSync(
      path.join(nycOutput, `zero-${zeroCount++}.json`),
      JSON.stringify({ [relKey]: buildZeroEntry(absPath, relKey) }, null, 2)
    );
  }

  // Run nyc report
  const nycBin = path.resolve(__dirname, 'node_modules/.bin/nyc');
  execSync(
    `"${nycBin}" report --reporter=html --reporter=text-summary --report-dir="${REPORT_DIR}" --temp-dir="${nycOutput}"`,
    { stdio: 'pipe', cwd: __dirname }
  );

  ok(`Rapport généré: ${REPORT_DIR}/index.html`);
  return { reportDir: REPORT_DIR, coveredFiles: coveredFiles.size, zeroFiles: zeroCount };
}

// ─── Express API ─────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Status
app.get('/api/status', (req, res) => {
  res.json({
    isRecording,
    sessionStart,
    elapsed: sessionStart ? Date.now() - sessionStart : 0,
    appUrl:  APP_URL,
    chromiumReady: !!browser,
  });
});

// Sessions list
app.get('/api/sessions', (req, res) => {
  res.json(listSessions());
});

// Delete session(s)
app.delete('/api/sessions', (req, res) => {
  const { ids } = req.body;
  for (const id of ids) {
    const f = path.join(SESSIONS_DIR, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  res.json({ deleted: ids });
});

// Start session
app.post('/api/session/start', async (req, res) => {
  try {
    if (isRecording) return res.status(400).json({ error: 'Session déjà en cours' });
    if (!browser) {
      await launchChromium();
      await connectCDP();
    } else {
      // Refresh the page and reconnect CDP
      try {
        await page.reload({ waitUntil: 'networkidle2' });
      } catch {
        await connectCDP();
        await page.goto(APP_URL, { waitUntil: 'networkidle2' });
      }
    }
    await startPreciseCoverage();
    res.json({ ok: true, startedAt: sessionStart });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stop session
app.post('/api/session/stop', async (req, res) => {
  try {
    if (!isRecording) return res.status(400).json({ error: 'Aucune session en cours' });
    const { label } = req.body;
    const result = await stopAndCollect(label || '');
    res.json({ ok: true, ...result });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate report
app.post('/api/report', async (req, res) => {
  try {
    const { sessionIds, label } = req.body;
    if (!sessionIds || !sessionIds.length)
      return res.status(400).json({ error: 'Aucune session sélectionnée' });
    const result = await generateReport(sessionIds, label);
    res.json({ ok: true, ...result });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve generated report
app.use('/report', express.static(REPORT_DIR));

// ─── WebSocket (push état temps réel) ────────────────────────────────────────

const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Push elapsed time while recording
setInterval(() => {
  if (isRecording && sessionStart) {
    broadcast({ type: 'tick', elapsed: Date.now() - sessionStart });
  }
}, 1000);

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(CONTROLLER_PORT, '0.0.0.0', () => {
  ok(`Controller démarré sur http://0.0.0.0:${CONTROLLER_PORT}`);
  log(`App cible : ${APP_URL}`);
  log(`Sessions  : ${SESSIONS_DIR}`);
  log(`Rapports  : ${REPORT_DIR}`);
  log(`Dist      : ${DIST_DIR}`);
});
