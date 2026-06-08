# Coverage Controller

Tourne sur la **machine B** (Windows 11 / WSL).
Pilote Chromium sur la **machine A** via tunnel SSH.
Les `.js.map` sont téléchargés depuis Quarkus — ils contiennent
`sourcesContent` donc **pas besoin de copier les sources**.

---

## Architecture

```
Machine A (Linux)                    Machine B (WSL)
─────────────────────────────        ──────────────────────────────
Quarkus :8080                        node controller.mjs
  ├── main.js                            │
  └── main.js.map (sourcesContent)  ←── fetch HTTP
Chromium CDP :9222 (localhost)  ←─── ssh -L 9222:localhost:9222
                                     panel web :9223
```

---

## Prérequis

- Node.js ≥ 18 dans WSL
- Accès SSH à la machine A
- Build Angular avec `sourceMap: true` et `optimization: false`

---

## Installation

```bash
npm install
```

---

## Workflow

### 1. Ouvrir le tunnel SSH (machine B, WSL)

```bash
ssh -L 9222:localhost:9222 user@machineA
# Laisser ce terminal ouvert pendant toute la campagne
```

### 2. Lancer le controller (machine B, WSL)

```bash
node controller.mjs --target machineA:8080
```

### 3. Ouvrir le panel

```
http://localhost:9223
```

### 4. Pour chaque session de test

1. Saisir un libellé (ex: "Scénario 03 - Validation commande")
2. Cliquer **Démarrer** → Chromium recharge l'app, collecte démarre
3. Effectuer les actions du plan de test sur machine A
4. Cliquer **Arrêter** → session sauvegardée

### 5. Générer le rapport

1. Sélectionner une ou plusieurs sessions
2. Cliquer **Générer le rapport HTML**
3. Ouvrir via le lien → rapport servi sur `/report`

---

## Options

| Option | Défaut | Description |
|--------|--------|-------------|
| `--port` | `9223` | Port du panel de contrôle |
| `--target` | `localhost:8080` | Host:port de l'app Quarkus |
| `--cdp-port` | `9222` | Port CDP (bout local du tunnel SSH) |
| `--sessions` | `./coverage-sessions` | Stockage des sessions |
| `--report` | `./coverage-report` | Sortie rapport HTML |
| `--src-prefix` | `src/` | Préfixe pour filtrer les sources |

---

## Dépannage

### "CDP non accessible"
→ Le tunnel SSH n'est pas ouvert ou est tombé.
```bash
ssh -L 9222:localhost:9222 user@machineA
```

### "Impossible de télécharger main.js.map"
→ Vérifier que le build Angular a `sourceMap: true`
→ Vérifier que Quarkus sert bien les `.map` (pas de filtre sur les extensions)

### Colonne Functions à 0/0
→ Vérifier que `optimization: false` dans la config Angular de coverage —
esbuild avec optimisation peut fusionner des fonctions et casser le mapping.
