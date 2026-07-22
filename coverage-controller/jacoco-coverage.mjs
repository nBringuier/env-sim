/**
 * jacoco-coverage.mjs
 *
 * Module autonome de pilotage de la couverture backend Java via l'agent
 * JaCoCo en mode tcpserver. Conçu pour être appelé depuis controller.mjs
 * avec un minimum d'intégration : 3 fonctions publiques calquées sur le
 * cycle de vie existant (start / stop / report).
 *
 * Prérequis côté machine A (Quarkus) :
 *   java -javaagent:jacocoagent.jar=output=tcpserver,address=0.0.0.0,port=6300,append=false \
 *        -jar target/mon-app-runner.jar
 *
 * Prérequis côté machine B (ce script) :
 *   - jacococli.jar : RIEN À FAIRE — téléchargé automatiquement depuis Maven
 *     Central au premier appel et mis en cache dans .jacoco-cache/
 *     (peut être surchargé via configureJacoco({ jacocoCliJar }) si besoin d'un
 *     chemin local spécifique, ex. réseau restreint sans accès à repo1.maven.org)
 *   - un clone git du projet (pour --sourcefiles et --classfiles) fourni
 *     via --java-repo, tenu à jour par le testeur (git pull + mvn compile)
 *   - le port TCP 6300 de l'agent joignable depuis B (même tunnel SSH que CDP,
 *     ou un tunnel dédié : ssh -L 6300:localhost:6300 user@machineA)
 *
 * Convention de fichiers :
 *   coverage-sessions/<id>-backend.exec   — dump JaCoCo brut de la session
 *   coverage-report/jacoco/               — rapport HTML JaCoCo
 */

import fs           from 'node:fs';
import path         from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Téléchargement automatique de jacococli.jar ─────────────────────────────

// Version par défaut — alignée sur une release JaCoCo stable et récente.
// Peut être surchargée via configureJacoco({ jacocoCliVersion: '...' }).
const DEFAULT_JACOCO_VERSION = '0.8.13';

