# Coverage Controller

Serveur de contrôle de couverture de code pour campagnes de tests manuels.
**Tourne sur la machine du testeur** et pilote Chromium sur la machine cible
via CDP réseau direct.

---

## Architecture

```
Machine CIBLE                          Machine TESTEUR
──────────────────────────────         ──────────────────────────
Quarkus :8080  (l'app)                 node controller.mjs
Chromium :9222 (CDP exposé réseau) ←── puppeteer-core (CDP)
                                       │
                                       └── http://localhost:9223
                                            (panel de contrôle)
```

---

## Installation (machine testeur)

```bash
npm install
```

---

## Prérequis sur la machine cible

Lancer Chromium **une seule fois** avec le debug réseau activé :

```bash
# Linux
chromium --remote-debugging-port=9222 \
         --remote-debugging-address=0.0.0.0 \
         --no-sandbox \
         http://localhost:8080

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --remote-debugging-address=0.0.0.0 ^
  --no-sandbox ^
  http://localhost:8080
```

> ⚠️ `--remote-debugging-address=0.0.0.0` expose le CDP sur le réseau.
> À utiliser uniquement sur un réseau de test isolé.

---

## Lancement (machine testeur)

```bash
# IP de la machine cible
node controller.mjs --target 192.168.1.42

# Avec tous les paramètres
node controller.mjs \
  --target   192.168.1.42 \
  --cdp-port 9222 \
  --app-port 8080 \
  --dist     ./dist/app-angular/browser \
  --src      ./src \
  --port     9223
```

### Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `--target` | `localhost` | IP/hostname de la machine cible |
| `--cdp-port` | `9222` | Port CDP sur la cible |
| `--app-port` | `8080` | Port de l'app sur la cible |
| `--port` | `9223` | Port du panel de contrôle (local) |
| `--dist` | `./dist/app-angular/browser` | Dossier build Angular (avec .js.map) |
| `--src` | `./src` | Sources TypeScript |
| `--sessions` | `./coverage-sessions` | Stockage des sessions |
| `--report` | `./coverage-report` | Sortie des rapports HTML |

---

## Workflow testeur

1. **Ouvrir** `http://localhost:9223` sur la machine testeur
2. **Vérifier** que le voyant CDP est vert (cible accessible)
3. **Saisir** un libellé de session (ex: "Scénario 05 - Validation commande")
4. **Cliquer "Démarrer"** → Chromium sur la cible se recharge sur l'app, la collecte démarre
5. **Effectuer** les actions du plan de test (sur la machine cible)
6. **Cliquer "Arrêter"** → la session est sauvegardée localement
7. **Sélectionner** une ou plusieurs sessions dans la liste
8. **Cliquer "Générer le rapport"** → rapport HTML disponible via le lien

---

## Pourquoi les fonctions sont correctement couvertes

`Profiler.startPreciseCoverage({ callCount: true, detailed: true })` collecte
les données au niveau V8 natif, avec granularité par fonction. Contrairement à
l'export manuel de l'onglet Coverage de Chrome DevTools qui ne produit que des
plages de bytes sans information de fonctions.
