# Passation — FaB Talishar Analyzer : passage en multi-game hébergé (GitHub Pages)

> Document destiné à une instance **Claude Code** ayant accès au GitHub de l'utilisateur.
> Objectif : héberger le viewer sur GitHub Pages et ajouter un tableau de bord multi-parties
> avec persistance (des **centaines** de parties), puis un dépôt automatique depuis le grabber.
> Langue du projet : **français** (UI, commentaires, commits).

---

## 1. Contexte projet

Outil **personnel** d'analyse de parties de **Flesh and Blood** (TCG) jouées sur **talishar.net**.
Utilisateur : pseudo Talishar **Ehecalt**, joue le héros **Briar**, GitHub **ColinCamille**.
Cible principale : **mobile** (Android, Chrome/Firefox), desktop en secondaire.

Trois composants, tous déjà fonctionnels :

1. **Grabber** — userscript Tampermonkey/Violentmonkey qui tourne sur `talishar.net/game/*`.
   Capture le log complet, les instantanés de main/arsenal/vie par tour, les métadonnées
   (héros, format, noms, équipement) et les **stats officielles de fin de partie** de Talishar.
   Exporte un fichier `.txt`. Version actuelle **1.9.3**.
2. **Parser** — `talishar-parser.js`, module JS (utilisable en `require()` Node **et** inliné dans le viewer).
   Transforme le `.txt` en un enregistrement normalisé et versionné (voir §7).
3. **Viewer** — `fab-replay-viewer-standalone.html`, page autonome (parser inliné) qui affiche
   le replay tour par tour + les stats officielles + 3 visualisations.

État actuel : replay mono-partie **complet et testé**. Nombreux bugs d'attribution de cartes
déjà résolus (voir §6 — **ne pas réimplémenter**).

---

## 2. Fichiers de départ à mettre dans le repo

L'utilisateur fournira ces 3 fichiers (issus de la session précédente) :

| Fichier | Rôle |
|---|---|
| `fab-replay-viewer-standalone.html` | LE viewer (parser inliné). C'est ce que l'utilisateur ouvre. |
| `talishar-parser.js` | Le parser, **source de vérité**. |
| `talishar-log-grabber.user.js` | Le grabber (userscript), v1.9.3. |

**Convention critique** : le parser existe en **double** — la source `talishar-parser.js`
ET une copie **inlinée** dans le HTML du viewer. Toute modif de logique parser doit être
appliquée **aux deux**. (Historiquement un viewer « modulaire » servait à régénérer le
standalone, mais il a été supprimé ; on édite donc le standalone directement.)

Recommandation pour le repo : **dé-inliner** le parser — le viewer charge
`talishar-parser.js` via `<script>` en local (même origine sur Pages, donc plus de souci
CSP/fetch). Ça supprime la double-maintenance. Garder une étape de build optionnelle qui
régénère un standalone si besoin d'une version fichier-unique hors-ligne.

---

## 3. Objectif de la migration

1. **Héberger le viewer sur GitHub Pages** → URL stable (ex. `colincamille.github.io/fab-analyzer/`).
   L'origine stable rend **IndexedDB fiable** (contrairement à un fichier `file://` sur mobile
   où le stockage est isolé/effacé et où chaque nouvelle copie repart à zéro).
2. **Un seul point d'entrée, deux modes** (fidèle au principe « un seul endroit ») :
   - **Replay** d'une partie (l'existant).
   - **Tableau de bord multi-parties** (nouveau).
3. **Persistance IndexedDB** : déposer une partie une fois → mémorisée entre sessions,
   monte à des **centaines** sans effort.
4. **Phase 2 — dépôt automatique** : le grabber pousse chaque `.txt` dans un repo GitHub
   via l'API ; le viewer se synchronise tout seul (voir §5.B).

---

## 4. Architecture cible

### 4.1 Structure de repo proposée
```
fab-analyzer/            (repo, GitHub Pages activé sur la branche main / racine)
├── index.html           viewer : routeur + 2 modes (replay / dashboard)
├── talishar-parser.js   parser (source unique, chargé par index.html)
├── js/
│   ├── db.js            couche IndexedDB (CRUD parties)
│   ├── dashboard.js     agrégations + rendu du tableau de bord
│   └── replay.js        logique replay (extraite du standalone actuel)
├── css/style.css        styles (repris du standalone)
├── games/               (phase 2) un .txt par partie, poussé par le grabber
│   └── index.json       (phase 2) manifeste : liste des gameId disponibles
├── build/standalone.html (optionnel) version fichier-unique régénérée
└── README.md
```