function jacocoCliCacheDir() {
  const dir = path.join(__dirname, '.jacoco-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jacocoCliDownloadUrl(version) {
  return `https://repo1.maven.org/maven2/org/jacoco/org.jacoco.cli/${version}/org.jacoco.cli-${version}-nodeps.jar`;
}

/**
 * Télécharge jacococli.jar depuis Maven Central s'il n'est pas déjà
 * en cache localement. Retourne le chemin du jar prêt à l'emploi.
 * Aucune configuration manuelle requise — comme les deps npm du controller.
 */
async function ensureJacocoCli(version) {
  const cacheDir = jacocoCliCacheDir();
  const jarPath  = path.join(cacheDir, `org.jacoco.cli-${version}-nodeps.jar`);

  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 0) {
    return jarPath; // déjà en cache
  }

  const url = jacocoCliDownloadUrl(version);
  log(`Téléchargement de jacococli.jar (v${version}) depuis Maven Central…`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Impossible de télécharger jacococli.jar (${res.status}) depuis ${url}. ` +
      `Vérifiez la connectivité vers repo1.maven.org, ou passez un chemin local via configureJacoco({ jacocoCliJar }).`
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(jarPath, buffer);
  ok(`jacococli.jar téléchargé et mis en cache : ${jarPath} (${(buffer.length/1024).toFixed(0)} KB)`);
  return jarPath;
}

// ─── Config (résolue une fois, passée par controller.mjs) ────────────────────

let config = null;

/**
 * À appeler une fois au démarrage du controller pour configurer le module.
 * @param {object} opts
 * @param {string} [opts.jacocoCliJar]     - chemin vers jacococli.jar (optionnel :
 *                                           téléchargé automatiquement depuis Maven
 *                                           Central si absent, comme les deps npm)
 * @param {string} [opts.jacocoCliVersion] - version JaCoCo à télécharger (défaut: 0.8.13)
 * @param {string} opts.javaRepoDir  - chemin vers le clone git du projet Java
 * @param {string} opts.jacocoHost   - host du serveur tcpserver JaCoCo (défaut: localhost)
 * @param {number} opts.jacocoPort   - port du serveur tcpserver JaCoCo (défaut: 6300)
 * @param {string} opts.sessionsDir  - dossier sessions (partagé avec le front)
 * @param {string} opts.reportDir    - dossier rapport (partagé avec le front)
 */
export function configureJacoco(opts) {
  config = {
    jacocoCliJar:     opts.jacocoCliJar || null, // résolu paresseusement si absent
    jacocoCliVersion: opts.jacocoCliVersion || DEFAULT_JACOCO_VERSION,
    javaRepoDir:      opts.javaRepoDir,
    jacocoHost:       opts.jacocoHost || 'localhost',
    jacocoPort:       opts.jacocoPort || 6300,
    sessionsDir:      opts.sessionsDir,
    reportDir:        opts.reportDir,
  };
}

function log(msg)  { console.log(`\x1b[35m[jacoco]\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m[jacoco]\x1b[0m ✔ ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[jacoco]\x1b[0m ⚠ ${msg}`); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function ensureConfigured() {
  if (!config) throw new Error('jacoco-coverage.mjs non configuré — appelez configureJacoco() au démarrage');
}

// ─── Vérification de disponibilité ───────────────────────────────────────────

/**
 * Vérifie que le serveur tcpserver JaCoCo est joignable.
 * JaCoCo n'a pas d'endpoint HTTP de "ping" — on teste juste l'ouverture
 * d'une socket TCP brute.
 */
export async function checkJacocoReachable() {
  ensureConfigured();
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.createConnection(
      { host: config.jacocoHost, port: config.jacocoPort, timeout: 2000 },
      () => { socket.end(); resolve(true); }
    );
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// ─── Cycle de vie : start / stop / report ────────────────────────────────────

/**
 * "Démarre" la collecte backend.
 * JaCoCo en mode tcpserver instrumente en continu dès le lancement de l'app —
 * il n'y a rien à "démarrer" à proprement parler. On fait donc un dump avec
 * --reset pour repartir d'un compteur à zéro au moment T0 de la session,
 * exactement comme le reload de page côté front réinitialise la collecte V8.
 */
export async function startJacocoSession() {
  ensureConfigured();

  if (!await checkJacocoReachable()) {
    throw new Error(
      `Agent JaCoCo non accessible sur ${config.jacocoHost}:${config.jacocoPort}. ` +
      `Vérifiez que l'app tourne avec -javaagent:...=output=tcpserver,port=${config.jacocoPort} ` +
      `et que le tunnel/réseau est ouvert.`
    );
  }

  // Dump + reset : on vide les compteurs actuels pour que la session
  // suivante ne compte que les nouvelles exécutions.
  const tmpDiscard = path.join(config.sessionsDir, '.jacoco-reset-discard.exec');
  await runJacocoCli(['dump',
    '--address', config.jacocoHost,
    '--port',    String(config.jacocoPort),
    '--destfile', tmpDiscard,
    '--reset',
  ]);
  fs.rmSync(tmpDiscard, { force: true });

  ok('Compteurs JaCoCo réinitialisés — session backend démarrée');
  return { ok: true };
}

/**
 * "Arrête" la collecte : dump final vers un fichier .exec nommé selon l'id
 * de session front, pour que les deux se retrouvent associés.
 * @param {string} sessionId - même id que la session front (cohérence de nommage)
 */
export async function stopJacocoSession(sessionId) {
  ensureConfigured();
  ensureDir(config.sessionsDir);

  const execFile = path.join(config.sessionsDir, `${sessionId}-backend.exec`);

  if (!await checkJacocoReachable()) {
    warn(`Agent JaCoCo non accessible — session backend non sauvegardée pour ${sessionId}`);
    return { ok: false, reason: 'unreachable' };
  }

  await runJacocoCli(['dump',
    '--address', config.jacocoHost,
    '--port',    String(config.jacocoPort),
    '--destfile', execFile,
  ]);

  const size = fs.existsSync(execFile) ? fs.statSync(execFile).size : 0;
  ok(`Session backend sauvegardée : ${execFile} (${size} octets)`);
  return { ok: true, execFile, size };
}

/**
 * Génère le rapport HTML JaCoCo pour une ou plusieurs sessions,
 * en fusionnant leurs .exec, croisé avec les sources du clone git local.
 * @param {string[]} sessionIds - mêmes ids que les sessions front sélectionnées
 */
export async function generateJacocoReport(sessionIds) {
  ensureConfigured();

  if (!config.javaRepoDir || !fs.existsSync(config.javaRepoDir)) {
    throw new Error(
      `Dossier du clone git Java introuvable : ${config.javaRepoDir}. ` +
      `Configurez --java-repo vers un clone à jour (git pull) du projet.`
    );
  }

  // Rassembler les .exec existants pour les sessions demandées
  const execFiles = sessionIds
    .map(id => path.join(config.sessionsDir, `${id}-backend.exec`))
    .filter(f => fs.existsSync(f));

  if (!execFiles.length) {
    warn('Aucun fichier .exec backend trouvé pour ces sessions — rapport backend ignoré');
    return { ok: false, reason: 'no-exec-files' };
  }

  const jacocoReportDir = path.join(config.reportDir, 'jacoco');
  ensureDir(jacocoReportDir);

  // Chercher les .class compilés dans le clone (target/classes typiquement)
  // et les sources .java (src/main/java typiquement). On reste tolérant
  // sur la structure exacte du projet en cherchant les deux emplacements usuels.
  const classfilesDir = findFirstExisting([
    path.join(config.javaRepoDir, 'target/classes'),
    path.join(config.javaRepoDir, 'build/classes/java/main'),
  ]);
  const sourcefilesDir = findFirstExisting([
    path.join(config.javaRepoDir, 'src/main/java'),
  ]);

  if (!classfilesDir) {
    throw new Error(
      `Aucun dossier de .class trouvé dans ${config.javaRepoDir} ` +
      `(cherché target/classes, build/classes/java/main). ` +
      `Le projet doit être compilé localement (mvn compile) après le git pull.`
    );
  }

  const args = ['report', ...execFiles,
    '--classfiles', classfilesDir,
    '--html',        jacocoReportDir,
    '--xml',         path.join(jacocoReportDir, 'jacoco.xml'),
  ];
  if (sourcefilesDir) args.push('--sourcefiles', sourcefilesDir);

  await runJacocoCli(args);

  ok(`Rapport JaCoCo généré → ${jacocoReportDir}/index.html`);
  return {
    ok:        true,
    reportDir: jacocoReportDir,
    execFiles: execFiles.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findFirstExisting(paths) {
  return paths.find(p => fs.existsSync(p)) || null;
}

async function runJacocoCli(args) {
  ensureConfigured();

  // Résolution paresseuse : chemin fourni explicitement, sinon téléchargement
  // automatique depuis Maven Central (mis en cache pour les appels suivants).
  if (!config.jacocoCliJar) {
    config.jacocoCliJar = await ensureJacocoCli(config.jacocoCliVersion);
  } else if (!fs.existsSync(config.jacocoCliJar)) {
    warn(`jacococli.jar fourni introuvable (${config.jacocoCliJar}) — téléchargement automatique`);
    config.jacocoCliJar = await ensureJacocoCli(config.jacocoCliVersion);
  }

  try {
    const { stdout, stderr } = await execFileAsync('java', ['-jar', config.jacocoCliJar, ...args]);
    if (stdout?.trim()) log(stdout.trim());
    if (stderr?.trim()) warn(stderr.trim());
  } catch (err) {
    throw new Error(`jacococli a échoué : ${err.message}`);
  }
}
