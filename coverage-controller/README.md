# Coverage Controller

Serveur de contrôle de couverture de code pour campagnes de tests manuels.
Pilote Chromium via CDP (Chrome DevTools Protocol) avec `Profiler.startPreciseCoverage`
pour obtenir une couverture **par fonction** précise.

---

## Architecture

```
Machine cible (serveur)                  Machine testeur (navigateur)
────────────────────────────             ────────────────────────────
Quarkus :8080  (l'app)                   http://cible:9223
Chromium       (piloté via CDP)  ←────── Panel de contrôle
Node.js :9223  (ce serveur)
  ├── /api/*         (REST)
  ├── /              (panel HTML)
  └── /report        (rapport généré)
```

---

## Installation

```bash
# Sur la machine cible, à côté du projet Angular/Quarkus
npm install
```

---

## Lancement

```bash
# Cas standard (Angular dans src/, build dans dist/app-angular/browser/)
node controller.mjs

# Avec options explicites
node controller.mjs \
  --port     9223 \
  --app-url  http://localhost:8080 \
  --dist     ./dist/app-angular/browser \
  --src      ./src \
  --sessions ./coverage-sessions \
  --report   ./coverage-report
```

### Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `--port` | `9223` | Port du serveur de contrôle |
| `--app-url` | `http://localhost:8080` | URL de l'application à tester |
| `--chromium` | auto-détecté | Chemin vers Chrome/Chromium |
| `--dist` | `./dist/app-angular/browser` | Dossier de build Angular (contient les .js.map) |
| `--src` | `./src` | Dossier source TypeScript |
| `--sessions` | `./coverage-sessions` | Dossier de stockage des sessions |
| `--report` | `./coverage-report` | Dossier de sortie des rapports HTML |

---

## Workflow testeur

1. **Ouvrir** `http://<machine-cible>:9223` depuis la machine de test

2. **Saisir un libellé** pour la session (ex: "Scénario 03 - Création commande")

3. **Cliquer "Démarrer"**
   → Chromium s'ouvre sur la machine cible sur `http://localhost:8080`
   → La collecte de couverture précise démarre (fonctions incluses)

4. **Effectuer les actions** du plan de test (sur la machine cible ou via partage d'écran)

5. **Cliquer "Arrêter"**
   → La session est sauvegardée dans `coverage-sessions/`

6. **Sélectionner une ou plusieurs sessions** dans la liste

7. **Cliquer "Générer le rapport HTML"**
   → Le rapport est généré et accessible via le lien "Ouvrir le rapport"
   → Le rapport est aussi servi à `/report` sur ce même serveur

---

## Différence avec l'export Chrome DevTools

| | Chrome DevTools export | Coverage Controller (CDP) |
|--|------------------------|--------------------------|
| Format | `ranges: [{start, end}]` | `functions: [{name, ranges: [{count}]}]` |
| Colonne Functions | ❌ 0/0 toujours | ✅ Précis par fonction |
| Colonne Statements | ✅ | ✅ |
| Colonne Lines | ✅ | ✅ |
| Workflow testeur | Manuel (F12 + export) | Piloté depuis interface web |

---

## Prérequis

- Node.js ≥ 18
- Google Chrome ou Chromium installé sur la machine cible
- Build Angular avec source maps : `ng build --configuration coverage`
- Les fichiers `.js.map` présents dans `--dist`

---

## Dépannage

### "Chromium introuvable"
→ Passez le chemin explicitement : `--chromium "C:\Program Files\Google\Chrome\Application\chrome.exe"`

### "CDP n'a pas répondu"
→ Vérifiez qu'aucun autre Chrome n'est ouvert avec `--remote-debugging-port=9222`

### Le rapport ne montre pas les fonctions
→ Vérifiez que les `.js.map` sont bien présents dans `--dist`
→ Vérifiez que le build Angular a été fait avec `sourceMap: true`