### 4.2 Persistance — IndexedDB
- Base `fab`, store `games`, clé primaire = `source.gameId` (unique par partie, déduplication naturelle).
- Stocker **le record parsé complet** (JSON) + le `.txt` brut (pour re-parser si le parser évolue)
  + un champ `schemaVersion`/`parserVersion` pour migration.
- Au chargement : lire tout le store → alimenter le dashboard. Import d'un `.txt` :
  parse → `put` (upsert par gameId, donc ré-importer la même partie ne crée pas de doublon).

### 4.3 Tableau de bord — agrégations à calculer (toutes dérivables du record, §7)
- **Winrate global** et nombre de parties (exclure `vsAI` par défaut, filtrable).
- **Winrate par matchup** : grouper par `players.opp.hero` → victoires/défaites, winrate, volume.
- **Winrate premier vs second joueur** : via `endStats.me.firstPlayer`.
- **Tendance dans le temps** : trier par `source.gameDate`/`capturedAt` → courbe de winrate glissant.
- **Performance des cartes agrégée** : sommer `endStats.me.cards` sur toutes les parties
  (jouée/bloquée/pitch/touché) → cartes qui sur/sous-performent.
- **Moyennes offensives** : `endStats.me.averages` et `totals` moyennés (menace, infligé, efficacité).
- Filtres : par format (`format`), par héros adverse, par période, AI inclus/exclu.
- Chaque ligne de partie doit être **cliquable → ouvre le replay** de cette partie (mode replay).

### 4.4 Un seul fichier, deux modes
- `index.html` : si aucune partie sélectionnée → dashboard (liste + stats globales).
- Clic sur une partie ou import d'un seul `.txt` → mode replay (réutiliser le rendu existant).
- Zone de dépôt acceptant **1 ou N** `.txt` (drag & drop + sélecteur), + bouton « importer ».

---

## 5. Étapes concrètes

### Phase 1 — hébergement + multi-game manuel + persistance (prioritaire)
1. Créer le repo `fab-analyzer`, y committer les 3 fichiers de départ (§2).
2. Activer **GitHub Pages** (Settings → Pages → branche `main`, racine). Vérifier l'URL.
3. Dé-inliner le parser : extraire le JS/CSS du standalone vers `talishar-parser.js`,
   `js/replay.js`, `css/style.css`, et faire charger le parser par `index.html`.
   **Vérifier la parité** : le replay doit se comporter exactement comme le standalone actuel.
4. Ajouter `js/db.js` (IndexedDB, §4.2).
5. Ajouter le mode **dashboard** (`js/dashboard.js`, §4.3) + le routeur 1/N fichiers (§4.4).
6. Tester sur mobile réel : import multi-`.txt`, persistance après fermeture/réouverture,
   clic partie → replay, filtres.

### Phase 2 — dépôt automatique depuis le grabber (ensuite)
> But : jouer une partie → elle apparaît seule dans le dashboard, sans manip de fichier.

**A. Le grabber pousse le `.txt` dans le repo (API GitHub)**
- L'utilisateur crée un **fine-grained PAT** limité au **seul** repo des logs, permission
  `Contents: Read and write`. Le token est saisi **une fois** et stocké via `GM_setValue`
  (jamais en dur dans le script committé).
- À l'export, le grabber envoie via `GM_xmlhttpRequest` :
  `PUT https://api.github.com/repos/ColinCamille/<repo-logs>/contents/games/<gameId>.txt`
  body `{ message, content: base64(txt), branch }`. (Créer/écraser le fichier.)
- Mettre à jour `games/index.json` (append `gameId`) dans le même flux, ou le régénérer côté viewer.
- Le repo des logs peut être **public** (les logs ne sont pas sensibles) : le viewer lira alors
  les fichiers via `raw.githubusercontent.com` **sans token**. Seul le grabber (écriture) a besoin du PAT.

