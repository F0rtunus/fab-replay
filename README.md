# FaB Analyzer — Chain Replay

Outil **personnel** d'analyse de parties de **Flesh and Blood** jouées sur
[talishar.net](https://talishar.net). Il rejoue une partie tour par tour et
agrège des **centaines** de parties dans un tableau de bord (winrate, matchups,
performance des cartes…).

Hébergé sur **GitHub Pages** → l'origine stable rend la persistance
**IndexedDB** fiable (y compris sur mobile), contrairement à un fichier `file://`.

---

## 🎮 Guide d'installation pas à pas (aucune compétence technique requise)

De zéro à « je joue et mes parties s'enregistrent toutes seules, consultables
partout ». Compte ~15 min la première fois. Il te faut seulement un **compte
GitHub** (gratuit) et le navigateur **Chrome**, **Edge** ou **Firefox**.

### 1) Créer un compte GitHub (si tu n'en as pas)
Va sur **https://github.com/signup** et suis les étapes (email, mot de passe,
pseudo). C'est gratuit.

### 2) Créer ta propre copie de l'appli
1. Ouvre la page du modèle : **https://github.com/ColinCamille/Fab-replay**
2. Clique le bouton vert **« Use this template »** (en haut à droite) →
   **« Create a new repository »**.
3. Donne un nom (ex. `fab-replay`), laisse **Public**, clique
   **« Create repository »**.

✅ Tu as maintenant **ta** copie, à `github.com/<ton-pseudo>/fab-replay`.

### 3) Allumer ton site (GitHub Pages)
1. Dans **ton** dépôt : onglet **Settings** (en haut) → menu de gauche **Pages**.
2. **Source** : choisis **« Deploy from a branch »**.
3. **Branch** : choisis **`main`** puis **`/ (root)`**, et clique **Save**.
4. Attends ~1 minute. Ton site est en ligne à :
   **`https://<ton-pseudo>.github.io/fab-replay/`**
5. Ouvre cette adresse et **mets-la en favori** (sur PC **et** téléphone) — c'est **ton** appli.

> À ce stade l'appli marche déjà (tu peux importer des `.txt` à la main). Les
> étapes suivantes **automatisent** l'envoi des parties depuis Talishar.

### 4) Installer l'extension de capture (Tampermonkey)
Un petit script (« grabber ») lit tes parties sur Talishar. Il lui faut d'abord
un **gestionnaire de userscripts**. Ce guide utilise **Tampermonkey** (le plus
simple), mais **Violentmonkey** ou **Greasemonkey** (Firefox) marchent aussi à
l'identique — le script est standard (`@grant none`). Prends-en **un seul** :
- **PC (Chrome / Edge / Firefox)** : installe **Tampermonkey** →
  **https://www.tampermonkey.net** (clique le bouton de ton navigateur).
- **Android** : installe l'appli **Firefox**, puis **Tampermonkey** dedans (ou le
  navigateur **Kiwi**).
- *iPhone : l'automatique n'est pas garanti ; tu peux quand même utiliser l'appli
  en important les `.txt` à la main.*

### 5) Installer le script de capture (en un clic)
1. Sur GitHub, ouvre **ton** dépôt → clique le fichier
   **`talishar-log-grabber.user.js`**.
2. Clique le bouton **« Raw »** (en haut à droite du fichier).
3. Tampermonkey ouvre une page **« Installer »** → clique **Installer**. ✅

> 🔄 **Mettre à jour plus tard** : le script ne se met **pas** à jour tout seul.
> Pour prendre une nouvelle version, refais **Raw → Installer** (Tampermonkey
> propose alors « Réinstaller/Mettre à jour »). Tu peux vérifier la version en
> cours dans le titre du widget : **« 📜 Log Grabber v1.x.x »**.

### 6) Créer ta clé d'accès (token) — pour publier tes parties
Cette clé autorise le script à écrire **dans ton dépôt, et seulement lui**.
1. Va sur **https://github.com/settings/tokens?type=beta** →
   **« Generate new token »**.
2. **Token name** : ce que tu veux (ex. `fab-replay`).
3. **Expiration** : une durée (ex. **1 an**).
4. **Repository access** : coche **« Only select repositories »** → choisis **ton
   dépôt** `fab-replay`.
5. **Permissions** → **Repository permissions** → trouve **« Contents »** → mets
   **« Read and write »**.
6. Clique **« Generate token »**, puis **copie le token tout de suite**
   (⚠️ il ne s'affiche **qu'une seule fois**).

