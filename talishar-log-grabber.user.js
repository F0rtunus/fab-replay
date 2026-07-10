// ==UserScript==
// @name         Talishar Log Grabber
// @namespace    camille.fab.tools
// @version      1.12.3
// @description  Capture le log COMPLET des parties Talishar + snapshots main/arsenal/terrain(permanents·tokens des 2 joueurs)/vie/deck à chaque tour + bloc META (héros, format, équipements, pseudos). v1.8 : lit directement le store Redux de Talishar via les fibres React (données exactes, plus de dépendance aux classes CSS), fallback DOM si indisponible. v1.10 : envoi direct de la partie dans le dépôt GitHub (Phase 3, API en CORS). v1.11 : capture des permanents/tokens en jeu (playerX.Permanents/Effects) pour les deux camps. Export texte / téléchargement + localStorage.
// @match        *://talishar.net/game/*
// @match        *://www.talishar.net/game/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.12.3';
  console.log('%c[TLG] userscript v' + VERSION + ' chargé — Alt+Shift+D = télécharger, Alt+Shift+C = copier, Alt+Shift+S = envoyer au dépôt, Alt+Shift+X = réduire',
              'color:#c9a227;font-weight:bold');

  const POLL_MS = 500;
  const LS_PREFIX = 'taliLog_';
  const LS_HAND_PREFIX = 'taliHand_';
  const LS_ARSENAL_PREFIX = 'taliArsenal_';
  const LS_FIELD_PREFIX = 'taliField_';
  const LS_GRAVE_PREFIX = 'taliGrave_';
  const LS_BANISH_PREFIX = 'taliBanish_';
  const LS_LIFE_PREFIX = 'taliLife_';
  const LS_META_PREFIX = 'taliMeta_';
  const LS_TS_PREFIX = 'taliTs_';
  const LS_ENDSTATS_PREFIX = 'taliEnd_';
  const FORCE_SELECTOR = '';

  let captured = [];
  let lastVisibleSig = '';
  let gameName = '';
  let boxLogged = false;
  let storeLogged = false;

  let handSnapshots = {};
  let arsenalSnapshots = {};
  let fieldSnapshots = {};  // clé tour -> { me: [noms], opp: [noms] } (permanents/tokens en jeu)
  let graveSnapshots = {};  // clé tour -> { me, opp } (cimetière, zone publique)
  let banishSnapshots = {}; // clé tour -> { me, opp } (banni, zone publique)
  let lifeSnapshots = {};   // clé tour -> { me, opp, myDeck, oppDeck }
  let tsBatches = [];       // [{from, to, t}] : lignes captured[from..to] vues à l'epoch t (s)
  let meta = {};
  let endStats = null;       // { myPlayerID, byPlayer: {1:{...},2:{...}} } — stats officielles Talishar
  let endStatsLogged = false;
  let lastTurnKey = null;
  let openingSnapped = false;
  let autoPushedFor = null;  // gameName déjà auto-envoyé au dépôt (évite les doublons)
  let autoPushedCount = 0;   // nb de camps de stats déjà auto-envoyés (re-envoi si ↑)

  function now() { return Math.floor(Date.now() / 1000); }

  function currentGameName() {
    const m = location.pathname.match(/\/game\/play\/(\d+)/)
           || location.pathname.match(/(\d{5,})/);
    return m ? m[1] : 'unknown';
  }

  // ============================================================
  // ACCÈS AU STORE REDUX (v1.8)
  // ------------------------------------------------------------
  // Talishar monte son app avec <Provider store={store}> (react-redux).
  // Depuis un userscript, on retrouve le store en remontant les fibres
  // React (__reactFiber$/__reactContainer$) jusqu'à l'élément Provider,
  // dont les props contiennent le store. Données exactes garanties :
  // state.game.playerOne = TOI, state.game.playerTwo = adversaire,
  // state.game.gameInfo = format, héros, turnNo, etc.
  // ============================================================
  let reduxStore = null;

  function findReduxStore() {
    if (reduxStore) return reduxStore;
    const root = document.getElementById('root') || document.body;
    if (!root) return null;
    const nodes = [root].concat(Array.from(root.querySelectorAll('*')).slice(0, 200));
    for (const node of nodes) {
      const fiberKey = Object.keys(node).find(k =>
        k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
      if (!fiberKey) continue;
      let fiber = node[fiberKey];
      let hops = 0;
      while (fiber && hops < 100) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        const st = props && props.store;
        if (st && typeof st.getState === 'function') {
          reduxStore = st;
          if (!storeLogged) { console.log('[TLG] store Redux connecté ✔'); storeLogged = true; }
          return reduxStore;
        }
        fiber = fiber.return;
        hops++;
      }
    }
    return null;
  }

  function getGameState() {
    try {
      const store = findReduxStore();
      if (!store) return null;
      const s = store.getState();
      return (s && s.game) ? s.game : null;
    } catch (e) { return null; }
  }

  function getRootState() {
    try { const store = findReduxStore(); return store ? store.getState() : null; }
    catch (e) { return null; }
  }

  // Stats de fin de partie : Talishar les récupère via l'API GetPopupAPI
  // (popupType "myStatsPopup") et RTK Query les met en cache dans le store à
  // state.api.queries. On les lit là — pas de requête réseau supplémentaire,
  // pas d'URL backend à deviner. Elles n'existent qu'une fois le Game Summary
  // ouvert en fin de partie (c'est ce qui déclenche l'appel côté Talishar).
  function captureEndGameStats() {
    const s = getRootState();
    if (!s || !s.api || !s.api.queries) return;
    const queries = s.api.queries;
    const myPlayerID = (s.game && s.game.gameInfo && s.game.gameInfo.playerID) || null;
    let found = null;
    for (const key of Object.keys(queries)) {
      const entry = queries[key];
      if (!entry || entry.endpointName !== 'getPopUpContent') continue;
      if (entry.status !== 'fulfilled' || !entry.data) continue;
      const d = entry.data;
      // reconnait le bon popup : présence de stats de partie
      const looksLikeStats = d && (d.turnResults || d.totalDamageDealt != null || d.cardResults);
      if (!looksLikeStats) continue;
      const args = entry.originalArgs || {};
      const popup = args.popupType || (/myStatsPopup/.test(key) ? 'myStatsPopup' : null);
      if (popup && popup !== 'myStatsPopup') continue;
      // identifie le joueur concerné
      let pid = args.playerID != null ? args.playerID : (d.playerID != null ? d.playerID : null);
      if (pid == null) { const m = key.match(/"playerID":(\d+)/); if (m) pid = Number(m[1]); }
      if (pid == null) pid = myPlayerID || 1;
      if (!found) found = { myPlayerID, byPlayer: {} };
      found.byPlayer[pid] = d;
    }
    if (found && Object.keys(found.byPlayer).length) {
      endStats = found;
      if (!endStatsLogged) {
        console.log('[TLG] stats de fin de partie captées ✔ (joueurs: ' + Object.keys(found.byPlayer).join(', ') + ')');
        endStatsLogged = true;
      }
      // Auto-envoi au dépôt (si activé). Se déclenche à l'apparition des stats
      // (tes stats à l'ouverture du Game Summary), puis se RE-déclenche si les
      // stats de l'adversaire arrivent ensuite (après le swap) → le dépôt reçoit
      // la version complète, sans clic. Le garde est posé AVANT l'appel async
      // pour éviter les doublons entre deux ticks.
      if (cfg(SYNC.auto) === '1' && syncConfigured()) {
        const nPlayers = Object.keys(found.byPlayer).length;
        if (autoPushedFor !== gameName || nPlayers > autoPushedCount) {
          autoPushedFor = gameName;
          autoPushedCount = nPlayers;
          console.log('[TLG] auto-envoi (' + nPlayers + ' camp(s) de stats)');
          pushGameToRepo(true);
        }
      }
    }
  }

  // L'API Talishar renvoie certains nombres en string ("20") : on coerce.
  function asNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return null;
  }

  function cardLabel(card) {
    if (!card) return null;
    if (card.cardName) return card.cardName;
    if (card.cardNumber && card.cardNumber !== 'CardBack') return card.cardNumber;
    return null;
  }
  function cardLabelWithId(card) {
    if (!card) return null;
    const name = cardLabel(card);
    if (!name) return null;
    return (card.cardName && card.cardNumber && card.cardNumber !== 'CardBack')
      ? name + ' (' + card.cardNumber + ')' : name;
  }
  // NB : pas de déduplication par nom ici — chaque entrée du tableau
  // Hand/Arsenal est une carte physique distincte. Avoir deux fois
  // "Static Shock" en main est un cas normal (deux copies de la même
  // carte), et doit ressortir comme deux entrées, pas une seule.
  function cardListNames(cards) {
    if (!Array.isArray(cards)) return [];
    const out = [];
    cards.forEach(c => { const n = cardLabel(c); if (n) out.push(n); });
    return out;
  }

  // ============================================================
  // LOG (inchangé, + timestamps sur les batches fusionnés)
  // ============================================================
  function findLogBox() {
    if (FORCE_SELECTOR) return document.querySelector(FORCE_SELECTOR);
    const all = Array.from(document.querySelectorAll('[class*="chatBox"]'));
    let candidates = all.filter(el => {
      const c = el.className || '';
      return /chatBox/i.test(c) && !/Container/i.test(c) && !/Inner/i.test(c);
    });
    if (!candidates.length) candidates = all;
    candidates.sort((a, b) => b.childElementCount - a.childElementCount);
    return candidates[0] || null;
  }

  function readVisibleLines(box) {
    return Array.from(box.children)
      .map(c => (c.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function recordTsBatch(fromIdx, toIdx) {
    if (toIdx < fromIdx) return;
    const t = now();
    const last = tsBatches[tsBatches.length - 1];
    if (last && last.t === t && last.to === fromIdx - 1) { last.to = toIdx; return; }
    tsBatches.push({ from: fromIdx, to: toIdx, t });
  }

  function merge(visible) {
    if (!visible.length) return;
    if (!captured.length) {
      captured = visible.slice();
      recordTsBatch(0, captured.length - 1);
      return;
    }
    const maxK = Math.min(captured.length, visible.length);
    for (let k = maxK; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) {
        if (captured[captured.length - k + i] !== visible[i]) { ok = false; break; }
      }
      if (ok) {
        const added = visible.slice(k);
        if (added.length) {
          const from = captured.length;
          captured = captured.concat(added);
          recordTsBatch(from, captured.length - 1);
        }
        return;
      }
    }
    const from = captured.length;
    captured = captured.concat(visible);
    recordTsBatch(from, captured.length - 1);
  }

  // ============================================================
  // PERSISTANCE
  // ============================================================
  function save() {
    try {
      localStorage.setItem(LS_PREFIX + gameName, JSON.stringify(captured));
      localStorage.setItem(LS_HAND_PREFIX + gameName, JSON.stringify(handSnapshots));
      localStorage.setItem(LS_ARSENAL_PREFIX + gameName, JSON.stringify(arsenalSnapshots));
      localStorage.setItem(LS_FIELD_PREFIX + gameName, JSON.stringify(fieldSnapshots));
      localStorage.setItem(LS_GRAVE_PREFIX + gameName, JSON.stringify(graveSnapshots));
      localStorage.setItem(LS_BANISH_PREFIX + gameName, JSON.stringify(banishSnapshots));
      localStorage.setItem(LS_LIFE_PREFIX + gameName, JSON.stringify(lifeSnapshots));
      localStorage.setItem(LS_META_PREFIX + gameName, JSON.stringify(meta));
      localStorage.setItem(LS_TS_PREFIX + gameName, JSON.stringify(tsBatches));
      if (endStats) localStorage.setItem(LS_ENDSTATS_PREFIX + gameName, JSON.stringify(endStats));
    } catch (e) {}
  }
  function loadExisting() {
    const read = (key, fallback) => {
      try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) || fallback) : fallback; }
      catch (e) { return fallback; }
    };
    captured = read(LS_PREFIX + gameName, []);
    handSnapshots = read(LS_HAND_PREFIX + gameName, {});
    arsenalSnapshots = read(LS_ARSENAL_PREFIX + gameName, {});
    fieldSnapshots = read(LS_FIELD_PREFIX + gameName, {});
    graveSnapshots = read(LS_GRAVE_PREFIX + gameName, {});
    banishSnapshots = read(LS_BANISH_PREFIX + gameName, {});
    lifeSnapshots = read(LS_LIFE_PREFIX + gameName, {});
    meta = read(LS_META_PREFIX + gameName, {});
    tsBatches = read(LS_TS_PREFIX + gameName, []);
    endStats = read(LS_ENDSTATS_PREFIX + gameName, null);
  }

  // ============================================================
  // EXTRACTION — Redux d'abord, DOM en secours (héritage v1.7)
  // ============================================================
  function slugToName(filename) {
    let s = filename.replace(/\.(webp|png|jpe?g)(\?.*)?$/i, '');
    s = s.replace(/_(red|yellow|blue)$/i, '');
    return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  // Même remarque que cardListNames : pas de dédoublonnage par nom, chaque
  // <img> correspond à une carte physique distincte dans la zone.
  function extractZoneCardsDOM(selector) {
    const imgs = Array.from(document.querySelectorAll(selector));
    const names = [];
    imgs.forEach(im => {
      const src = im.getAttribute('src') || '';
      const file = src.split('/').pop().split('?')[0];
      if (!file || /cardback/i.test(file)) return;
      names.push(slugToName(file));
    });
    return names;
  }

  function extractMyHandCards() {
    const g = getGameState();
    if (g && g.playerOne && Array.isArray(g.playerOne.Hand)) {
      const names = cardListNames(g.playerOne.Hand);
      if (names.length) return names;
    }
    // Fallback DOM (cascade v1.7)
    for (const sel of [
      '[class*="playerHand_" i] img, [class*="handRow" i] img',
      '[class*="handZone_" i][class*="isPlayer" i] img',
      '[class*="pOneHands_" i] img'
    ]) {
      const cards = extractZoneCardsDOM(sel);
      if (cards.length) return cards;
    }
    return [];
  }

  function extractMyArsenal() {
    const g = getGameState();
    if (g && g.playerOne && Array.isArray(g.playerOne.Arsenal)) {
      return cardListNames(g.playerOne.Arsenal);
    }
    return extractZoneCardsDOM('[class*="pOneArsenal_" i] img');
  }

  // Permanents / tokens en jeu (arène). Zone PUBLIQUE → on lit les DEUX joueurs.
  // Talishar range alliés / items / auras / tokens (ex. Embodiment of Lightning)
  // dans playerX.Permanents (parfois Effects). On renvoie les noms par camp.
  function permanentsOf(player) {
    const out = [];
    if (!player) return out;
    ['Permanents', 'Effects'].forEach(zone => {
      if (Array.isArray(player[zone])) player[zone].forEach(c => { const n = cardLabel(c); if (n) out.push(n); });
    });
    return out;
  }
  function extractField() {
    const g = getGameState();
    if (!g) return null;
    return { me: permanentsOf(g.playerOne), opp: permanentsOf(g.playerTwo) };
  }

  // Cimetière / banni : zones PUBLIQUES → lisibles pour les deux joueurs.
  function zoneNamesOf(player, zone) {
    return (player && Array.isArray(player[zone])) ? cardListNames(player[zone]) : [];
  }
  function extractTwoCamp(zone) {
    const g = getGameState();
    if (!g) return null;
    return { me: zoneNamesOf(g.playerOne, zone), opp: zoneNamesOf(g.playerTwo, zone) };
  }

  function extractLife() {
    const g = getGameState();
    const out = { me: null, opp: null, myDeck: null, oppDeck: null };
    if (g) {
      if (g.playerOne) {
        const h = asNum(g.playerOne.Health); if (h != null) out.me = h;
        const d = asNum(g.playerOne.DeckSize); if (d != null) out.myDeck = d;
      }
      if (g.playerTwo) {
        const h = asNum(g.playerTwo.Health); if (h != null) out.opp = h;
        const d = asNum(g.playerTwo.DeckSize); if (d != null) out.oppDeck = d;
      }
      if (out.me != null || out.opp != null) return out;
    }
    // Fallback DOM : widget central, [adversaire, toi] dans cet ordre
    const widget = document.querySelector('[class*="healthWidget" i], [class*="healthContainer" i]');
    if (widget) {
      const vals = Array.from(widget.querySelectorAll('[class*="health" i]'))
        .map(el => (el.innerText || '').trim())
        .map(t => { const m = t.match(/-?\d+/); return m ? parseInt(m[0], 10) : null; })
        .filter(v => v !== null);
      if (vals.length >= 2) { out.opp = vals[0]; out.me = vals[vals.length - 1]; }
      else if (vals.length === 1) { out.me = vals[0]; }
    }
    return out;
  }

  const EQ_FIELDS = [
    ['head', 'HeadEq'], ['chest', 'ChestEq'], ['arms', 'ArmsEq'],
    ['legs', 'LegsEq'], ['weaponL', 'WeaponLEq'], ['weaponR', 'WeaponREq']
  ];
  function extractEquipment(player) {
    const out = {};
    if (!player) return out;
    EQ_FIELDS.forEach(([key, field]) => {
      const label = cardLabelWithId(player[field]);
      if (label) out[key] = label;
    });
    return out;
  }

  // ============================================================
  // META : rempli progressivement, Redux d'abord.
  // ============================================================
  function maybeFillMeta() {
    if (!meta.captureVersion) meta.captureVersion = VERSION;
    if (!meta.capturedAt) meta.capturedAt = new Date().toISOString();
    // URL : on préfère la page de jeu à celle du lobby
    if (!meta.gameUrl || (/\/game\/play\//.test(location.pathname) && !/\/game\/play\//.test(meta.gameUrl))) {
      meta.gameUrl = location.href;
    }

    // Résolution des pseudos depuis le LOG (source la plus fiable) : le jet
    // de dé nomme explicitement l'adversaire et utilise "you" pour le joueur
    // local. Ça prime sur Redux/DOM, qui peuvent (rarement) capturer deux fois
    // le même nom. On complète aussi avec les en-têtes de tour.
    (function resolveNamesFromLog() {
      let oppFromRoll = null;
      const headerNames = [];
      for (const line of captured) {
        if (!oppFromRoll) {
          let m = line.match(/^🎲\s*(.+?) rolled \d+ and you rolled \d+/);
          if (m) oppFromRoll = m[1].trim();
          else { m = line.match(/^🎲\s*you rolled \d+ and (.+?) rolled \d+/); if (m) oppFromRoll = m[1].trim(); }
        }
        const h = line.match(/^(.+?)'s turn \d+ has begun\.$/);
        if (h && headerNames.indexOf(h[1].trim()) < 0) headerNames.push(h[1].trim());
      }
      if (oppFromRoll) {
        meta.oppName = oppFromRoll;                         // adversaire : autorité
        const other = headerNames.find(n => n !== oppFromRoll);
        if (other) meta.myName = other;                    // moi : l'autre en-tête
      }
    })();

    const g = getGameState();
    if (g) {
      const gi = g.gameInfo || {};
      if (!meta.format && gi.gameFormat) meta.format = gi.gameFormat;
      if (meta.isOpponentAI == null && typeof gi.isOpponentAI === 'boolean') meta.isOpponentAI = gi.isOpponentAI;

      if (!meta.myHero) {
        if (gi.heroName) meta.myHero = gi.heroName + (gi.yourHeroCardNumber ? ' (' + gi.yourHeroCardNumber + ')' : '');
        else if (g.playerOne && g.playerOne.Hero) meta.myHero = cardLabelWithId(g.playerOne.Hero);
      }
      if (!meta.oppHero) {
        if (gi.opponentHeroName) meta.oppHero = gi.opponentHeroName + (gi.opponentHeroCardNumber ? ' (' + gi.opponentHeroCardNumber + ')' : '');
        else if (g.playerTwo && g.playerTwo.Hero) meta.oppHero = cardLabelWithId(g.playerTwo.Hero);
      }

      // Redux ne comble que les trous, et jamais au prix de deux noms égaux.
      if (!meta.myName && g.playerOne && g.playerOne.Name && g.playerOne.Name !== meta.oppName) meta.myName = g.playerOne.Name;
      if (!meta.oppName && g.playerTwo && g.playerTwo.Name && g.playerTwo.Name !== meta.myName) meta.oppName = g.playerTwo.Name;


      if (meta.myStartLife == null || meta.oppStartLife == null
          || meta.myStartDeckSize == null || meta.oppStartDeckSize == null) {
        const l = extractLife();
        if (meta.myStartLife == null && l.me != null) meta.myStartLife = l.me;
        if (meta.oppStartLife == null && l.opp != null) meta.oppStartLife = l.opp;
        if (meta.myStartDeckSize == null && l.myDeck != null && l.myDeck > 0) meta.myStartDeckSize = l.myDeck;
        if (meta.oppStartDeckSize == null && l.oppDeck != null && l.oppDeck > 0) meta.oppStartDeckSize = l.oppDeck;
      }

      // Équipement de départ : on fige le premier relevé par slot
      // (une pièce détruite disparaît de l'état ensuite).
      meta.myEquipment = meta.myEquipment || {};
      meta.oppEquipment = meta.oppEquipment || {};
      const meEq = extractEquipment(g.playerOne), opEq = extractEquipment(g.playerTwo);
      Object.keys(meEq).forEach(k => { if (!meta.myEquipment[k]) meta.myEquipment[k] = meEq[k]; });
      Object.keys(opEq).forEach(k => { if (!meta.oppEquipment[k]) meta.oppEquipment[k] = opEq[k]; });
    }

    // Fallback DOM pour les pseudos si Redux indisponible (jamais deux égaux)
    if (!meta.myName || !meta.oppName) {
      const els = Array.from(document.querySelectorAll('[class*="playerName_" i]'));
      const texts = [];
      els.forEach(el => {
        const t = (el.innerText || '').trim().split('\n')[0].trim();
        if (t && t.length <= 40 && !texts.includes(t)) texts.push(t);
      });
      if (texts.length >= 2) {
        if (!meta.oppName && texts[0] !== meta.myName) meta.oppName = texts[0];
        if (!meta.myName && texts[1] !== meta.oppName) meta.myName = texts[1];
      }
    }
  }

  // ============================================================
  // SNAPSHOTS PAR TOUR (main + arsenal + vie/deck)
  // ============================================================
  const TURN_HEADER_RE = /^(.+?)'s turn (\d+) has begun\.$/;
  function maybeSnapshotState() {
    // Snapshot d'OUVERTURE : on garde la PLUS GRANDE main observée AVANT toute
    // action, puis on FIGE dès la 1re baisse de main (1er play/pitch/bloc) ou la
    // 1re fin de tour. Sinon, quand TU commences (pas d'en-tête « ton tour 1 »
    // avant ton tour 0), la fenêtre s'étendait jusqu'à ta re-pioche de fin de
    // tour et capturait la main du tour 1 (cartes en trop). On fige donc avant
    // la re-pioche. `openingSnapped` sert de verrou (réinitialisé au changement
    // de partie).
    if (!openingSnapped && captured.length > 0) {
      const endedTurn = captured.some(l => /Attempting to end turn/.test(l));
      const hand = extractMyHandCards();
      const prev = handSnapshots['__opening__'] || [];
      if (endedTurn) {
        openingSnapped = true;                              // fin de tour → fige (avant la re-pioche)
      } else if (hand.length > prev.length) {
        handSnapshots['__opening__'] = hand;                // la main grandit encore (rendu / pioche d'ouverture)
        arsenalSnapshots['__opening__'] = extractMyArsenal();
        lifeSnapshots['__opening__'] = extractLife();
        const f0 = extractField(); if (f0) fieldSnapshots['__opening__'] = f0;
        const gr0 = extractTwoCamp('Graveyard'); if (gr0) graveSnapshots['__opening__'] = gr0;
        const bn0 = extractTwoCamp('Banish'); if (bn0) banishSnapshots['__opening__'] = bn0;
      } else if (prev.length && hand.length < prev.length) {
        openingSnapped = true;                              // 1re baisse → main d'ouverture figée
      }
    }
    let key = null;
    for (let i = captured.length - 1; i >= 0; i--) {
      const m = captured[i].match(TURN_HEADER_RE);
      if (m) { key = m[1] + '#' + m[2]; break; }
    }
    if (key && key !== lastTurnKey) {
      lastTurnKey = key;
      const hand = extractMyHandCards(), arsenal = extractMyArsenal();
      if (hand.length) handSnapshots[key] = hand;
      arsenalSnapshots[key] = arsenal;
      const f = extractField(); if (f) fieldSnapshots[key] = f;
      const gr = extractTwoCamp('Graveyard'); if (gr) graveSnapshots[key] = gr;
      const bn = extractTwoCamp('Banish'); if (bn) banishSnapshots[key] = bn;
      lifeSnapshots[key] = extractLife();
    }
  }

  function tick() {
    try {
      ensureUI();
      const gn = currentGameName();
      if (gn !== gameName) {
        gameName = gn; lastVisibleSig = ''; lastTurnKey = null; openingSnapped = false;
        meta = {}; endStats = null; endStatsLogged = false; autoPushedFor = null; autoPushedCount = 0;
        loadExisting(); updateUI();
      }
      const box = findLogBox();
      if (box) {
        if (!boxLogged) { console.log('[TLG] panneau log détecté ✔'); boxLogged = true; }
        const visible = readVisibleLines(box);
        const sig = visible.join('\n');
        if (sig !== lastVisibleSig) {
          lastVisibleSig = sig; merge(visible); save(); updateUI();
        }
      }
      maybeFillMeta();
      maybeSnapshotState();
      captureEndGameStats();
    } catch (e) { console.error('[TLG] erreur tick (boucle continue):', e); }
  }

  // ============ UI ============
  let ui = null, counter = null, fullBox = null, miniBox = null;
  const LS_COLLAPSED = 'tlg_collapsed';
  let collapsed = false;
  try { collapsed = localStorage.getItem(LS_COLLAPSED) === '1'; } catch (e) {}

  function setCollapsed(v) {
    collapsed = v;
    try { localStorage.setItem(LS_COLLAPSED, v ? '1' : '0'); } catch (e) {}
    applyCollapsed();
  }

  function applyCollapsed() {
    if (!ui) return;
    if (fullBox) fullBox.style.display = collapsed ? 'none' : 'block';
    if (miniBox) miniBox.style.display = collapsed ? 'flex' : 'none';
    applyStyle();
  }

  function buildUI() {
    ui = document.createElement('div');
    ui.id = 'tlg-widget';

    // --- Vue réduite : petite pastille tapable ---
    miniBox = document.createElement('div');
    miniBox.id = 'tlg-mini';
    miniBox.style.cssText = 'align-items:center;gap:6px;cursor:pointer';
    miniBox.title = 'Ouvrir le Log Grabber';
    miniBox.innerHTML = '<span style="font-size:14px">📜</span>' +
      '<span id="tlg-mini-count" style="font-weight:700">0</span>';
    miniBox.onclick = () => setCollapsed(false);

    // --- Vue complète ---
    fullBox = document.createElement('div');
    fullBox.id = 'tlg-full';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700';
    title.textContent = '📜 Log Grabber v' + VERSION;
    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '–';
    collapseBtn.title = 'Réduire';
    collapseBtn.style.cssText = 'width:22px;height:22px;line-height:1;padding:0;cursor:pointer;' +
      'background:#333;border:1px solid #c9a227;border-radius:5px;color:#eee;font-weight:700;flex-shrink:0';
    collapseBtn.onclick = () => setCollapsed(true);
    header.appendChild(title);
    header.appendChild(collapseBtn);
    fullBox.appendChild(header);

    const count = document.createElement('div');
    count.id = 'tlg-count';
    count.style.cssText = 'margin-bottom:6px;opacity:.85';
    count.textContent = '0 lignes';
    fullBox.appendChild(count);

    const btnRow = document.createElement('div');
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'margin:0 4px 0 0;padding:3px 8px;cursor:pointer;' +
        'background:#c9a227;border:0;border-radius:5px;color:#111;font-weight:700';
      b.onclick = fn;
      return b;
    };
    btnRow.appendChild(mkBtn('Copier', copyLog));
    btnRow.appendChild(mkBtn('Télécharger', downloadLog));
    btnRow.appendChild(mkBtn('☁ Dépôt', () => pushGameToRepo(false)));
    btnRow.appendChild(mkBtn('⚙', configureSync));
    btnRow.appendChild(mkBtn('Effacer', clearLog));
    fullBox.appendChild(btnRow);

    ui.appendChild(miniBox);
    ui.appendChild(fullBox);
    counter = count;
    applyStyle();
    applyCollapsed();
  }

  function applyStyle() {
    if (!ui) return;
    ui.style.cssText = [
      'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483647',
      'font:12px/1.4 system-ui,sans-serif', 'color:#eee',
      'background:rgba(20,20,25,.95)', 'border:1px solid #c9a227',
      'border-radius:8px', collapsed ? 'padding:6px 10px' : 'padding:8px 10px',
      'user-select:none', 'box-shadow:0 2px 12px rgba(0,0,0,.6)',
      'pointer-events:auto', 'isolation:isolate'
    ].join(';');
  }

  function ensureUI() {
    if (!ui) buildUI();
    const root = document.documentElement || document.body;
    if (ui && ui.parentNode !== root && root) root.appendChild(ui);
    applyStyle();
    updateUI();
  }

  function updateUI() {
    const nbHands = Object.keys(handSnapshots).length;
    if (counter) {
      const src = reduxStore ? '⚡ redux' : '🔍 dom';
      const heroBit = (meta.myHero || '?') + ' vs ' + (meta.oppHero || '?');
      const fmtBit = meta.format ? ' · ' + meta.format : '';
      counter.innerHTML = captured.length + ' lignes · ' + nbHands + ' mains · ' + src + fmtBit
        + '<br><span style="opacity:.7">' + heroBit + '</span>';
    }
    // Compteur de la vue réduite : nombre de lignes capturées
    const mini = ui && ui.querySelector('#tlg-mini-count');
    if (mini) mini.textContent = captured.length;
  }

  // ============================================================
  // EXPORT — header + log brut + blocs HAND/ARSENAL (format v1.6,
  // compatibles viewer actuel) + LIFE / META / TIMESTAMPS.
  // ============================================================
  function snapshotBlockText(title, snapshots, fmt) {
    const keys = Object.keys(snapshots);
    if (!keys.length) return '';
    const lines = keys.map(k => {
      const label = k === '__opening__' ? 'OUVERTURE' : k.replace('#', ' #');
      return '[' + label + '] ' + fmt(snapshots[k]);
    });
    return '\n=== ' + title + ' ===\n' + lines.join('\n') + '\n';
  }

  // Bloc « 2 camps » (terrain / cimetière / banni) : [tour] me: … | opp: …
  function twoCampBlock(title, snaps) {
    const keys = Object.keys(snaps);
    if (!keys.length) return '';
    const fmt = v => (v && v.length) ? v.join(', ') : '(vide)';
    const lines = keys.map(k => {
      const label = k === '__opening__' ? 'OUVERTURE' : k.replace('#', ' #');
      const s = snaps[k] || {};
      return '[' + label + '] me: ' + fmt(s.me) + ' | opp: ' + fmt(s.opp);
    });
    return '\n=== ' + title + ' ===\n' + lines.join('\n') + '\n';
  }
  function fieldBlockText() { return twoCampBlock('FIELD SNAPSHOTS (permanents/tokens en jeu : toi | adversaire)', fieldSnapshots); }
  function graveBlockText() { return twoCampBlock('GRAVEYARD SNAPSHOTS (cimetière : toi | adversaire)', graveSnapshots); }
  function banishBlockText() { return twoCampBlock('BANISH SNAPSHOTS (banni : toi | adversaire)', banishSnapshots); }

  function metaBlockText() {
    const eqText = eq => {
      if (!eq) return '(non capté)';
      const parts = EQ_FIELDS.map(([k]) => eq[k] ? k + '=' + eq[k] : null).filter(Boolean);
      return parts.length ? parts.join(' | ') : '(non capté)';
    };
    const val = v => (v == null || v === '') ? '(non capté)' : v;
    const rows = [
      ['schema', 'v1'],
      ['captured_with', 'TLG v' + (meta.captureVersion || VERSION)],
      ['game_url', meta.gameUrl || location.href],
      ['captured_at', val(meta.capturedAt)],
      ['format', val(meta.format)],
      ['vs_ai', meta.isOpponentAI == null ? '(non capté)' : (meta.isOpponentAI ? 'oui' : 'non')],
      ['me', val(meta.myName)],
      ['opponent', val(meta.oppName)],
      ['my_hero', val(meta.myHero)],
      ['opp_hero', val(meta.oppHero)],
      ['my_start_life', val(meta.myStartLife)],
      ['opp_start_life', val(meta.oppStartLife)],
      ['my_start_deck_size', val(meta.myStartDeckSize)],
      ['opp_start_deck_size', val(meta.oppStartDeckSize)],
      ['my_equipment', eqText(meta.myEquipment)],
      ['opp_equipment', eqText(meta.oppEquipment)]
    ];
    return '\n=== META ===\n' + rows.map(([k, v]) => k + ': ' + v).join('\n') + '\n';
  }

  function tsBlockText() {
    if (!tsBatches.length) return '';
    const parts = tsBatches.map(b => b.from + '-' + b.to + ':' + b.t);
    return '\n=== TIMESTAMPS ===\n' + parts.join(',') + '\n';
  }

  function lifeLineFmt(v) {
    if (!v) return 'me=? opp=?';
    let s = 'me=' + (v.me != null ? v.me : '?') + ' opp=' + (v.opp != null ? v.opp : '?');
    if (v.myDeck != null || v.oppDeck != null) {
      s += ' myDeck=' + (v.myDeck != null ? v.myDeck : '?') + ' oppDeck=' + (v.oppDeck != null ? v.oppDeck : '?');
    }
    return s;
  }

  // Réconcilie les HÉROS depuis les stats officielles de fin de partie
  // (endStats), source faisant AUTORITÉ. `gameInfo.heroName` peut rester figé
  // sur une partie PRÉCÉDENTE quand la SPA Talishar ne réinitialise pas bien
  // son store entre deux parties : on a vu « Arakni » ressortir sur une partie
  // Oscilio. Les stats donnent le slot du joueur local (myPlayerID), l'id de
  // héros (yourHero/opponentHero) et un tableau character[] avec les noms
  // lisibles. On écrase donc meta.myHero (et oppHero si le nom est connu).
  function reconcileHeroesFromStats() {
    if (!endStats || !endStats.byPlayer) return;
    const bp = endStats.byPlayer;
    const mine = bp[endStats.myPlayerID] || bp[1] || bp[Object.keys(bp)[0]];
    if (!mine) return;
    const nameOfId = (stats, id) => {
      if (!id || !stats || !Array.isArray(stats.character)) return null;
      const hit = stats.character.find(c => c && c.cardId === id);
      return hit ? hit.cardName : null;
    };
    const label = (name, id) => name ? (id ? name + ' (' + id + ')' : name) : null;
    // Mon héros : id yourHero + nom lisible depuis MON character[] (1re entrée).
    const myId = mine.yourHero;
    const myName = nameOfId(mine, myId) || (mine.character && mine.character[0] && mine.character[0].cardName) || null;
    const myLabel = label(myName, myId);
    if (myLabel) meta.myHero = myLabel;
    // Héros adverse : on n'écrase QUE si on a un vrai nom lisible (le camp
    // adverse a été capté) — sinon on garde meta.oppHero déjà résolu (gi),
    // pour ne pas régresser sur un simple id brut.
    const oppId = mine.opponentHero;
    const otherPid = Object.keys(bp).find(k => String(k) !== String(endStats.myPlayerID));
    const oppName = nameOfId(otherPid ? bp[otherPid] : null, oppId)
      || (otherPid && bp[otherPid] && bp[otherPid].character && bp[otherPid].character[0] && bp[otherPid].character[0].cardName) || null;
    if (oppName) meta.oppHero = label(oppName, oppId);
  }

  // Réconcilie les PSEUDOS quand l'ancre fiable (le jet de dé « you rolled »)
  // est absente du log : dans ce cas resolveNamesFromLog n'a rien pu fixer et
  // on est retombé sur Redux, dont la perspective peut être inversée (on a vu
  // « me » = l'adversaire). La main capturée (DOM) est TOUJOURS la nôtre : le
  // joueur dont les cartes « played » figurent dans notre main est « moi ».
  function reconcileNamesFromHand() {
    if (captured.some(l => /rolled \d+/.test(l))) return;   // jet de dé présent → déjà fiable
    const headerNames = [];
    const played = {};
    for (const line of captured) {
      let m = line.match(/^(.+?)'s turn \d+ has begun\.$/);
      if (m && headerNames.indexOf(m[1].trim()) < 0) headerNames.push(m[1].trim());
      m = line.match(/^(.+?) played (.+?)(?: from arsenal)?$/);
      if (m) { const n = m[1].trim(); (played[n] = played[n] || []).push(m[2].trim().toLowerCase()); }
    }
    if (headerNames.length < 2) return;
    const myCards = new Set();
    Object.keys(handSnapshots).forEach(k => (handSnapshots[k] || []).forEach(c => myCards.add(String(c).toLowerCase())));
    if (!myCards.size) return;
    const score = n => (played[n] || []).reduce((s, c) => s + (myCards.has(c) ? 1 : 0), 0);
    const ranked = headerNames.slice().sort((a, b) => score(b) - score(a));
    const meName = ranked[0], oppName = ranked.find(n => n !== meName);
    if (meName && score(meName) > score(oppName)) {   // « moi » sans ambiguïté
      meta.myName = meName;
      if (oppName) meta.oppName = oppName;
    }
  }

  function logText() {
    reconcileHeroesFromStats();
    reconcileNamesFromHand();
    return '=== Talishar game ' + gameName + ' — ' + new Date().toLocaleString() + ' ===\n\n'
      + captured.join('\n') + '\n'
      + snapshotBlockText('HAND SNAPSHOTS (ta main, captée depuis le DOM — jamais celle de l\'adversaire)', handSnapshots,
          v => v.length ? v.join(', ') : '(vide)')
      + snapshotBlockText('ARSENAL SNAPSHOTS (ton arsenal, capté depuis le DOM — jamais celui de l\'adversaire)', arsenalSnapshots,
          v => v.length ? v.join(', ') : '(vide)')
      + fieldBlockText()
      + graveBlockText()
      + banishBlockText()
      + snapshotBlockText('LIFE SNAPSHOTS (vie et taille de deck : toi / adversaire)', lifeSnapshots, lifeLineFmt)
      + metaBlockText()
      + tsBlockText()
      + endStatsBlockText();
  }

  // Bloc JSON des stats officielles Talishar, si captées. Une seule ligne JSON
  // pour rester compatible avec le parsage par blocs (le lecteur fait un
  // JSON.parse du corps du bloc).
  function endStatsBlockText() {
    if (!endStats || !endStats.byPlayer || !Object.keys(endStats.byPlayer).length) return '';
    let json;
    try { json = JSON.stringify(endStats); } catch (e) { return ''; }
    return '\n=== END GAME STATS (Talishar, JSON) ===\n' + json + '\n';
  }
  function flash(msg) { if (counter) { counter.textContent = msg; setTimeout(updateUI, 1500); } }

  function copyLog() {
    navigator.clipboard.writeText(logText())
      .then(() => { flash('Copié ✔'); console.log('[TLG] log copié'); })
      .catch(() => flash('Copie refusée — Alt+Shift+D'));
  }
  function downloadLog() {
    const blob = new Blob([logText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const a = document.createElement('a');
    a.href = url; a.download = 'talishar_' + gameName + '_' + ts + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    flash('Téléchargé ✔');
    console.log('[TLG] log téléchargé');
  }
  function clearLog() {
    if (!confirm('Effacer le log, les snapshots et les métadonnées capturés de cette partie ?')) return;
    captured = []; lastVisibleSig = ''; handSnapshots = {}; arsenalSnapshots = {};
    fieldSnapshots = {}; graveSnapshots = {}; banishSnapshots = {}; lifeSnapshots = {}; tsBatches = []; meta = {};
    lastTurnKey = null; openingSnapped = false;
    save(); updateUI();
  }

  // ============================================================
  // SYNCHRO DÉPÔT GITHUB (Phase 3)
  // ------------------------------------------------------------
  // Dépose le .txt brut dans data/raw/<id>.txt et met à jour le
  // manifeste data/raw/index.json. Le viewer l'ingère et le parse
  // au chargement (source unique du parseur = talishar-parser.js).
  // L'API GitHub est compatible CORS → simple fetch, aucun GM_*,
  // le script reste en contexte page (capture Redux intacte).
  // Config stockée en localStorage (token limité à ce dépôt).
  // ============================================================
  const SYNC = { owner: 'tlg_sync_owner', repo: 'tlg_sync_repo', branch: 'tlg_sync_branch', token: 'tlg_sync_token', auto: 'tlg_sync_auto' };
  function cfg(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function syncConfigured() { return !!(cfg(SYNC.owner) && cfg(SYNC.repo) && cfg(SYNC.token)); }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + cfg(SYNC.token), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  function ghUrl(path) { return 'https://api.github.com/repos/' + cfg(SYNC.owner) + '/' + cfg(SYNC.repo) + path; }

  async function ghDefaultBranch() {
    if (cfg(SYNC.branch)) return cfg(SYNC.branch);
    try { const r = await fetch(ghUrl(''), { headers: ghHeaders() }); if (r.ok) { const j = await r.json(); return j.default_branch || 'main'; } } catch (e) {}
    return 'main';
  }
  // Lit {sha, json} d'un fichier du dépôt ; {sha:null} si absent (404).
  async function ghReadContents(filePath, branch) {
    const r = await fetch(ghUrl('/contents/' + filePath + '?ref=' + encodeURIComponent(branch)), { headers: ghHeaders() });
    if (r.status === 404) return { sha: null, json: null };
    if (!r.ok) throw new Error('lecture ' + filePath + ': HTTP ' + r.status);
    const j = await r.json();
    let json = null;
    try { json = JSON.parse(base64ToUtf8(j.content)); } catch (e) {}
    return { sha: j.sha || null, json: json };
  }
  async function ghPut(filePath, contentText, message, sha, branch) {
    const body = { message: message, content: utf8ToBase64(contentText), branch: branch };
    if (sha) body.sha = sha;
    return fetch(ghUrl('/contents/' + filePath), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  }

  // Envoie la partie courante dans le dépôt. silent = pas d'ouverture auto
  // de la config si non configuré (utilisé par l'auto-envoi).
  async function pushGameToRepo(silent) {
    if (!syncConfigured()) {
      if (silent) return;
      configureSync();
      if (!syncConfigured()) { alert('Synchro non configurée : owner, repo ET token sont requis (le token n’a pas été enregistré ?).'); return; }
      // Configuré à l'instant → on enchaîne directement sur l'envoi (pas besoin de recliquer).
    }
    if (!captured.length) { flash('Rien à envoyer'); if (!silent) alert('Aucune ligne de log capturée pour cette partie.'); return; }
    const id = gameName;
    // Garde-fou anti-doublon fantôme : sans numéro de partie dans l'URL
    // (page fermée/périmée, /game/ sans id → gameName === 'unknown'), on
    // refuse d'envoyer. Une telle capture crée un enregistrement « unknown »
    // aux données corrompues qui se ré-injecte à chaque synchro et ne peut
    // pas être supprimé proprement par gameId. En auto (silencieux) on ignore
    // sans bruit ; en manuel on explique.
    if (!id || !/^\d+$/.test(String(id))) {
      if (silent) return;
      flash('Partie sans id — envoi ignoré');
      alert('Impossible d’identifier la partie : aucun numéro dans l’URL Talishar.\n\nOuvre la partie depuis talishar.net/game/play/<numéro> (partie en cours), puis réessaie. Une page fermée ou le lobby ne permettent pas un envoi fiable.');
      return;
    }
    const text = logText();
    flash('Envoi au dépôt…');
    console.log('[TLG] envoi: début — partie ' + id + ', dépôt ' + cfg(SYNC.owner) + '/' + cfg(SYNC.repo));
    try {
      const branch = await ghDefaultBranch();
      console.log('[TLG] envoi: branche = ' + branch);

      // 1. Dépose (ou écrase) le .txt brut.
      const rawPath = 'data/raw/' + id + '.txt';
      const existing = await ghReadContents(rawPath, branch);
      const rawRes = await ghPut(rawPath, text, 'grabber: log ' + id, existing.sha, branch);
      if (!rawRes.ok) throw new Error('dépôt du log: HTTP ' + rawRes.status + ' ' + (await rawRes.text().catch(() => '')).slice(0, 160));
      console.log('[TLG] envoi: log brut déposé (HTTP ' + rawRes.status + ')');

      // 2. Met à jour le manifeste (read-modify-write, retry sur conflit 409).
      const idxPath = 'data/raw/index.json';
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await ghReadContents(idxPath, branch);
        const arr = Array.isArray(cur.json) ? cur.json : ((cur.json && cur.json.raw) || []);
        const rest = arr.filter(e => String((e && (e.gameId || e.id)) || e) !== String(id));
        rest.push({ gameId: id, uploadedAt: new Date().toISOString(), me: meta.myName || null, opponent: meta.oppName || null, oppHero: meta.oppHero || null, format: meta.format || null });
        const idxRes = await ghPut(idxPath, JSON.stringify(rest), 'grabber: index +' + id, cur.sha, branch);
        if (idxRes.ok) { flash('Envoyé au dépôt ✔'); console.log('[TLG] partie ' + id + ' envoyée au dépôt'); return; }
        if (idxRes.status === 409 && attempt < 2) continue;
        throw new Error('mise à jour index: HTTP ' + idxRes.status);
      }
    } catch (e) {
      console.error('[TLG] envoi dépôt échoué:', e);
      flash('Envoi échoué (voir console)');
      if (!silent) alert('Envoi au dépôt échoué : ' + e.message
        + '\n\n(Si « Failed to fetch », c’est probablement la CSP de Talishar qui bloque l’appel — dis-le-moi, je passe le grabber en GM_xmlhttpRequest.)');
    }
  }

  function configureSync() {
    const owner = prompt('Propriétaire du dépôt GitHub (ex : colincamille) :', cfg(SYNC.owner));
    if (owner == null) return;
    const repo = prompt('Nom du dépôt (ex : fab-replay) :', cfg(SYNC.repo) || 'fab-replay');
    if (repo == null) return;
    const hasTok = !!cfg(SYNC.token);
    const token = prompt('Token GitHub « fine-grained » (Contents = Read and write, limité à ce dépôt).'
      + (hasTok ? '\n(Un token est déjà enregistré — laisse vide pour le conserver.)' : ''), '');
    if (token == null) return;   // Annuler = ne rien changer
    try {
      localStorage.setItem(SYNC.owner, owner.trim());
      localStorage.setItem(SYNC.repo, repo.trim());
      if (token.trim()) localStorage.setItem(SYNC.token, token.trim());
    } catch (e) {}
    const auto = confirm('Envoyer AUTOMATIQUEMENT la partie à l’ouverture du Game Summary de fin ?\n\nOK = auto · Annuler = manuel (bouton ☁ ou Alt+Shift+S)');
    try { localStorage.setItem(SYNC.auto, auto ? '1' : '0'); } catch (e) {}
    console.log('[TLG] config synchro:', { owner: cfg(SYNC.owner), repo: cfg(SYNC.repo), tokenPresent: !!cfg(SYNC.token), auto: cfg(SYNC.auto) });
    if (!syncConfigured()) alert('Config incomplète : le token n’a pas été enregistré. Reclique ⚙ et colle bien le token.');
    flash(syncConfigured() ? 'Synchro configurée ✔' : 'Config incomplète (token ?)');
    updateUI();
  }

  // ============ Raccourcis clavier ============
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') { e.preventDefault(); downloadLog(); }
    else if (k === 'c') { e.preventDefault(); copyLog(); }
    else if (k === 's') { e.preventDefault(); pushGameToRepo(false); }
    else if (k === 'x') { e.preventDefault(); setCollapsed(!collapsed); }
  }, true);

  // ============ Démarrage ============
  gameName = currentGameName();
  loadExisting();
  ensureUI();

  try {
    const obs = new MutationObserver(() => {
      const root = document.documentElement || document.body;
      if (ui && ui.parentNode !== root) ensureUI();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { console.error('[TLG] observer KO:', e); }

  setInterval(tick, POLL_MS);
})();
