#!/usr/bin/env node
/**
 * controller.mjs
 *
 * Orchestrateur HTTP/WebSocket pur — aucune logique de couverture ici.
 * Tourne sur la machine B (WSL). Délègue :
 *   - la couverture front (Angular/TypeScript) à web-coverage.mjs
 *   - la couverture backend (Java/JaCoCo) à jacoco-coverage.mjs
 *   - le rapport d'exigences (CSV @requirement) à requirement-coverage.mjs
 *
 * Ce fichier ne fait que :
 *   1. Parser les options CLI et les distribuer aux modules
 *   2. Exposer l'API REST + WebSocket consommée par public/index.html
 *   3. Appeler start/stop/report des deux modules en parallèle
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

import express            from 'express';
import { WebSocketServer } from 'ws';
import http               from 'node:http';
import fs                 from 'node:fs';
import path                from 'node:path';
import { fileURLToPath }  from 'node:url';

import * as webCoverage from './web-coverage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const APP_URL = `http://${TARGET}`;
const CDP_URL = `http://localhost:${CDP_PORT}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`\x1b[36m[controller]\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m[controller]\x1b[0m ✔ ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[controller]\x1b[0m ⚠ ${msg}`); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

ensureDir(SESSIONS_DIR);
ensureDir(REPORT_DIR);

// ─── Configuration des modules ───────────────────────────────────────────────

await webCoverage.configureWebCoverage({
  appUrl:          APP_URL,
  cdpUrl:          CDP_URL,
  sessionsDir:     SESSIONS_DIR,
  reportDir:       REPORT_DIR,
  includePrefixes: INCLUDE_PREFIXES,
});

// Module JaCoCo optionnel — n'importe rien si --java-repo absent
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

// Push régulier de l'état d'enregistrement pour le timer du panel
setInterval(() => {
  const status = webCoverage.getWebStatus();
  if (status.isRecording) {
    broadcast({ type: 'tick', elapsed: status.elapsed });
  }
}, 1000);

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const webStatus = webCoverage.getWebStatus();
  res.json({
    ...webStatus,
    appUrl:        APP_URL,
    cdpUrl:        CDP_URL,
    cdpReachable:  await webCoverage.checkCdpReachable(),
    jacocoEnabled: JACOCO_ENABLED,
  });
});

app.get('/api/sessions', (_req, res) => res.json(webCoverage.listWebSessions()));

app.delete('/api/sessions', (req, res) => {
  const { ids } = req.body;
  const result = webCoverage.deleteWebSessions(ids);
  // Nettoyer aussi les .exec backend associés, s'ils existent
  for (const id of ids) {
    const execF = path.join(SESSIONS_DIR, `${id}-backend.exec`);
    if (fs.existsSync(execF)) fs.unlinkSync(execF);
  }
  res.json(result);
});

app.post('/api/session/start', async (req, res) => {
  try {
    // Démarrer la collecte backend en parallèle du front (si configuré).
    // On le fait AVANT le front pour que les deux collectes démarrent
    // au plus proche l'une de l'autre.
    if (jacocoModule) {
      try {
        await jacocoModule.startJacocoSession();
      } catch (err) {
        warn(`JaCoCo start ignoré : ${err.message}`);
      }
    }

    const result = await webCoverage.startWebSession();
    res.json({ ok: true, ...result, jacocoEnabled: JACOCO_ENABLED });
  } catch (err) {
    warn(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/stop', async (req, res) => {
  try {
    const result = await webCoverage.stopWebSession(req.body.label || '');

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

    const result = await webCoverage.generateWebReport(sessionIds);

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
