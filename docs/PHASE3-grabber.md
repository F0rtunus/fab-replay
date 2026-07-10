# Phase 3 — Envoi direct des logs depuis le grabber

Objectif : publier une partie dans le dépôt **directement depuis le userscript
Talishar**, sans télécharger un `.txt` puis l'importer à la main dans le viewer.

## Architecture retenue : « le grabber dépose le brut, le viewer parse »

```
 talishar.net                          Dépôt GitHub (Pages)                 Viewer (n'importe quel appareil)
 ───────────                           ────────────────────                 ───────────────────────────────
 grabber v1.10                         data/raw/<id>.txt      ── fetch ──►   FabSync.pull()
   logText()  ──── fetch PUT ────►     data/raw/index.json                    ├─ lit le manifeste
   (API GitHub, CORS)                                                         ├─ récupère les .txt absents
                                                                              ├─ TalisharParser.parse()
                                                                              └─ FabDB.putGame() (dédup gameId)
```

Pourquoi ce découpage :
- **Une seule source du parseur** (`talishar-parser.js`, côté viewer) → aucune
  divergence ; le grabber n'embarque pas 35 Ko de parseur.
- **Grabber léger et sûr** : l'API GitHub est compatible **CORS**, donc un simple
  `fetch` authentifié suffit — le userscript garde `@grant none` et reste en
  contexte page (la capture Redux/fibres React n'est pas touchée).
- **Passage à l'échelle** : chaque brut n'est récupéré/parsé **qu'une fois par
  appareil** (une fois en cache IndexedDB, il n'est plus refetché).

## Ce qui a été livré

### Viewer (`js/sync.js`) — testé en navigateur ✅
- `pull()` fusionne désormais **deux sources**, dédupliquées par `gameId` :
  1. `data/library.json` (entrées déjà parsées, imports viewer) ;
  2. `data/raw/index.json` → pour chaque id absent en local, fetch du
     `data/raw/<id>.txt`, `parse()`, `putGame()`.
- Vérifié : appareil vierge → brut ingéré, parsé, `raw` conservé en local,
  dashboard peuplé, **idempotent** (pas de doublon au 2ᵉ chargement).

### Grabber (`talishar-log-grabber.user.js` v1.10.0) — à tester en vrai ⚠️
- Config via bouton **⚙** (`owner`, `repo`, token, mode auto/manuel), stockée en
  `localStorage`.
- Envoi via bouton **☁ Dépôt**, raccourci **Alt+Shift+S**, ou **auto** quand les
  stats de fin de partie apparaissent (Game Summary ouvert). L'auto se
  **re-déclenche** si les stats de l'adversaire arrivent ensuite (après le swap)
  → le dépôt reçoit la version complète, sans clic (v1.10.2).
- `pushGameToRepo()` : `PUT data/raw/<id>.txt` puis met à jour
  `data/raw/index.json` (read-modify-write + retry sur `409`).

## Plan de test en conditions réelles

1. **Mettre à jour le userscript** vers la v1.10.0 (Tampermonkey/Violentmonkey).
2. Sur une page de partie Talishar, ouvrir le widget → **⚙** :
   - `owner` = ton pseudo GitHub, `repo` = `fab-replay` (ou ton instance),
   - coller un token **fine-grained** (Contents = Read and write, ce dépôt),
   - choisir **manuel** pour le premier test.
3. Jouer (ou rouvrir) une partie, puis cliquer **☁ Dépôt** (ou Alt+Shift+S).
   - Attendu : le widget affiche « Envoyé au dépôt ✔ ».
   - Vérifier sur GitHub : commits `grabber: log <id>` et `grabber: index +<id>`,
     et les fichiers `data/raw/<id>.txt` + `data/raw/index.json`.
4. Attendre le redéploiement Pages, puis ouvrir le viewer sur un **autre appareil
   sans token** : la partie doit apparaître au chargement.
5. Réactiver l'**auto** (⚙) et finir une partie : l'envoi doit partir tout seul à
   l'ouverture du Game Summary.

## Pièges possibles (et parades)

- **CORS / preflight** : si le `PUT` est bloqué par le navigateur (peu probable,
  l'API GitHub gère CORS), repli possible : passer le grabber en
  `@grant GM_xmlhttpRequest` + `@connect api.github.com` et router les appels via
  `GM_xmlhttpRequest` (contourne CORS). À ne faire que si nécessaire — ça remet le
  script en bac à sable.
- **Mauvaise branche** : `data/raw/…` doit être écrit sur la branche servie par
  Pages. Le grabber lit `default_branch` du dépôt ; forcer via la clé
  `tlg_sync_branch` (localStorage) si besoin.
- **Token en lecture seule** : le `PUT` renvoie 404/403 → régénérer un token avec
  **Contents = Read and write**.
- **Sécurité du token** : stocké dans le `localStorage` de talishar.net. Garder un
  token **limité à ce seul dépôt public**.

## Idée d'amélioration (plus tard)

Promouvoir automatiquement les bruts parsés vers `data/library.json` (quand le
viewer détient un token) pour que les lecteurs sans token les reçoivent déjà
parsés et alléger `data/raw/`. Non nécessaire au fonctionnement actuel.