### 7) Connecter la capture à ton dépôt
1. Ouvre une **partie sur Talishar** (n'importe laquelle). En bas à gauche
   apparaît un widget **📜 Log Grabber**.
2. Clique **⚙** et renseigne :
   - **owner** = ton pseudo GitHub,
   - **repo** = `fab-replay` (le nom de ton dépôt),
   - **token** = colle celui de l'étape 6,
   - puis choisis **« auto »** (envoi automatique en fin de partie).

### 8) Jouer et consulter
1. **Joue** normalement.
2. À la fin, **ouvre le « Game Summary »** (le récap de fin). 💡 Clique aussi le
   bouton pour voir **les stats de l'adversaire** → ça capte les deux camps.
3. Ta partie **s'envoie toute seule** dans ton dépôt.
4. Ouvre **ton site** (`https://<ton-pseudo>.github.io/fab-replay/`) sur PC ou
   téléphone → onglet **🗒 Historique** → clique une partie pour la revivre. 🎉
   Chaque partie s'ouvre sur deux vues : **⚔ Déroulé** (tour par tour) et
   **🎴 Table** (le plateau de jeu). Sur PC, **survole une carte** pour l'agrandir.

### En cas de pépin
- **« Token refusé »** → ton token a expiré : régénère-en un (étape 6) et
  recolle-le via **⚙**.
- **Une partie ne remonte pas** → tu n'as pas ouvert le **Game Summary** à la fin
  (c'est ce qui déclenche l'envoi). Tu peux forcer avec le bouton **☁ Dépôt** du widget.
- **« Partie sans id — envoi ignoré »** → tu as cliqué ☁ Dépôt sur une page sans
  numéro de partie (partie fermée, lobby). Ouvre la partie depuis
  `talishar.net/game/play/<numéro>` puis réessaie.
- **Je ne vois pas mes parties tout de suite** → attends ~1 min (le site se met à
  jour) puis recharge la page.
- **Une partie affiche un mauvais héros / de vieilles infos** → recharge la page :
  la synchro re-télécharge automatiquement une partie corrigée en amont (même
  après qu'elle a déjà été enregistrée sur l'appareil).

### Partager tes parties
Ton site est **public** : donne simplement ton adresse
`https://<ton-pseudo>.github.io/fab-replay/` à qui tu veux — **aucun compte requis
pour consulter**.

---

## Composants

| Fichier | Rôle |
|---|---|
| `index.html` | Point d'entrée : routeur **2 modes** (tableau de bord / replay). |
| `talishar-parser.js` | **Parser** — source de vérité : `.txt` → record normalisé versionné. |
| `js/images.js` | Résolution des visuels de cartes ([goagain.dev](https://api.goagain.dev)), avec cache. |
| `js/db.js` | Couche **IndexedDB** (base `fab`, store `games`, clé = `gameId`) + export/import `.json`. |
| `js/sync.js` | **Synchro GitHub** — dépôt = base : lecture de `data/library.json` sans token, écriture par token perso (auto-détection du dépôt). |
| `data/library.json` | Bibliothèque **publiée** (servie en statique par Pages) — vierge dans le dépôt modèle. |
| `data/raw/` | Logs **bruts** déposés par le grabber (`<id>.txt` + `index.json`) — ingérés/parsés par le viewer (Phase 3). |
| `data/deleted.json` | Liste **partagée** des `gameId` supprimés — évite qu'une partie effacée sur un appareil ne réapparaisse ailleurs à la synchro. |
| `js/replay.js` | **Replay** d'une partie (onglet **Déroulé**, extrait du standalone, comportement identique). |
| `js/boardreplay.js` | Vue **Table** (« tapis miroir ») : rejoue le combat sur un plateau, tour par tour. |
| `js/dashboard.js` | **Agrégations** multi-parties + rendu (cœur pur testable en Node). |
| `css/style.css` | Styles (mobile-first). |
| `talishar-log-grabber.user.js` | **Grabber** (userscript Tampermonkey/Violentmonkey) — installe la partie dans le dépôt. |
| `build/standalone.html` | Version fichier-unique régénérée (usage hors-ligne). |

## Utilisation

1. **Capturer** : installer le userscript `talishar-log-grabber.user.js`, jouer,
   puis (auto en fin de partie, ou export `.txt` via Alt+Shift+D) — ouvrir le Game
   Summary pour capter les stats officielles.
2. **Importer** : ouvrir le site, déposer **un ou plusieurs** `.txt`.
   - 1 fichier → ouvre directement le **replay**.
   - N fichiers → alimente le **tableau de bord**.
3. Les parties sont **mémorisées** entre les sessions (IndexedDB) ; ré-importer
   la même partie ne crée pas de doublon (upsert par `gameId`).
4. **Sauvegarder / transférer** (hors-ligne) : le stockage IndexedDB est **local
   à un appareil**. **Exporter la bibliothèque** (`.json`) puis **Importer une
   sauvegarde** sur un autre appareil. L'import **fusionne** (dédup `gameId`).

## Synchro automatique entre appareils (GitHub comme base)

Le dépôt sert de base de données — **aucun service tiers**, données **publiques**.

- **Lecture** : `data/library.json` est servi en statique par Pages → chargé
  au démarrage **sans token**. Tes parties publiées apparaissent sur tous tes
  appareils, et se partagent par simple **URL**.
- **Écriture** : à l'import d'un log, la partie est poussée dans le dépôt via
  l'API GitHub avec **ton token** (bouton *☁ Connecter la synchro*, collé une
  fois par appareil ; stocké en local, **jamais commité**). Après l'import, Pages
  se redéploie (quelques dizaines de secondes) et les autres appareils voient la
  partie au prochain chargement.

> Le token donne un accès **en écriture** à ton dépôt : ne le partage jamais.
> Recommandé : un token **fine-grained** limité à ce seul dépôt, permission
> **Contents = Read and write**.

### Envoi direct depuis le grabber (Phase 3)

Le userscript peut publier la partie **sans passer par l'import manuel** :
- **⚙** (widget) → configurer le dépôt (`owner`, `repo`) + coller le token
  (fine-grained, **Contents = Read and write**), et choisir l'envoi manuel ou auto.
- **☁ Dépôt** / **Alt+Shift+S** → envoi manuel ; ou **auto** à l'ouverture du
  Game Summary de fin de partie.
- Le `.txt` brut est déposé dans `data/raw/<id>.txt` (+ `data/raw/index.json`).
  Le viewer l'ingère et le parse au chargement (le parseur reste **la seule
  source de vérité**, côté viewer). L'API GitHub est appelée en **CORS** (`fetch`),
  donc le userscript garde `@grant none`.

> Le token est stocké dans le `localStorage` de talishar.net : utilise un token
> **fine-grained limité à ce seul dépôt** (Contents R/W). Sa fuite éventuelle ne
> permettrait d'écrire que dans ce dépôt public, rien d'autre.

### Partager l'app à d'autres joueurs — modèle « 2 dépôts »

Ce dépôt est un **dépôt modèle** (Template repository) **vierge de parties**.
Chaque joueur crée sa **propre instance indépendante** (ses données, son URL) :

1. **Use this template** → dépôt neuf sous son compte (zéro partie).
2. **Settings → Pages** : activer Pages (choisir la branche par défaut).
3. Ouvrir son site → **☁ Connecter la synchro** → coller son token.
4. Importer ses logs → **son URL** (`https://<son-pseudo>.github.io/<repo>/`),
   qu'il peut partager. L'app **auto-détecte** son dépôt : rien à configurer.

## Développement

```bash
npm test      # tests parser + agrégation dashboard + clé DB (sans dépendance)
npm run check # node --check sur tous les modules JS
npm run build # régénère build/standalone.html
```

> **Convention** : la logique du parseur vit dans `talishar-parser.js` (chargé
> par `index.html`). Le standalone est **régénéré** par le build — ne pas
> l'éditer à la main.

## Feuille de route

- **Phase 1** (fait) : hébergement Pages, refactor dé-inliné, import multi + persistance, tableau de bord.
- **Phase 2** (fait) : synchro auto entre appareils via le dépôt GitHub (lecture sans token, écriture par token), export/import `.json`, modèle « 2 dépôts » pour le partage.
- **Phase 3** (fait, validé en conditions réelles) : envoi direct de la partie dans le dépôt depuis le grabber (bouton `☁ Dépôt` / `Alt+Shift+S`, ou auto en fin de partie, avec re-envoi après le swap pour les stats adverses). Le `.txt` brut est déposé dans `data/raw/`, le viewer l'ingère et le parse au chargement. Voir `docs/PHASE3-grabber.md`.
- **Phase 4** (fait) : vue **Table** (« tapis miroir ») rejouant le combat sur un plateau (mains, arsenal, cimetière, banni, pitch, permanents/tokens des 2 camps, activations) ; capture des terrains/héros fiabilisée côté grabber (héros issus des stats officielles) ; synchro qui **met à jour** une partie déjà en cache quand elle est corrigée en amont.

---
Données non affiliées à Legend Story Studios. Images via goagain.dev.