**B. Le viewer se synchronise**
- Au chargement : lire `games/index.json` (ou lister via l'API) → comparer aux gameId déjà en IndexedDB
  → télécharger uniquement les **nouveaux** `.txt` (via raw URL) → parser → `put` en IndexedDB.
- Le dashboard lit toujours depuis IndexedDB (rapide, hors-ligne après 1re synchro).

**Sécurité / limites à respecter** : PAT à portée minimale, stocké en GM storage ; ne jamais
committer le token ; gérer le rate-limit API GitHub (largement suffisant pour un usage perso) ;
`GM_xmlhttpRequest` requiert `@connect api.github.com` dans l'en-tête du userscript.

---

## 6. Conventions & pièges (NE PAS réimplémenter — déjà résolu dans le parser)

Le parser gère déjà, avec des correctifs issus de vrais logs :
- **Résolution d'identité** robuste (dice roll → équipement → noms META validés). Ne pas
  refaire l'attribution moi/adversaire.
- **`normName`** = utilitaire central de comparaison de noms de cartes (minuscules, sans
  apostrophes, `//` neutralisé). L'utiliser partout où on compare des noms.
- **Miroirs** (même héros des deux côtés) : ne PAS filtrer la main du joueur en fonction des
  cartes adverses (ça supprimait à tort les cartes légitimes). Le grabber ne lit que TA zone.
- **Main d'ouverture** : quand tu es 2e joueur, les blocages du tour d'ouverture ne sont pas
  ajoutés à la main (ils viennent d'un état antérieur à l'instantané).
- **Arsenal d'ouverture** forcé à vide (règle FaB : l'arsenal est vide en début de partie).
- **Annulations (undo)** : une carte jouée puis re-loguée après un `undo` est dédupliquée
  (on garde la dernière occurrence) — sans jamais fusionner deux copies réellement jouées.

Autres conventions :
- **CSP-safe** : les images de cartes viennent du CDN Talishar ; garder le viewer compatible
  (pas d'inline qui casserait la CSP sur Pages).
- **Mobile-first** : ~6-8 lignes visibles, mise en page compacte, tester sur Android.
- **Tests** : harnais Node + `jsdom` (piloter `#pasteArea` + clic `#analyzeBtn`, naviguer via
  `currentTurnIndex` + `renderTurn()`). Vérifier `node --check` sur le parser après chaque modif.
- **Stats officielles** : le champ fiable du playerID est la **clé** de `endStats` (le champ
  `playerID` brut de l'API est souvent absent). `won`/`firstPlayer` se comparent à cette clé.

---

## 7. Champs du record (sortie de `parse(txt)`) utiles au multi-game

`parse(rawText)` retourne un objet avec (entre autres) :

- `source` : `{ parserVersion, parsedAt, capturedWith, capturedAt, gameId, gameUrl, gameDate }`
  → **`gameId`** = clé IndexedDB ; **`gameDate`/`capturedAt`** = axe temporel.
- `format` : ex. `"sage"` (filtre).
- `vsAI` : booléen (exclure les parties vs IA par défaut).
- `matchup` : ex. `"Briar vs Briar"` (libellé prêt à afficher).
- `players` : `{ me:{name,hero,heroId,startLife,startDeckSize,equipment{head,chest,arms,legs,weaponL,weaponR?}}, opp:{…} }`
  → **`players.opp.hero`** = clé des matchups.
- `playersList`, `myName`, `oppName`.
- `result` : `{ winner, loser, byConcession, iWon }` → **`iWon`** = winrate.
- `endStats` : `{ me, opp }` (ou `null`). Chaque côté :
  `{ won, firstPlayer, nbTurns, yourTime, totalGameTime, totals{dealt,threatened,blocked,prevented,lifeGained,lifeLost},
     averages{value,threatenedPerTurn,dealtPerTurn,threatenedPerCard,resourcesPerTurn,cardsLeftPerTurn,combatPerTurn},
     turns[{turn,threatened,dealt,taken,blocked,prevented,lifeGained,pitched,played,cardsLeft,resourcesUsed,resourcesLeft,lifeAtEnd}],
     cards[{name,played,blocked,pitched,discarded,timesHit}] }`
  → **`endStats.me.firstPlayer`** (1er/2e joueur) ; **`endStats.me.cards`** (perf cartes agrégée).
- `turns`, `lifeHistory`, `lifeSeries`, `life`, `snapshots`, `timeline{startTs,endTs,durationSec,lineTs}`,
  `cardsSeen`, `stats` (reconstruites, repli si pas de stats officielles), `warnings`.

Exports du module : `SCHEMA_VERSION`, `PARSER_VERSION`, `parse`, `classifyLine`,
`formatDuration`, `EQ_SLOTS`, `normName`.

---

## 8. Ordre recommandé pour Claude Code

1. Repo + Pages en ligne (le standalone actuel doit s'ouvrir tel quel à l'URL).
2. Refactor propre (dé-inline parser, séparer CSS/JS) **sans changer le comportement replay**.
3. IndexedDB + import multi + dashboard (Phase 1) → tester sur mobile.
4. Phase 2 (grabber → API GitHub, viewer → synchro) une fois la Phase 1 validée.

À chaque étape : petits commits, messages en français, et **préserver les correctifs du §6**.
