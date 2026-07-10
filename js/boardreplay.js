/* ============================================================
 * BOARD REPLAY — rejeu d'une partie sur une « table » façon Talishar,
 * avec une timeline (slider) qui déroule les actions une à une.
 *
 * API : BoardReplay.mount(container, GAME) → construit la table + la
 * timeline pour le record parsé courant. buildTimeline(GAME) reconstruit
 * l'état du plateau à chaque étape (main / pitch / arsenal / cimetière /
 * PV) à partir des événements du log.
 *
 * Deux garde-fous importants :
 *  - toutes les classes sont préfixées « br- » (le site a déjà .verdict,
 *    .card, .slot… : aucune collision possible) ;
 *  - la PROPRIÉTÉ d'une carte suit e.player (pas le joueur du tour) :
 *    une carte jouée en réaction par l'adversaire lui est bien attribuée.
 * ============================================================ */
(function (root) {
  'use strict';
  const CI = root.CardImages || {};
  const TP = root.TalisharParser || {};
  const norm = s => (TP.normName ? TP.normName(s) : String(s || '').trim().toLowerCase());
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Tokens (permanents/auras) créés par certains héros. Talishar NE journalise
  // PAS leur création (ils n'apparaissent que via leur effet, ex. « Embodiment
  // of Lightning grants go again », et l'Earth jamais) → on les rattache au
  // héros et on les montre comme présents sur la partie. Étendre au besoin.
  const HERO_TOKENS = {
    briar: ['Embodiment of Lightning', 'Embodiment of Earth'],
    oscilio: ['Embodiment of Lightning', 'Embodiment of Earth']
  };
  function tokensForHero(hero) {
    const k = norm(hero).split(/[ ,]/)[0];
    return HERO_TOKENS[k] || [];
  }

  // ---------- Images (cache local ; CardImages cache déjà côté réseau) ----------
  const _img = {};
  function resolveImg(name, hero) {
    const k = (hero ? 'H:' : '') + norm(name);
    if (_img[k] !== undefined) return Promise.resolve(_img[k]);
    const fn = hero ? (CI.resolveHeroCardImage || CI.resolveCardImage) : CI.resolveCardImage;
    if (!fn) return Promise.resolve(null);
    return fn(name).then(u => (_img[k] = u || null)).catch(() => (_img[k] = null));
  }
  function paintArt(scope) {
    scope.querySelectorAll('.br-art[data-card]').forEach(art => {
      if (art.dataset.painted) return;
      const name = art.getAttribute('data-card');
      if (!name) return;
      art.dataset.painted = '1';
      resolveImg(name, art.hasAttribute('data-hero')).then(u => {
        if (!u) return;
        art.style.backgroundImage = 'url("' + u + '")';
        art.classList.add('has-img');
        // La carte porte déjà son nom imprimé → on masque le nom en
        // surimpression (marqueur sur la tuile parente ; cf. CSS .br-imgok).
        const tile = art.closest('.br-gcard,.br-zcard,.br-pcard,.br-tok');
        if (tile) tile.classList.add('br-imgok');
      });
    });
  }

  // ============================================================
  // RECONSTRUCTION — GAME parsé → liste d'étapes { turn, actor, stage, state }
  // ============================================================
  function equipSet(pl) { const s = {}; const e = (pl && pl.equipment) || {}; Object.keys(e).forEach(k => { if (e[k] && e[k].name) s[norm(e[k].name)] = 1; }); return s; }

  function buildTimeline(GAME) {
    const MY = GAME.myName, OPP = GAME.oppName;
    const HERO = { me: (GAME.players.me && GAME.players.me.hero) || MY, opp: (GAME.players.opp && GAME.players.opp.hero) || OPP };
    const HEROTOK = { me: tokensForHero(HERO.me), opp: tokensForHero(HERO.opp) };
    const EQ = { me: equipSet(GAME.players.me), opp: equipSet(GAME.players.opp) };
    const sideOf = p => (p === MY ? 'me' : 'opp');
    const isEquip = (side, card) => !!EQ[side][norm(card)];
    const ls = GAME.lifeSeries || { me: [], opp: [] };

    const st = {
      meHandCards: [], meHandCount: 0, meFaceUp: false, oppHandCount: 4,
      mePitch: [], oppPitch: [], meArsenal: [], oppArsenalCount: 0,
      meGrave: [], oppGrave: [], meBanish: [], oppBanish: [], meTokens: [], oppTokens: [], life: { me: 0, opp: 0 }
    };
    const steps = [];
    const snap = () => ({
      meHandCards: st.meHandCards.slice(), meHandCount: st.meHandCount, meFaceUp: st.meFaceUp, oppHandCount: st.oppHandCount,
      mePitch: st.mePitch.slice(), oppPitch: st.oppPitch.slice(), meArsenal: st.meArsenal.slice(), oppArsenalCount: st.oppArsenalCount,
      meGrave: st.meGrave.slice(), oppGrave: st.oppGrave.slice(), meBanish: st.meBanish.slice(), oppBanish: st.oppBanish.slice(),
      meTokens: st.meTokens.slice(), oppTokens: st.oppTokens.slice(), life: { me: st.life.me, opp: st.life.opp }
    });
    const push = (turn, actor, stage, hit) => steps.push({ turn, actor, stage, hit: hit || null, state: snap() });
    const rm = (a, n) => { const k = a.findIndex(x => norm(x) === norm(n)); if (k >= 0) { a.splice(k, 1); return true; } return false; };
    const removeCard = (side, card) => {
      if (side === 'me') { if (st.meFaceUp) { if (!rm(st.meHandCards, card)) rm(st.meArsenal, card); } else st.meHandCount = Math.max(0, st.meHandCount - 1); }
      else st.oppHandCount = Math.max(0, st.oppHandCount - 1);
    };
    const addPitch = (side, c) => (side === 'me' ? st.mePitch : st.oppPitch).push(c);
    const toGrave = (side, c) => (side === 'me' ? st.meGrave : st.oppGrave).push(c);

    (GAME.turns || []).forEach((t, idx) => {
      const attacker = t.player;
      if (ls.me[idx] != null) st.life.me = ls.me[idx];
      if (ls.opp[idx] != null) st.life.opp = ls.opp[idx];
      st.mePitch = []; st.oppPitch = [];   // le pitch part au deck en fin de tour

      // t.hand / t.arsenal sont TOUJOURS les instantanés du joueur (moi), quel
      // que soit le tour. Mon arsenal est donc toujours à jour — y compris une
      // carte mise en arsenal en fin de mon tour, visible dès le tour suivant.
      st.meArsenal = (t.arsenal || []).slice();
      // Tokens/permanents en jeu : données réelles du terrain (2 camps) si le
      // grabber les a captées, sinon repli par héros (constant sur la partie).
      if (t.field) { st.meTokens = (t.field.me || []).slice(); st.oppTokens = (t.field.opp || []).slice(); }
      else { st.meTokens = HEROTOK.me.slice(); st.oppTokens = HEROTOK.opp.slice(); }
      // Cimetière/banni réels (2 camps) si captés : on cale l'état exact en début
      // de tour ; le cimetière continue de grandir via le log pendant le tour.
      // Sinon (vieux logs), on garde la reconstruction cumulée depuis le récit.
      if (t.grave) { st.meGrave = (t.grave.me || []).slice(); st.oppGrave = (t.grave.opp || []).slice(); }
      if (t.banish) { st.meBanish = (t.banish.me || []).slice(); st.oppBanish = (t.banish.opp || []).slice(); }

      // Joueur actif. Le tour d'ouverture (1er joueur) n'a souvent pas d'en-tête
      // → player=null : on déduit l'acteur (celui qui joue le plus ce tour-là).
      const opening = !attacker;
      let actor = attacker;
      if (opening) {
        // 1er joueur = le 1er à jouer (l'adversaire ne fait que réagir ensuite) ;
        // la majorité serait trompeuse s'il bloque beaucoup pendant l'ouverture.
        const first = (t.events || []).find(e => (e.type === 'played' || e.type === 'activated') && e.player);
        actor = first ? first.player : null;
      }
      const atkSide = actor === MY ? 'me' : 'opp';
      const label = String(t.label || '').replace(MY, HERO.me).replace(OPP, HERO.opp);

      if (opening) {
        // Bannière de début PUIS on rejoue les actions du 1er tour (comme le
        // Déroulé) au lieu de sauter le tour. Main de départ affichée.
        st.meFaceUp = !!(t.hand && t.hand.length);
        if (st.meFaceUp) st.meHandCards = (t.hand || []).slice();
        if (actor === MY) st.oppHandCount = 4;
        push(t.label || 'Ouverture', atkSide, { type: 'banner', side: 'me', big: 'Début de la partie', sub: HERO.me + ' vs ' + HERO.opp });
        if (!actor || !(t.events || []).some(e => e.type === 'played' || e.type === 'activated')) return;   // ouverture sans action → juste la bannière
      } else {
        // Règle FaB : on repioche à la FIN de son tour, pas au début. La main
        // adverse est donc remise à 4 au début de MON tour (l'adversaire a
        // repioché en fin du sien) — mais PAS au début du tour adverse : il
        // garde ce qu'il lui reste après ses blocs, et ne repioche qu'à la fin.
        // L'arsenal adverse n'est pas connu de façon fiable → on ne l'invente pas.
        if (actor === MY) { st.meFaceUp = true; st.meHandCards = (t.hand || []).slice(); st.oppHandCount = 4; }
        else {
          // Tour adverse : MA main m'est connue (instantané capté au début de
          // son tour) → je l'affiche face visible plutôt que des dos de cartes.
          // Repli sur un compteur (dos) seulement si l'instantané manque.
          if (t.hand && t.hand.length) { st.meFaceUp = true; st.meHandCards = t.hand.slice(); }
          else { st.meFaceUp = false; st.meHandCount = 4; }
          st.oppArsenalCount = 0;
        }
        push(label, atkSide, { type: 'banner', side: atkSide, big: actor === MY ? 'Ton tour' : 'Tour adverse',
          sub: HERO[atkSide] + ' attaque · ' + HERO.me + ' ' + st.life.me + ' PV · ' + HERO.opp + ' ' + st.life.opp + ' PV' });
      }

      const evs = t.events || [], consumed = {};
      let openAtk = null, curBlocks = [], curReactions = [];
      // Affiche en carte SEULE une carte de l'attaquant restée sans combat
      // (action hors-combat). Une vraie carte d'ATTAQUE, elle, n'est montrée que
      // dans l'échange (clash) → plus de doublon « carte seule » puis « échange ».
      const flushAtk = () => {
        if (!openAtk) return;
        push(label, openAtk.side, { type: 'play', side: openAtk.side, card: { nm: openAtk.nm }, pitch: openAtk.pitch, text: HERO[openAtk.side] + ' joue ' + openAtk.nm + openAtk.pTxt });
        openAtk = null;
      };
      evs.forEach((e, i) => {
        if (consumed[i]) return;
        if (e.type === 'played') {
          const side = sideOf(e.player); removeCard(side, e.card);
          const pitches = [];
          for (let j = i + 1; j < evs.length; j++) { const f = evs[j]; if (f.type === 'played') break; if (f.type === 'pitched' && f.player === e.player) { pitches.push(f.card); consumed[j] = 1; addPitch(side, f.card); removeCard(side, f.card); } }
          const pTxt = pitches.length ? ' (pitch ' + pitches.join(', ') + ')' : '';
          if (side === atkSide) {
            flushAtk();   // attaque précédente restée sans combat → carte seule
            openAtk = { nm: e.card, side, pitch: pitches.join(', '), pTxt: pTxt };
          } else {
            curReactions.push({ card: e.card, owner: side });
            push(label, side, { type: 'play', side, card: { nm: e.card }, reaction: true, pitch: pitches.join(', '), text: HERO[side] + ' joue ' + e.card + ' en réaction' + pTxt });
          }
        } else if (e.type === 'activated') {
          // Activation d'une capacité (arme, héros, item/permanent, ex. Grasp of
          // the Arknight) : la carte reste en jeu → pas de removeCard ni toGrave.
          // Ce n'est pas une attaque → on l'affiche en carte seule immédiatement,
          // sans passer par le différé de combat (openAtk).
          const side = sideOf(e.player);
          const pitches = [];
          for (let j = i + 1; j < evs.length; j++) { const f = evs[j]; if (f.type === 'played' || f.type === 'activated') break; if (f.type === 'pitched' && f.player === e.player) { pitches.push(f.card); consumed[j] = 1; addPitch(side, f.card); removeCard(side, f.card); } }
          const pTxt = pitches.length ? ' (pitch ' + pitches.join(', ') + ')' : '';
          push(label, side, { type: 'play', side, card: { nm: e.card }, act: true, pitch: pitches.join(', '), text: HERO[side] + ' active ' + e.card + pTxt });
        } else if (e.type === 'pitched') {
          const s = sideOf(e.player); addPitch(s, e.card); removeCard(s, e.card);
        } else if (e.type === 'blocked') {
          const s = sideOf(e.player);
          (e.cards || []).forEach(c => { const eq = isEquip(s, c); if (!eq) removeCard(s, c); curBlocks.push({ card: c, owner: s, eq }); });
        } else if (e.type === 'damageTaken') {
          const s = sideOf(e.player); st.life[s] = Math.max(0, st.life[s] - (e.amount || 0));
        } else if (e.type === 'combatResult') {
          const dmg = e.hit ? (e.amount || 0) : 0;
          if (openAtk) toGrave(openAtk.side, openAtk.nm);
          curBlocks.forEach(b => { if (!b.eq) toGrave(b.owner, b.card); });
          curReactions.forEach(r => toGrave(r.owner, r.card));
          if (openAtk) {
            const defSide = openAtk.side === 'me' ? 'opp' : 'me';
            const defCards = curBlocks.map(b => ({ nm: b.card })).concat(curReactions.filter(r => r.owner === defSide).map(r => ({ nm: r.card })));
            const blockWho = curBlocks.length ? curBlocks[0].owner : defSide;
            const vt = dmg > 0 ? 'through' : 'blocked';
            const rtxt = dmg > 0 ? (dmg + ' dégât' + (dmg > 1 ? 's' : '') + ' pass' + (dmg > 1 ? 'ent' : 'e')) : '0 dégât — bloqué';
            const blkTxt = defCards.length ? ((blockWho === 'me' ? 'Tu défends' : HERO.opp + ' défend') + ' : ' + defCards.map(b => b.nm).join(', ')) : 'non bloqué';
            push(label, openAtk.side, { type: 'clash', atk: { nm: openAtk.nm, who: openAtk.side }, blocks: defCards, blockWho, verdict: vt, result: rtxt, text: blkTxt }, dmg > 0 ? defSide : null);
          }
          openAtk = null; curBlocks = []; curReactions = [];
        }
      });
      flushAtk();   // fin de tour : dernière action hors-combat affichée seule
    });
    return { players: GAME.players, myName: MY, oppName: OPP, hero: HERO, steps };
  }

  // ============================================================
  // RENDU
  // ============================================================
  function gcard(side, slot, name, hero) {
    return '<div class="br-gcard br-' + side + ' p-' + slot + (hero ? ' br-hero' : '') + '">' +
      '<div class="br-art" data-card="' + esc(name) + '"' + (hero ? ' data-hero' : '') + '></div>' +
      '<div class="br-lab">' + esc(name) + '</div></div>';
  }
  // Champ d'un joueur (tapis miroir) : rail cimetière·deck·pitch | héros entouré
  // de son équipement + arme | arsenal. Les IDs des emplacements dynamiques
  // (cimetière/pitch/arsenal) sont conservés pour que render() les remplisse.
  function buildZone(side, pl) {
    const e = pl.equipment || {};
    const nm = k => (e[k] && e[k].name) || '—';
    const gId = side === 'me' ? 'mGrave' : 'oGrave', pId = side === 'me' ? 'mPitch' : 'oPitch';
    const arsId = side === 'me' ? 'mArsenal' : 'oArsenal', bId = side === 'me' ? 'mBanish' : 'oBanish';
    const leftRail = '<div class="br-rail br-left">' +
      '<div class="br-slot p-grave" id="br-' + gId + '">Cimetière</div>' +
      '<div class="br-deck p-deck" title="Deck"></div>' +
      '<div class="br-slot p-pitch" id="br-' + pId + '">Pitch</div>' +
      '<div class="br-slot p-banish" id="br-' + bId + '" title="Banni">Banni</div>' +
      '</div>';
    const equip = '<div class="br-equip">' +
      gcard(side, 'head', nm('head')) + gcard(side, 'chest', nm('chest')) +
      gcard(side, 'arms', nm('arms')) + gcard(side, 'legs', nm('legs')) + '</div>';
    // Arme(s) : on affiche weaponL ET weaponR (main + main gauche/off-hand, ex.
    // « Arcane Lantern »), en sautant les slots vides — sinon la 2e arme adverse
    // n'apparaissait pas sur le plateau.
    const wpnTile = wnm => (wnm && wnm !== '—')
      ? '<div class="br-gcard br-' + side + ' br-wpn"><div class="br-art" data-card="' + esc(wnm) + '"></div><div class="br-lab">' + esc(wnm) + '</div></div>'
      : '';
    const cluster = '<div class="br-cluster">' + equip +
      gcard(side, 'hero', pl.hero || '?', true) +
      wpnTile(nm('weaponL')) + wpnTile(nm('weaponR')) +
      '</div>';
    const rightRail = '<div class="br-rail br-right">' +
      '<div class="br-zpair"><span class="br-zlbl">Arsenal</span>' +
        '<div class="br-slot br-arsenal" id="br-' + arsId + '">Arsenal</div></div>' +
      '</div>';
    return leftRail + cluster + rightRail;
  }

  function mount(container, GAME) {
    if (!container || !GAME || !GAME.turns) return;
    const data = buildTimeline(GAME), steps = data.steps, P = data.players;
    if (!steps.length) { container.innerHTML = '<div class="br-empty">Pas d\'action à rejouer pour cette partie.</div>'; return; }

    // Tokens en jeu (coin droit de la piste centrale ; adversaire en haut, toi
    // en bas — miroir des PV). Conteneurs remplis à chaque étape depuis l'état
    // (terrain réel capté par le grabber, sinon repli par héros). Masqués si la
    // partie n'a aucun token.
    const hasTokens = steps.some(s => (s.state.meTokens && s.state.meTokens.length) || (s.state.oppTokens && s.state.oppTokens.length));
    const tokSide = hasTokens
      ? '<div class="br-tokenside">' +
          '<div class="br-tokrow br-opp" id="br-oppTok"></div>' +
          '<div class="br-tokrow br-me" id="br-meTok"></div>' +
        '</div>'
      : '';

    container.innerHTML =
      '<div class="br-wrap">' +
        '<div class="br-toolbar" role="group" aria-label="Contrôles de lecture">' +
          '<button class="br-tool" data-act="restart" title="Recommencer" aria-label="Recommencer">⏮</button>' +
          '<button class="br-tool" data-act="prev" title="Étape précédente" aria-label="Étape précédente">‹</button>' +
          '<button class="br-tool br-play" data-act="play" title="Lecture automatique" aria-label="Lecture automatique">▶</button>' +
          '<button class="br-tool" data-act="next" title="Étape suivante" aria-label="Étape suivante">›</button>' +
        '</div>' +
        '<div class="br-mat">' +
          '<div class="br-hand br-opp" id="br-oppHand"></div>' +
          '<div class="br-field br-opp" id="br-fOpp">' + buildZone('opp', P.opp) + '</div>' +
          '<div class="br-mid">' +
            '<span class="br-turnchip" id="br-turnPill"> </span>' +
            '<div class="br-lifeside">' +
              '<div class="br-life br-opp"><span class="br-life-who">' + esc(data.hero.opp) + '</span><span class="br-life-n" id="br-oLifeTok">0</span></div>' +
              '<div class="br-life br-me"><span class="br-life-who">' + esc(data.hero.me) + '</span><span class="br-life-n" id="br-mLifeTok">0</span></div>' +
            '</div>' +
            '<div class="br-lane" id="br-stage"></div>' +
            tokSide +
          '</div>' +
          '<div class="br-field br-me br-active" id="br-fMe">' + buildZone('me', P.me) + '</div>' +
          '<div class="br-hand br-me" id="br-myHand"></div>' +
        '</div>' +
        '<div class="br-timeline">' +
          '<div class="br-tl-top"><span class="br-tl-lbl">Timeline</span>' +
            '<span class="br-info"><span id="br-turnLbl"> </span> · étape <b id="br-stepN">1</b>/<b id="br-stepTot">' + steps.length + '</b></span></div>' +
          '<input type="range" id="br-slider" min="0" max="' + (steps.length - 1) + '" value="0" aria-label="Position dans la partie">' +
          '<div class="br-ticks"><span>Début</span><span>Fin</span></div>' +
        '</div>' +
      '</div>';

    paintArt(container);   // équipement + héros (statique)

    const $ = s => container.querySelector(s);
    const slider = $('#br-slider'), stage = $('#br-stage');
    let i = 0, playing = false, timer = null; const prevCounts = {};

    const pcard = (c, side, lg) => '<div class="br-pcard br-' + side + (lg ? ' br-lg' : '') + '" data-card="' + esc(c.nm) + '"><div class="br-art" data-card="' + esc(c.nm) + '"></div><div class="br-nm">' + esc(c.nm) + '</div></div>';
    function buildStage(s) {
      if (s.type === 'banner') return '<div class="br-banner br-' + s.side + '"><div class="br-big">' + esc(s.big) + '</div><div class="br-sub">' + esc(s.sub) + '</div></div>';
      if (s.type === 'play') return '<div class="br-playone br-' + s.side + '">' + pcard(s.card, s.side, true) + (s.act ? '<span class="br-act">⚡ activé</span>' : '') + (s.reaction ? '<span class="br-react">↩ réaction</span>' : '') + (s.pitch ? '<span class="br-pitch-pill">🔷 pitch ' + esc(s.pitch) + '</span>' : '') + '</div>';
      if (s.type === 'clash') {
        const bl = s.blocks.length ? s.blocks.map(b => pcard(b, s.blockWho)).join('') : '<span class="br-noblock">Non bloqué</span>';
        return '<div class="br-phase">Combat</div><div class="br-duel"><div class="br-side"><span class="br-duel-who">Attaque</span>' + pcard(s.atk, s.atk.who) + '</div><span class="br-arrow">→</span><div class="br-side"><span class="br-duel-who">Défense</span><div class="br-cardrow">' + bl + '</div></div></div><div class="br-verdict br-' + s.verdict + '">' + (s.verdict === 'blocked' ? '✓ ' : '💥 ') + esc(s.result) + '</div>';
      }
      return '';
    }
    function fillSlot(sel, label, cards, side, mode) {
      const el = $(sel); if (!el) return; const n = cards ? cards.length : 0, key = sel;
      if (!n) { el.classList.remove('br-filled'); el.innerHTML = ''; el.textContent = label; prevCounts[key] = 0; return; }
      el.classList.add('br-filled');
      const top = cards[cards.length - 1];
      let inner = '<span class="br-slot-tag">' + label + '</span>';
      inner += mode === 'back' ? '<div class="br-zcard br-back"></div>'
        : '<div class="br-zcard br-' + side + (mode === 'grave' ? ' br-grave' : '') + '"><div class="br-art" data-card="' + esc(top) + '"></div><div class="br-nm">' + esc(top) + '</div></div>';
      if (n > 1) inner += '<span class="br-badge">×' + n + '</span>';
      el.innerHTML = inner;
      if (prevCounts[key] != null && n > prevCounts[key]) { el.classList.remove('br-bump'); void el.offsetWidth; el.classList.add('br-bump'); }
      prevCounts[key] = n;
    }
    function backs(el, count, emptyTxt) {
      el.innerHTML = '';
      const n = Math.min(count, 8);
      for (let k = 0; k < n; k++) { const b = document.createElement('div'); b.className = 'br-back'; el.appendChild(b); }
      if (!count) el.innerHTML = '<span class="br-handempty">' + emptyTxt + '</span>';
    }
    function renderHands(s) {
      backs($('#br-oppHand'), s.oppHandCount, 'main vide');
      const mh = $('#br-myHand');
      if (s.meFaceUp) {
        mh.innerHTML = '';
        if (!s.meHandCards.length) { mh.innerHTML = '<span class="br-handempty">main vide</span>'; return; }
        s.meHandCards.forEach(c => { const d = document.createElement('div'); d.className = 'br-pcard br-me br-inhand'; d.innerHTML = '<div class="br-art" data-card="' + esc(c) + '"></div><div class="br-nm">' + esc(c) + '</div>'; mh.appendChild(d); });
      } else backs(mh, s.meHandCount, 'main vide');
    }
    function render(prev) {
      const s = steps[i], stt = s.state;
      stage.innerHTML = buildStage(s.stage);
      $('#br-mLifeTok').textContent = stt.life.me; $('#br-oLifeTok').textContent = stt.life.opp;
      $('#br-turnPill').textContent = s.turn;
      renderHands(stt);
      fillSlot('#br-mPitch', 'Pitch', stt.mePitch, 'me', 'up');
      fillSlot('#br-oPitch', 'Pitch', stt.oppPitch, 'opp', 'up');
      fillSlot('#br-mArsenal', 'Arsenal', stt.meArsenal, 'me', 'up');
      fillSlot('#br-oArsenal', 'Arsenal', stt.oppArsenalCount > 0 ? ['?'] : [], 'opp', 'back');
      fillSlot('#br-mGrave', 'Cimetière', stt.meGrave, 'me', 'grave');
      fillSlot('#br-oGrave', 'Cimetière', stt.oppGrave, 'opp', 'grave');
      fillSlot('#br-mBanish', 'Banni', stt.meBanish, 'me', 'grave');
      fillSlot('#br-oBanish', 'Banni', stt.oppBanish, 'opp', 'grave');
      const tokHtml = (cards, side) => (cards || []).map(c => '<div class="br-tok br-' + side + '" data-card="' + esc(c) + '"><div class="br-art" data-card="' + esc(c) + '"></div><div class="br-nm">' + esc(c) + '</div></div>').join('');
      const otk = $('#br-oppTok'); if (otk) otk.innerHTML = tokHtml(stt.oppTokens, 'opp');
      const mtk = $('#br-meTok'); if (mtk) mtk.innerHTML = tokHtml(stt.meTokens, 'me');
      $('#br-fMe').classList.toggle('br-active', s.actor === 'me');
      $('#br-fOpp').classList.toggle('br-active', s.actor === 'opp');
      slider.value = i; slider.style.setProperty('--pct', (steps.length > 1 ? i / (steps.length - 1) * 100 : 0) + '%');
      $('#br-stepN').textContent = i + 1; $('#br-turnLbl').textContent = s.turn;
      container.querySelector('[data-act="prev"]').disabled = (i === 0);
      container.querySelector('[data-act="next"]').disabled = (i === steps.length - 1);
      if (s.hit && prev != null && prev < i) { const el = $(s.hit === 'me' ? '#br-mLifeTok' : '#br-oLifeTok'); if (el) { el.classList.remove('br-hit'); void el.offsetWidth; el.classList.add('br-hit'); } }
      paintArt(container);
    }
    function go(n, prev) { i = Math.max(0, Math.min(steps.length - 1, n)); render(prev); container.__brIndex = i; }
    function stop() { playing = false; clearInterval(timer); $('.br-play').innerHTML = '▶'; $('.br-play').title = 'Lecture automatique'; }
    function play() { if (i >= steps.length - 1) go(0); playing = true; $('.br-play').innerHTML = '❚❚'; $('.br-play').title = 'Pause'; timer = setInterval(() => { if (i >= steps.length - 1) { stop(); return; } go(i + 1, i); }, 1150); }

    container.querySelector('[data-act="next"]').addEventListener('click', () => { stop(); go(i + 1, i); });
    container.querySelector('[data-act="prev"]').addEventListener('click', () => { stop(); go(i - 1, i); });
    container.querySelector('[data-act="restart"]').addEventListener('click', () => { stop(); go(0, null); });
    $('.br-play').addEventListener('click', () => { playing ? stop() : play(); });
    slider.addEventListener('input', () => { stop(); go(parseInt(slider.value, 10), i); });

    // ---- Survol : aperçu de la carte en grand (lisibilité ; desktop) ----
    const preview = document.createElement('div');
    preview.className = 'br-preview';
    container.appendChild(preview);
    const PW = 224, PH = 313;
    function showPreview(tile) {
      const art = tile.matches('.br-art') ? tile : tile.querySelector('.br-art');
      if (!art || !art.classList.contains('has-img') || !art.style.backgroundImage) return;
      preview.style.backgroundImage = art.style.backgroundImage;
      const r = tile.getBoundingClientRect();
      let left = r.left + r.width / 2 - PW / 2;
      let top = r.top - PH - 10;
      if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - PH - 8);
      left = Math.max(8, Math.min(left, window.innerWidth - PW - 8));
      preview.style.left = left + 'px';
      preview.style.top = Math.max(8, top) + 'px';
      preview.classList.add('show');
    }
    container.addEventListener('mouseover', e => { const t = e.target.closest('[data-card]'); if (t) showPreview(t); });
    container.addEventListener('mouseout', e => { const t = e.target.closest('[data-card]'); if (t) preview.classList.remove('show'); });

    // ---- Hauteur du stage figée : sinon la « carte d'action » change de taille
    // d'une étape à l'autre (bannière courte vs carte jouée haute vs combat) et
    // fait sauter la mise en page — sur mobile les boutons au-dessus finissaient
    // hors écran. On mesure le contenu le plus haut parmi TOUTES les étapes (les
    // dimensions sont fixées par le CSS, indépendamment du chargement des images)
    // et on fige cette hauteur. Recalculé si la largeur change (rotation, bascule
    // mobile/desktop) car le passage à la ligne des cartes dépend de la largeur.
    function stabilizeStage() {
      if (!stage.offsetParent) return;             // onglet caché → pas de layout fiable
      // Sur desktop, la piste est bornée à la LARGEUR du plus grand contenu pour
      // que les PV (à sa gauche) restent collés au combat au lieu de flotter au
      // bord ; sur mobile elle remplit l'espace restant (flex) → largeur libre.
      const wide = !!(window.matchMedia && window.matchMedia('(min-width: 900px)').matches);
      const savedH = stage.style.height, savedMin = stage.style.minHeight;
      stage.style.height = 'auto'; stage.style.minHeight = '0'; stage.style.width = 'auto';
      let maxH = 0, maxW = 0;
      for (const s of steps) { stage.innerHTML = buildStage(s.stage); if (stage.offsetHeight > maxH) maxH = stage.offsetHeight; if (stage.offsetWidth > maxW) maxW = stage.offsetWidth; }
      if (!maxH) { stage.style.height = savedH; stage.style.minHeight = savedMin; stage.style.width = ''; render(null); return; }
      stage.style.minHeight = '0';
      stage.style.height = maxH + 'px';
      stage.style.width = wide && maxW ? maxW + 'px' : '';
      render(null);                                // ré-affiche l'étape courante dans la boîte figée
    }
    if (window.ResizeObserver) {
      let raf = 0, lastW = -1;
      const ro = new ResizeObserver(() => {
        // Ne réagir qu'aux changements de LARGEUR : figer le stage change la
        // hauteur du conteneur, ce qui re-déclencherait l'observateur en boucle.
        const w = Math.round(container.clientWidth);
        if (w === lastW) return;
        lastW = w;
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; stabilizeStage(); });
      });
      ro.observe(container);
    }

    go(0, null);
    stabilizeStage();
  }

  root.BoardReplay = { mount, buildTimeline };
  if (typeof module === 'object' && module.exports) module.exports = root.BoardReplay;
})(typeof self !== 'undefined' ? self : this);
