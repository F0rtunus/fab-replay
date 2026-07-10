/* ============================================================
 * REPLAY — replay d'UNE partie, tour par tour.
 * ------------------------------------------------------------
 * Extrait tel quel du viewer standalone (v4). Le comportement de
 * replay est IDENTIQUE : seule la source des images a changé
 * (module partagé CardImages au lieu de fonctions inline).
 *
 * API publique :
 *   Replay.show(record)  → affiche le record parsé (venu de la DB
 *                          ou d'un import direct) dans #replayView.
 *   Replay.reset()       → vide l'affichage.
 *
 * Le parsing vit dans talishar-parser.js ; ce module ne fait que
 * du rendu + de la résolution d'images.
 * ============================================================ */
(function (root) {
  'use strict';

  const resolveCardImage = (n) => root.CardImages.resolveCardImage(n);
  const resolveCardMeta = (n) => root.CardImages.resolveCardMeta(n);
  // Portrait de héros : full-art Marvel si dispo (cohérent avec le carrousel du dashboard).
  const resolveHeroImage = (n) => (root.CardImages.resolveHeroCardImage || root.CardImages.resolveCardImage)(n);
  // Couleur « moi » = accent du héros joué (posé sur :root par le dashboard),
  // pour l'harmonie visuelle avec le tableau de bord. Repli sur l'or historique.
  const accentColor = () => {
    const a = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim();
    return a || '#c9a227';
  };

  // ============================================================
  // ÉTAT
  // ============================================================
  let GAME = null;
  let myName = null, oppName = null;
  let myEquipNamesNorm = new Set(); // noms d'équipement (normalisés) — jamais des cartes de main/arsenal
  let currentTurnIndex = 0;
  let showTechnical = false;
  let maxLife = 40; // échelle de la courbe (déduit du record)
  let inited = false;
  let _curveGeom = null; // géométrie des points de la courbe pour l'overlay HTML

  const $ = sel => document.querySelector(sel);

  function init() {
    if (inited) return;
    inited = true;
    $('#prevTurn').addEventListener('click', () => { if (currentTurnIndex > 0) { currentTurnIndex--; renderChainActive(); renderTurn(); } });
    $('#nextTurn').addEventListener('click', () => { if (currentTurnIndex < GAME.turns.length - 1) { currentTurnIndex++; renderChainActive(); renderTurn(); } });
    $('#detailToggle').addEventListener('change', e => { showTechnical = e.target.checked; renderTurn(); });

    // Courbe de vie interactive : survol = repère + infobulle ; clic/tap = navigation au tour.
    const holder = $('#curveHolder');
    if (holder) {
      const idxAt = clientX => {
        if (!_curveGeom || !_curveGeom.length) return -1;
        const rect = holder.getBoundingClientRect();
        if (!rect.width) return -1;
        const relPct = (clientX - rect.left) / rect.width * 100;
        let best = 0, bd = 1e9;
        _curveGeom.forEach((p, i) => { const d = Math.abs(p.leftPct - relPct); if (d < bd) { bd = d; best = i; } });
        return best;
      };
      holder.addEventListener('pointermove', e => { const i = idxAt(e.clientX); if (i >= 0) positionCurveOverlay(i, true); });
      holder.addEventListener('pointerleave', () => positionCurveOverlay(currentTurnIndex, false));
      holder.addEventListener('pointerdown', e => {
        const i = idxAt(e.clientX);
        if (i >= 0 && i !== currentTurnIndex) { currentTurnIndex = i; renderChainActive(); renderTurn(); }
      });
    }

    // Aperçu grande carte au survol (desktop) : couvre TOUT le déroulé —
    // équipement/héros du bandeau, cartes des tours, cartes vues et miniatures
    // d'événement (blocs multi-cartes). Délégué sur #replayView pour capter
    // aussi les éléments créés dynamiquement à chaque tour.
    const rv = $('#replayView');
    if (rv) {
      const prev = document.createElement('div');
      prev.className = 'br-preview';
      document.body.appendChild(prev);
      const PW = 224, PH = 313;
      const sel = '.eq-slot[data-card], .hero-avatar[data-hero], .card-chip, .ev-thumb';
      rv.addEventListener('mouseover', e => {
        const el = e.target.closest(sel);
        const img = el && el.querySelector('img');
        if (!img || !img.src) { prev.classList.remove('show'); return; }
        prev.style.backgroundImage = "url('" + img.src + "')";
        const r = el.getBoundingClientRect();
        let left = r.left + r.width / 2 - PW / 2;
        let top = r.top - PH - 10;                          // au-dessus par défaut
        if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - PH - 8);
        left = Math.max(8, Math.min(left, window.innerWidth - PW - 8));
        prev.style.left = left + 'px';
        prev.style.top = Math.max(8, top) + 'px';
        prev.classList.add('show');
      });
      rv.addEventListener('mouseout', e => { if (e.target.closest(sel)) prev.classList.remove('show'); });
    }
  }

  // Total de PV attendu selon le format (repli si les PV de départ ne sont pas
  // captés) : 20 en limité/blitz, 40 en construit. Défaut prudent : 40.
  function scaleForFormat(fmt) {
    const f = String(fmt || '').toLowerCase();
    if (/blitz|commoner|draft|sealed|clash|limit/.test(f)) return 20;
    if (/cc|classic|constructed|living|legend|\bll\b/.test(f)) return 40;
    return 40;
  }

  // ============================================================
  // POINT D'ENTRÉE
  // ============================================================
  function show(record) {
    init();
    GAME = record;
    myName = GAME.myName;
    oppName = GAME.oppName;
    // Sécurité : record ancien sans identité résolue → repli sur la liste.
    if (!myName && GAME.playersList && GAME.playersList.length) {
      myName = GAME.playersList[0];
      oppName = GAME.playersList.find(p => p !== myName) || null;
    }
    myEquipNamesNorm = new Set(
      Object.values((GAME.players.me && GAME.players.me.equipment) || {}).map(e => e && e.name).filter(Boolean).map(root.TalisharParser.normName)
    );
    // Échelle de la courbe selon le total de PV de la partie : 20 en limité /
    // blitz, 40 en construit. On se base sur les PV de DÉPART captés (source
    // fiable, quel que soit le nom de format), avec repli sur le format si non
    // capté, et on étend si la vie dépasse le départ (soins au-dessus du max).
    const startMax = Math.max(GAME.players.me.startLife || 0, GAME.players.opp.startLife || 0);
    const baseLife = startMax > 0 ? (startMax > 20 ? 40 : 20) : scaleForFormat(GAME.format);
    maxLife = Math.max(baseLife, 0, ...GAME.lifeSeries.me, ...GAME.lifeSeries.opp);
    currentTurnIndex = 0;
    showTechnical = $('#detailToggle') ? $('#detailToggle').checked : false;
    // Harmonisation avec le dashboard : thème (accent + fond full-art) du héros joué.
    if (root.Dashboard && root.Dashboard.applyHeroTheme) {
      root.Dashboard.applyHeroTheme((GAME.players.me && GAME.players.me.hero) || myName);
    }
    render();
  }

  function reset() {
    GAME = null;
    const sb = $('#scoreboard'); if (sb) sb.style.display = 'none';
    const es = $('#replayEmpty'); if (es) es.style.display = 'block';
  }

  // ============================================================
  // RENDU
  // ============================================================
  function render() {
    const es = $('#replayEmpty'); if (es) es.style.display = 'none';
    $('#scoreboard').style.display = 'block';
    ARSENAL_BACKFILL = computeArsenalBackfill();
    renderTopTitle();
    renderMatchBanner();
    renderCurve();
    renderChain();
    renderTurn();
    renderStats();
  }

  function renderMatchBanner() {
    const el = $('#matchBanner');
    const me = GAME.players.me, opp = GAME.players.opp;
    const dur = root.TalisharParser.formatDuration(GAME.timeline.durationSec);
    const curMe = GAME.life[myName] != null ? GAME.life[myName] : (me.startLife || maxLife);
    const curOpp = GAME.life[oppName] != null ? GAME.life[oppName] : (opp.startLife || maxLife);

    // Verdict (filigrane diagonal)
    let verdict = '<span class="verdict unknown">En cours</span>';
    if (GAME.result) {
      verdict = GAME.result.iWon
        ? '<span class="verdict win">Victoire' + (GAME.result.byConcession ? '·abandon' : '') + '</span>'
        : '<span class="verdict loss">Défaite' + (GAME.result.byConcession ? '·abandon' : '') + '</span>';
    }

    const chips = [];
    if (GAME.format) chips.push('<span class="match-chip">🎮 ' + escapeHtml(GAME.format) + '</span>');
    if (dur) chips.push('<span class="match-chip">⏱ ' + dur + '</span>');
    chips.push('<span class="match-chip">🔁 ' + GAME.turns.length + ' tours</span>');
    if (GAME.vsAI) chips.push('<span class="match-chip ai">🤖 vs IA</span>');
    if (GAME.warnings && GAME.warnings.length) chips.push('<span class="match-chip warn" title="' + escapeHtml(GAME.warnings.join(' | ')) + '">⚠ ' + GAME.warnings.length + '</span>');

    const sideHtml = (p, cur, side) => {
      const initial = escapeHtml((p.hero || p.name || '?').charAt(0).toUpperCase());
      const low = cur <= 10 ? ' low' : '';
      return '<div class="match-side ' + side + '">' +
        '<div class="hero-avatar" data-hero="' + escapeHtml(p.hero || '') + '">' + initial + '</div>' +
        '<div class="hero-meta">' +
          '<div class="hname">' + escapeHtml(p.hero || '?') + '</div>' +
          '<div class="pname">' + escapeHtml(p.name || '?') + (side === 'me' ? ' (toi)' : '') + '</div>' +
          '<div class="plife' + low + '">' + cur + ' pv</div>' +
        '</div></div>';
    };

    const eqStrip = (p, side) => {
      const slots = root.TalisharParser.EQ_SLOTS
        .map(s => p.equipment && p.equipment[s] ? p.equipment[s] : null)
        .filter(Boolean);
      const label = '<div class="eq-label ' + side + '">' + (side === 'me' ? 'Toi' : 'Adv') + '</div>';
      if (!slots.length) return '<div class="eq-strip">' + label + '<div class="eq-empty">équipement non capté</div></div>';
      const cells = slots.map(eq => {
        // Face cachée : pas d'identifiant / carte "Cardback" (mécanique Enigma…).
        // Sinon on affiche le nom en repli (l'image peut manquer chez goagain).
        const faceDown = !eq.id || /cardback/i.test(eq.name);
        if (faceDown) {
          return '<div class="eq-slot" title="Équipement face cachée"><div class="eq-ph" title="Équipement face cachée">🂠</div></div>';
        }
        return '<div class="eq-slot" data-card="' + escapeHtml(eq.name) + '" title="' + escapeHtml(eq.name) + '">' +
          '<div class="eq-ph eq-name">' + escapeHtml(eq.name) + '</div></div>';
      }).join('');
      return '<div class="eq-strip">' + label + '<div class="eq-slots">' + cells + '</div></div>';
    };

    el.innerHTML =
      '<div class="match-card">' +
        '<div class="match-heroes">' +
          sideHtml(me, curMe, 'me') +
          '<div class="match-mid"><span class="vs">VS</span></div>' +
          sideHtml(opp, curOpp, 'opp') +
        '</div>' +
        '<div class="match-verdict">' + verdict + '</div>' +
        '<div class="match-meta">' + chips.join('') + '</div>' +
        eqStrip(me, 'me') +
        eqStrip(opp, 'opp') +
      '</div>';

    // Charger les portraits de héros (async)
    el.querySelectorAll('.hero-avatar[data-hero]').forEach(av => {
      const hero = av.getAttribute('data-hero');
      if (!hero) return;
      resolveHeroImage(hero).then(url => { if (url) av.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(hero) + '" loading="lazy">'; });
    });
    // Charger les visuels d'équipement (async)
    el.querySelectorAll('.eq-slot[data-card]').forEach(slot => {
      const card = slot.getAttribute('data-card');
      resolveCardImage(card).then(url => { if (url) slot.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(card) + '" loading="lazy">'; });
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Barre du haut : on n'affiche plus le matchup ici — le bandeau de match
  // juste en dessous porte déjà les héros et les PV (doublon supprimé).
  function renderTopTitle() {
    const el = $('#replayMatchup');
    if (el) el.innerHTML = '';
  }

  function renderCurve() {
    const svg = $('#curveSvg');
    const accent = accentColor();
    const seriesMe = GAME.lifeSeries.me, seriesOpp = GAME.lifeSeries.opp;
    const n = GAME.turns.length;
    const W = 400, H = 132;
    const padL = 26, padR = 8, padTop = 10, padBot = 20;
    const plotW = W - padL - padR, plotH = H - padTop - padBot;
    const x = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = v => padTop + plotH - (Math.max(0, v) / maxLife) * plotH;
    const line = arr => arr.map((v, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const area = arr => line(arr) + ' L' + x(n - 1).toFixed(1) + ',' + y(0).toFixed(1) + ' L' + x(0).toFixed(1) + ',' + y(0).toFixed(1) + ' Z';

    // ---- Axe Y : repères de vie (0, moitié, max) ----
    const yTicks = [0, Math.round(maxLife / 2), maxLife];
    const yAxis = yTicks.map(v =>
      `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#262c3d" stroke-width="1"/>` +
      `<text class="curve-axis-label" x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`
    ).join('');

    // ---- Axe X : numéros de tour, avec espacement adaptatif ----
    const step = n <= 11 ? 1 : Math.ceil(n / 11);
    let xAxis = '';
    for (let i = 0; i < n; i += step) {
      const t = GAME.turns[i];
      const label = (t.turnNumber === 0 && i === 0) ? '⚡' : String(t.turnNumber);
      xAxis += `<text class="curve-axis-label" x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="middle">${label}</text>`;
    }
    // seuil zone critique (10 pv)
    const critY = y(10);
    const endMe = seriesMe[seriesMe.length - 1], endOpp = seriesOpp[seriesOpp.length - 1];

    // Lignes + aires en SVG (le trait garde une épaisseur constante malgré
    // l'étirement horizontal grâce à vector-effect). Les POINTS sont en overlay
    // HTML (ronds, non déformés) — cf. positionCurveOverlay.
    svg.innerHTML = `
      <defs>
        <linearGradient id="gradMe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${accent}" stop-opacity=".28"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="gradOpp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#8b6bff" stop-opacity=".22"/>
          <stop offset="100%" stop-color="#8b6bff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="${padL}" y="${critY.toFixed(1)}" width="${plotW}" height="${(padTop + plotH - critY).toFixed(1)}" fill="rgba(224,85,90,.07)"/>
      <line x1="${padL}" y1="${critY.toFixed(1)}" x2="${W - padR}" y2="${critY.toFixed(1)}" stroke="rgba(224,85,90,.35)" stroke-width="1" stroke-dasharray="3,4"/>
      ${yAxis}
      ${xAxis}
      <path d="${area(seriesOpp)}" fill="url(#gradOpp)"/>
      <path d="${area(seriesMe)}" fill="url(#gradMe)"/>
      <path d="${line(seriesOpp)}" fill="none" stroke="#8b6bff" stroke-width="2" opacity=".9" vector-effect="non-scaling-stroke"/>
      <path d="${line(seriesMe)}" fill="none" stroke="${accent}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
      <text x="${(x(n - 1) - 2).toFixed(1)}" y="${(y(endMe) - 5).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="10" font-weight="700" fill="${accent}">${endMe}</text>
      <text x="${(x(n - 1) - 2).toFixed(1)}" y="${(y(endOpp) + 12).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="10" font-weight="700" fill="#8b6bff">${endOpp}</text>
    `;

    // Géométrie des points en % (x) / % (y sur H) pour l'overlay HTML non déformé.
    _curveGeom = seriesMe.map((v, i) => {
      const t = GAME.turns[i];
      return {
        leftPct: x(i) / W * 100,
        meTopPct: y(seriesMe[i]) / H * 100,
        oppTopPct: y(seriesOpp[i]) / H * 100,
        meV: seriesMe[i], oppV: seriesOpp[i],
        label: (t.turnNumber === 0 && i === 0) ? 'Ouverture' : 'Tour ' + t.turnNumber
      };
    });
    const dotMe = $('#curveDotMe');
    if (dotMe) dotMe.style.background = accent;
    positionCurveOverlay(currentTurnIndex, false);
  }

  // Positionne les points ronds (overlay HTML), le repère vertical et — si
  // survol — l'infobulle, sur le tour d'index `idx`. Met aussi à jour le lecteur.
  function positionCurveOverlay(idx, withTip) {
    if (!_curveGeom || !_curveGeom.length) return;
    idx = Math.max(0, Math.min(_curveGeom.length - 1, idx));
    const p = _curveGeom[idx];
    const dotMe = $('#curveDotMe'), dotOpp = $('#curveDotOpp'), guide = $('#curveGuide'), tip = $('#curveTip');
    if (dotMe) { dotMe.style.left = p.leftPct + '%'; dotMe.style.top = p.meTopPct + '%'; dotMe.style.display = 'block'; }
    if (dotOpp) { dotOpp.style.left = p.leftPct + '%'; dotOpp.style.top = p.oppTopPct + '%'; dotOpp.style.display = 'block'; }
    if (guide) { guide.style.left = p.leftPct + '%'; guide.classList.toggle('show', !!withTip || idx === currentTurnIndex); }
    if (tip) {
      if (withTip) {
        tip.style.left = p.leftPct + '%';
        tip.style.top = Math.min(p.meTopPct, p.oppTopPct) + '%';
        tip.innerHTML = '<div class="ct-turn">' + p.label + '</div>'
          + '<div class="ct-row me">Toi <b>' + p.meV + '</b></div>'
          + '<div class="ct-row opp">Adv <b>' + p.oppV + '</b></div>';
        tip.classList.add('show');
        tip.classList.toggle('flipL', p.leftPct > 74);
      } else {
        tip.classList.remove('show');
      }
    }

    // ---- Lecteur de valeurs pour le tour sélectionné ----
    const ro = $('#curveReadout');
    if (ro) {
      const cur = _curveGeom[currentTurnIndex];
      ro.innerHTML =
        '<span class="turnlbl">' + cur.label + '</span>' +
        '<span class="who"><span class="dot me"></span>Toi <span class="val">' + cur.meV + '</span></span>' +
        '<span class="who"><span class="dot opp"></span>Adv <span class="val">' + cur.oppV + '</span></span>';
    }
  }

  function renderChain() {
    const chain = $('#chain');
    chain.innerHTML = '';
    // échelle des sparks : dégât max sur un tour
    let maxDmg = 1;
    GAME.turns.forEach(t => { maxDmg = Math.max(maxDmg, t.damageToMe || 0, t.damageToOpp || 0); });

    GAME.turns.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'link' + (i === currentTurnIndex ? ' active' : '') + (t.player === myName ? ' me' : t.player === oppName ? ' opp' : '');

      // spark : on montre le flux de dégâts dominant du tour
      const dOpp = t.damageToOpp || 0, dMe = t.damageToMe || 0;
      let sparkHtml = '<div class="spark"></div>';
      if (dOpp > 0 || dMe > 0) {
        const toOpp = dOpp >= dMe;           // dégâts que TU infliges = positif (or)
        const val = toOpp ? dOpp : dMe;
        const hPct = Math.max(12, Math.round(val / maxDmg * 100));
        sparkHtml =
          '<div class="spark"><div class="bar ' + (toOpp ? 'toOpp' : 'toMe') + '" style="height:' + hPct + '%"></div></div>' +
          '<div class="dval ' + (toOpp ? 'toOpp' : 'toMe') + '">' + (toOpp ? '−' : '−') + val + '</div>';
      }

      div.innerHTML =
        '<div class="ring">' + (t.turnNumber === 0 && i === 0 ? '⚡' : t.turnNumber) + '</div>' +
        '<div class="lbl">' + (t.player || 'Début') + '</div>' +
        sparkHtml;
      div.addEventListener('click', () => { currentTurnIndex = i; render(); });
      chain.appendChild(div);
    });
  }

  const PRIMARY_TYPES = new Set(['played', 'pitched', 'activated', 'blocked', 'discarded', 'damageTaken', 'lifeGained', 'targeted', 'revealed', 'modeSelected', 'goAgain', 'undo', 'conceded', 'gameWon', 'combatResult']);

  // Chaque événement → { icon, cards[], text, secondary }. L'icône remplace
  // l'ancien badge texte, et `cards` porte TOUTES les cartes (un blocage à
  // plusieurs cartes montre donc toutes les miniatures). Texte volontairement
  // court (inspiration Talishar : lecture visuelle plutôt que verbeuse).
  function eventLine(e) {
    switch (e.type) {
      case 'played': return { icon: '⚔️', cards: [e.card], text: `<b>${e.player}</b> joue${e.fromArsenal ? ' <span class="ev-dim">(arsenal)</span>' : ''}` };
      case 'pitched': return { icon: '🔷', cards: [e.card], text: `<b>${e.player}</b> pitch` };
      case 'activated': return { icon: '✨', cards: [e.card], text: `<b>${e.player}</b> active` };
      case 'blocked': return { icon: '🛡️', cards: e.cards, text: `<b>${e.player}</b> bloque` };
      case 'discarded': return { icon: '🗑️', cards: [e.card], text: `<b>${e.player || ''}</b> défausse` };
      case 'damageTaken': return e.amount > 0 ? { icon: '💥', text: `<b>${e.player}</b> encaisse <b>${e.amount}</b> dégâts` } : { icon: '🛡️', text: `${e.player} — 0 dégât (bloqué)`, secondary: true };
      case 'lifeGained': return { icon: '❤️', text: `<b>${e.player}</b> +${e.amount} pv` };
      case 'combatResult': return e.hit ? { icon: '💥', text: `Touché pour <b>${e.amount}</b>` } : { icon: '🛡️', text: `Aucun dégât` };
      case 'targeted': return { icon: '🎯', text: `Cible : ${e.target}`, secondary: true };
      case 'revealed': return { icon: '👁️', cards: [e.card], text: `<b>${e.player}</b> révèle` };
      case 'modeSelected': return { icon: '🔀', text: `Mode de ${e.card} : ${e.mode}` };
      case 'goAgain': return { icon: '🔁', text: `${e.card} — rejoue` };
      case 'undo': return { icon: '↩️', text: `<b>${e.player}</b> annule` };
      case 'conceded': return { icon: '🏳️', text: `<b>${e.player}</b> abandonne` };
      case 'gameWon': return { icon: '🏆', text: `<b>${e.player}</b> remporte la partie` };
      case 'passed': return { icon: '⏭️', text: `${e.player} passe`, secondary: true };
      case 'autoPassed': return { icon: '⏭️', text: `${e.player} passe (auto)`, secondary: true };
      case 'endTurn': return { icon: '⏹️', text: `${e.player} termine son tour`, secondary: true };
      case 'resolving': return { icon: '⚙️', cards: e.card ? [e.card] : [], text: e.card ? `Résolution` : e.text, secondary: true };
      case 'chainLinkResolved': return { icon: '🔗', text: `Maillon résolu`, secondary: true };
      case 'chainClosed': return { icon: '🔗', text: `Chaîne fermée`, secondary: true };
      case 'hitEffect': return { icon: '✴️', cards: e.card ? [e.card] : [], text: `Effet de coup`, secondary: true };
      case 'deckManipulation': return { icon: '🎴', text: e.card ? `${e.card} renvoyée au deck` : `Carte renvoyée au deck`, secondary: true };
      case 'deckShuffled': return { icon: '🎴', text: `Deck mélangé`, secondary: true };
      case 'targetedSecondary': return { icon: '🎯', text: `${e.owner} — ${e.card} ciblée`, secondary: true };
      case 'damageAnnounced': return { icon: '⚠️', text: `${e.player} va prendre ${e.amount} dégâts`, secondary: true };
      case 'arcaneDamage': case 'info': case 'diceRoll': case 'firstPlayer':
        return { icon: 'ℹ️', text: e.text, secondary: true };
      case 'unknown': return { icon: '❓', text: e.text, secondary: true };
      default: return { icon: '•', text: e.text || '', secondary: true };
    }
  }

  function extractTurnCards(turn) {
    const byPlayer = {};
    const ensure = p => { if (!byPlayer[p]) byPlayer[p] = []; return byPlayer[p]; };
    let lastKnownPlayer = turn.player;
    turn.events.forEach(e => {
      if (e.player) lastKnownPlayer = e.player;
      if (e.type === 'played') ensure(e.player).push({ card: e.card, action: 'play' });
      else if (e.type === 'pitched') ensure(e.player).push({ card: e.card, action: 'pitch' });
      else if (e.type === 'activated') ensure(e.player).push({ card: e.card, action: 'play' });
      else if (e.type === 'blocked') e.cards.forEach(c => ensure(e.player).push({ card: c, action: 'block' }));
      else if (e.type === 'revealed') ensure(e.player).push({ card: e.card, action: 'reveal' });
      else if (e.type === 'discarded') ensure(lastKnownPlayer).push({ card: e.card, action: 'discard' });
    });
    return byPlayer;
  }

  const ACTION_META = {
    play: { icon: '▶', cls: 'tag-play' },
    pitch: { icon: '🔥', cls: 'tag-pitch' },
    block: { icon: '🛡', cls: 'tag-block' },
    reveal: { icon: '👁', cls: 'tag-reveal' },
    discard: { icon: '🗑', cls: 'tag-discard' },
  };

  function prevOwnTurnIndex(i, player) {
    for (let j = i - 1; j >= 0; j--) if (GAME.turns[j].player === player) return j;
    return -1;
  }

  let ARSENAL_BACKFILL = {};
  function computeArsenalBackfill() {
    const map = {};
    GAME.turns.forEach((t, i) => {
      t.events.forEach(e => {
        if (e.type === 'played' && e.fromArsenal) {
          const j = prevOwnTurnIndex(i, e.player);
          if (j >= 0) {
            map[j] = map[j] || {};
            map[j][e.player] = map[j][e.player] || [];
            if (!map[j][e.player].some(g => g.card === e.card))
              map[j][e.player].push({ card: e.card, revealedLabel: t.label });
          }
        }
      });
    });
    return map;
  }

  function makeGhostChip(card, revealedLabel) {
    const chip = document.createElement('div');
    chip.className = 'card-chip ghost';
    chip.innerHTML = `<div class="art">${card}</div><span class="tag tag-arsenal">🔮</span><div class="cname">${card}</div>`;
    chip.title = 'Déduction certaine : posée en arsenal ce tour-là, révélée au ' + revealedLabel;
    const art = chip.querySelector('.art');
    resolveCardImage(card).then(url => { if (url) art.innerHTML = `<img src="${url}" alt="${card}" loading="lazy">`; });
    return chip;
  }

  function makeCardChip(card, action, small) {
    const chip = document.createElement('div');
    chip.className = 'card-chip';
    const meta = ACTION_META[action] || ACTION_META.play;
    chip.innerHTML = `
      <div class="art shimmer">${small ? '' : card}</div>
      <span class="tag ${meta.cls}">${meta.icon}</span>
      ${small ? '' : `<div class="cname">${card}</div>`}
    `;
    const artEl = chip.querySelector('.art');
    resolveCardImage(card).then(url => { artEl.classList.remove('shimmer'); if (url) artEl.innerHTML = `<img src="${url}" alt="${card}" loading="lazy">`; });
    return chip;
  }

  // Une carte jouée (hors arsenal) / pitchée / bloquée / défaussée ce tour
  // était forcément en main avant le début du tour — SAUF si c'est un
  // équipement connu (casque, torse, arme...) : on peut bloquer directement
  // avec de l'équipement déjà porté, sans qu'il soit jamais passé par la
  // main. On exclut donc systématiquement les noms d'équipement connus de
  // cette déduction, quelle que soit l'action qui les mentionne.
  function reconcileCertain(list, t, kind) {
    const norm = root.TalisharParser.normName;
    const result = (list || []).slice();
    const seen = new Set(result.map(norm));
    const tryAdd = c => {
      if (!c) return;
      const nc = norm(c);
      if (seen.has(nc) || myEquipNamesNorm.has(nc)) return;
      seen.add(nc); result.push(c);
    };
    let lastKnownPlayer = t.player;
    t.events.forEach(e => {
      if (e.player) lastKnownPlayer = e.player;
      if (kind === 'hand') {
        const owner = e.player || (e.type === 'discarded' ? lastKnownPlayer : null);
        if (owner !== myName) return;
        if (e.type === 'played' && !e.fromArsenal) tryAdd(e.card);
        if (e.type === 'pitched') tryAdd(e.card);
        // Blocages : ils prouvent qu'une carte était en main AU DÉBUT du tour —
        // sauf au tour d'ouverture. Quand tu es 2e joueur, l'« ouverture »
        // englobe le tour de l'adversaire pendant lequel tu ne fais que bloquer,
        // et l'instantané de main est pris à un autre moment que ces blocages :
        // les empiler gonfle la main (5 cartes au lieu de 4). On ignore donc les
        // blocages pour le seul tour d'ouverture.
        if (e.type === 'blocked' && e.cards && t.turnNumber !== 0) e.cards.forEach(tryAdd);
        // Une carte défaussée (coût, effet adverse forcé, etc.) vient de la
        // main dans l'immense majorité des cas du jeu — seule une carte jouée
        // depuis l'arsenal peut être détruite sans passer par la main, et ce
        // cas est déjà tracé séparément via l'événement 'played'.
        if (e.type === 'discarded') tryAdd(e.card);
      } else if (kind === 'arsenal') {
        if (e.player !== myName) return;
        if (e.type === 'played' && e.fromArsenal) tryAdd(e.card);
      }
    });
    return result;
  }

  // ============================================================
  // DÉROULÉ — rendu « fil-récit » (chaque attaque = une passe d'armes)
  // Objectif : lire d'un coup d'œil ce que le joueur actif a fait et comment
  // l'adversaire a répondu. Le regroupement s'appuie sur la structure fiable
  // du log (played/activated → blocked → combatResult → chainLinkResolved).
  // Les totaux du bandeau viennent des champs fiables du tour (damageToOpp/Me).
  // ============================================================

  // Joueur actif du tour (propriétaire). On se fie d'abord au `side` résolu par
  // le parseur (fiable), puis à `player`. En dernier recours (ouverture sans
  // propriétaire), on prend l'acteur MAJORITAIRE du tour — plus robuste que le
  // 1er acteur, qui peut être l'adversaire s'il réagit en premier (ce qui
  // ferait disparaître à tort tes propres attaques du fil).
  function activePlayerOf(t) {
    if (t.side === 'me') return myName;
    if (t.side === 'opp') return oppName;
    if (t.player) return t.player;
    // Tour sans en-tête (ouverture) : le 1er joueur agit AVANT que l'adversaire
    // réagisse → on prend le 1er à JOUER, pas l'acteur majoritaire. Sinon un
    // adversaire qui bloque/prévient beaucoup pendant ton ouverture « vole » le
    // tour (il a plus de cartes jouées que toi, alors que c'est TON tour).
    for (let k = 0; k < t.events.length; k++) {
      const e = t.events[k];
      if ((e.type === 'played' || e.type === 'activated') && e.player) return e.player;
    }
    return myName;
  }

  // Regroupe les événements bruts en passes d'armes + réponses hors combat.
  function groupTurn(t, active, defender) {
    const exchanges = [], oppResponses = [];
    const secondary = { pitch: 0, activate: 0, reveals: [], modes: [] };
    let cur = null;
    const close = () => { if (cur) { exchanges.push(cur); cur = null; } };
    t.events.forEach(e => {
      const byActive = e.player === active;
      if ((e.type === 'played' || e.type === 'activated') && byActive) {
        close();
        cur = { card: e.card, isActivation: e.type === 'activated', fromArsenal: !!e.fromArsenal,
                blocks: [], defense: [], reveals: [], pitchCost: [], mode: null, result: null };
        if (e.type === 'activated') secondary.activate++;
      } else if ((e.type === 'played' || e.type === 'activated') && e.player === defender && cur) {
        // Réaction du défenseur PENDANT l'attaque (hors blocage) : prévention
        // arcanique (ex. Voltic Veil), activation défensive… → « comment l'adversaire a répondu ».
        if (e.card) cur.defense.push({ card: e.card, isActivation: e.type === 'activated' });
      } else if (e.type === 'pitched' && byActive) {
        secondary.pitch++;
        if (cur) cur.pitchCost.push(e.card);
      } else if (e.type === 'modeSelected') {
        if (cur && (!e.card || e.card === cur.card)) cur.mode = e.mode;
        if (e.mode) secondary.modes.push(e.mode);
      } else if (e.type === 'revealed' && byActive) {
        if (cur) cur.reveals.push(e.card);
        if (e.card) secondary.reveals.push(e.card);
      } else if (e.type === 'blocked') {
        // blocage de l'attaque courante par le défenseur
        if (cur && e.player === defender && e.cards) e.cards.forEach(c => cur.blocks.push(c));
      } else if (e.type === 'combatResult') {
        if (cur) cur.result = { hit: !!e.hit, amount: e.amount || 0 };
      } else if (e.type === 'chainLinkResolved') {
        close();
      } else if (!cur) {
        // hors passe d'armes : action non-combat de l'adversaire (soin, carte jouée…)
        if (e.type === 'lifeGained' && e.player === defender && e.amount) oppResponses.push({ icon: '❤️', text: '+' + e.amount + ' pv' });
        else if ((e.type === 'played' || e.type === 'activated') && e.player === defender) oppResponses.push({ icon: e.type === 'played' ? '▶️' : '✨', text: e.type === 'played' ? 'joue' : 'active', card: e.card });
        else if (e.type === 'discarded' && e.player === defender) oppResponses.push({ icon: '🗑️', text: 'défausse', card: e.card });
      }
    });
    close();
    return { exchanges, oppResponses, secondary };
  }

  // Vignette de carte pour le fil (image résolue en async, repli sur le nom).
  function makeMini(card, sideCls) {
    const d = document.createElement('div');
    d.className = 'rex-mini ' + sideCls;
    d.innerHTML = '<div class="art shimmer"><span class="fb">' + escapeHtml(card) + '</span></div>';
    const art = d.querySelector('.art');
    resolveCardImage(card).then(url => { art.classList.remove('shimmer'); if (url) art.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(card) + '" loading="lazy">'; });
    return d;
  }

  // Une passe est « porteuse » si elle a un résultat de combat, un blocage ou
  // une réponse adverse. Les autres (jouées sans effet capté) sont neutres.
  function isMeaningful(ex) { return !!ex.result || ex.blocks.length > 0 || (ex.defense && ex.defense.length > 0); }

  // Réactions défensives hors blocage, dédoublonnées et sans les cartes déjà
  // listées comme blocage (une carte peut apparaître dans les deux flux du log).
  function defenseCards(ex) {
    const blockSet = new Set(ex.blocks || []);
    const seen = new Set(), out = [];
    (ex.defense || []).forEach(d => {
      if (!d.card || blockSet.has(d.card) || seen.has(d.card)) return;
      seen.add(d.card); out.push(d);
    });
    return out;
  }

  // Classe le résultat d'une passe → badge + type visuel. On s'appuie
  // uniquement sur les signaux fiables du log (combatResult + blocages) ; les
  // dégâts arcaniques ne sont pas attribués par carte (source ambiguë), mais le
  // total du tour reste exact dans le bandeau (damageToOpp/Me).
  function exchangeVerdict(ex, defender) {
    const dmgToMe = defender === myName;   // les dégâts vont-ils à moi ?
    const r = ex.result, amount = r ? r.amount : 0;
    const hasDef = defenseCards(ex).length > 0;
    if (r && r.hit && amount > 0) {
      const label = (ex.blocks.length || hasDef) ? (amount + ' ' + (amount > 1 ? 'passent' : 'passe')) : (amount + ' ' + (amount > 1 ? 'dégâts' : 'dégât'));
      return { kind: 'hit', badge: '💥 ' + label, cls: dmgToMe ? 'taken' : 'hit', amount };
    }
    if (ex.blocks.length) return { kind: 'blocked', badge: '🛡 Bloqué · 0', cls: 'blk' };
    // Attaque neutralisée sans blocage : prévention (sort/effet) de l'adversaire.
    if (hasDef && r) return { kind: 'prevented', badge: '🌀 Prévenu · 0', cls: 'arc' };
    if (r) return { kind: 'noeffect', badge: 'Aucun dégât', cls: 'blk' };
    if (hasDef) return { kind: 'prevented', badge: '🌀 Prévenu', cls: 'arc' };
    return { kind: 'action', badge: 'joué', cls: 'blk' };
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function buildExchange(ex, active, defender) {
    const v = exchangeVerdict(ex, defender);
    const mine = active === myName;
    const div = document.createElement('div');
    div.className = 'rexch ' + v.kind + (mine ? ' side-me' : ' side-opp') + (v.kind === 'hit' && !ex.blocks.length ? ' big' : '');

    let verb, vIcon;
    if (v.kind === 'action') { verb = 'action'; vIcon = '▸'; }
    else if (ex.isActivation) { verb = 'activation'; vIcon = '✨'; }
    else { verb = 'attaque'; vIcon = '⚔'; }
    const who = mine ? ('Ton ' + verb) : (cap(verb) + ' de ' + escapeHtml(active));

    const head = document.createElement('div');
    head.className = 'ehead';
    head.innerHTML = '<div class="eside">' + vIcon + ' ' + who + '</div>'
      + (v.badge ? '<div class="eres ' + v.cls + '">' + v.badge + '</div>' : '');
    div.appendChild(head);

    // Carte de l'attaquant + méta (arsenal / mode / pitch / révélations)
    const cardrow = document.createElement('div');
    cardrow.className = 'ecard';
    cardrow.appendChild(makeMini(ex.card, mine ? 'me' : 'opp'));
    const meta = document.createElement('div');
    meta.className = 'emeta';
    const subs = [];
    if (ex.fromArsenal) subs.push('depuis l\'<b>arsenal</b>');
    if (ex.mode) subs.push('🔀 mode : <b>' + escapeHtml(ex.mode) + '</b>');
    if (ex.pitchCost.length) subs.push('🔥 pitch <b>' + ex.pitchCost.map(escapeHtml).join(', ') + '</b>');
    ex.reveals.forEach(c => subs.push('👁 révèle <b>' + escapeHtml(c) + '</b>'));
    meta.innerHTML = '<div class="ecn">' + escapeHtml(ex.card) + '</div>'
      + (subs.length ? '<div class="esub">' + subs.join(' · ') + '</div>' : '');
    cardrow.appendChild(meta);
    div.appendChild(cardrow);

    // Réponse de l'adversaire : blocage(s) et/ou prévention (carte jouée/activée).
    const defSide = defender === myName ? 'me' : 'opp';
    const defWho = defender === myName ? 'Tu' : escapeHtml(defender);
    if (ex.blocks.length) {
      const d2 = document.createElement('div');
      d2.className = 'ediv';
      d2.innerHTML = '<span>🛡 ' + defWho + ' ' + (defender === myName ? 'bloques' : 'bloque') + '</span>';
      div.appendChild(d2);
      const resp = document.createElement('div');
      resp.className = 'eresp';
      ex.blocks.forEach(c => resp.appendChild(makeMini(c, defSide)));
      const note = document.createElement('div');
      note.className = 'ecn';
      note.textContent = ex.blocks.length + (ex.blocks.length > 1 ? ' cartes en blocage' : ' carte en blocage');
      resp.appendChild(note);
      div.appendChild(resp);
    }
    const defs = defenseCards(ex);
    if (defs.length) {
      const verbP = v.kind === 'prevented' ? (defender === myName ? 'préviens' : 'prévient') : (defender === myName ? 'réponds' : 'répond');
      const d2 = document.createElement('div');
      d2.className = 'ediv prev';
      d2.innerHTML = '<span>🌀 ' + defWho + ' ' + verbP + '</span>';
      div.appendChild(d2);
      const resp = document.createElement('div');
      resp.className = 'eresp';
      defs.forEach(d => resp.appendChild(makeMini(d.card, defSide)));
      div.appendChild(resp);
    }
    if (!ex.blocks.length && !defs.length && v.kind === 'hit') {
      const note = document.createElement('div');
      note.className = 'enote';
      note.innerHTML = '🚀 Non bloqué — ' + (v.amount > 1 ? 'les ' + v.amount + ' dégâts passent' : 'le dégât passe');
      div.appendChild(note);
    }
    return div;
  }

  function buildTurnSummary(t, active) {
    const mine = active === myName;
    const nLabel = t.turnNumber === 0 ? 'Ouverture' : 'Tour ' + t.turnNumber;
    const kind = mine ? '⚔ Ton tour' : (active ? '🛡 Tour adverse' : '⚑ Ouverture');
    const dur = t.durationSec != null ? root.TalisharParser.formatDuration(t.durationSec) : null;
    const dealt = t.damageToOpp || 0, taken = t.damageToMe || 0;
    const div = document.createElement('div');
    div.className = 'rturn-sum' + (mine ? '' : ' opp');
    div.innerHTML =
      '<div class="top">'
        + '<div class="who"><span class="n">' + nLabel + '</span>'
        + '<span class="kind ' + (mine ? 'me' : 'opp') + '">' + kind + '</span>'
        + (active ? ' · <span class="pn">' + escapeHtml(active) + '</span>' : '') + '</div>'
        + (dur ? '<div class="dur">⏱ ' + dur + '</div>' : '')
      + '</div>'
      + '<div class="pills">'
        + '<div class="pill dealt">⚔ <span class="lbl">Infligé</span> <b>' + dealt + '</b></div>'
        + '<div class="pill taken">🩸 <span class="lbl">Subi</span> <b>' + taken + '</b></div>'
      + '</div>';
    return div;
  }

  // Bande main/arsenal repliée (juste au-dessus du fil).
  function buildHoldBar(t) {
    const hand = reconcileCertain(t.hand, t, 'hand');
    const arsenal = reconcileCertain(t.arsenal, t, 'arsenal');
    const handN = t.hand === null ? '—' : hand.length;
    const arsN = t.arsenal === null ? '—' : arsenal.length;
    const det = document.createElement('details');
    det.className = 'rhold';
    const sum = document.createElement('summary');
    sum.innerHTML = '<span class="chev">▸</span>'
      + '<span class="lbl">✋ Ta main en début de tour <b>' + handN + '</b> · 🎴 Arsenal <b>' + arsN + '</b></span>'
      + '<span class="hint">déplier</span>';
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'rhold-body';
    const section = (title, list, raw) => {
      const h = document.createElement('div'); h.className = 'rhold-sec';
      h.textContent = title + (raw === null ? ' — non capturé' : list.length ? ' (' + list.length + ')' : ' — vide');
      body.appendChild(h);
      if (list.length) {
        const scroll = document.createElement('div'); scroll.className = 'board-scroll';
        list.forEach(c => { const chip = makeCardChip(c, 'play', false); chip.classList.add('captured'); const tg = chip.querySelector('.tag'); if (tg) tg.remove(); scroll.appendChild(chip); });
        body.appendChild(scroll);
      }
    };
    section('✋ Main', hand, t.hand);
    section('🎴 Arsenal', arsenal, t.arsenal);
    det.appendChild(body);
    return det;
  }

  function buildSecondary(sec) {
    const parts = ['<span class="chip">🔥 Pitch <b>' + sec.pitch + '</b></span>'];
    if (sec.activate) parts.push('<span class="chip">✨ Activé <b>' + sec.activate + '</b></span>');
    const reveals = Array.from(new Set(sec.reveals));
    if (reveals.length) parts.push('<span class="chip">👁 Révélé <b>' + reveals.map(escapeHtml).join(', ') + '</b></span>');
    const modes = Array.from(new Set(sec.modes));
    if (modes.length) parts.push('<span class="chip">🔀 Mode <b>' + modes.map(escapeHtml).join(', ') + '</b></span>');
    const div = document.createElement('div');
    div.className = 'rex-minor';
    div.innerHTML = parts.join('');
    return div;
  }

  function buildOppResponses(list, defender) {
    if (!list.length) return null;
    const div = document.createElement('div');
    div.className = 'rex-oppresp';
    const items = list.map(r => '<span class="orsp">' + r.icon + ' ' + escapeHtml(r.text) + (r.card ? ' <b>' + escapeHtml(r.card) + '</b>' : '') + '</span>').join('');
    div.innerHTML = '<div class="orsp-h">🩹 ' + escapeHtml(defender) + (defender === myName ? ' (toi)' : '') + ' — hors combat</div>'
      + '<div class="orsp-list">' + items + '</div>';
    return div;
  }

  function renderTurnBoard(t) {
    const wrap = $('#turnBoard');
    wrap.innerHTML = '';

    const active = activePlayerOf(t);
    const defender = active === myName ? oppName : myName;

    wrap.appendChild(buildTurnSummary(t, active));
    wrap.appendChild(buildHoldBar(t));

    const { exchanges, oppResponses, secondary } = groupTurn(t, active, defender);

    // Dédoublonnage : une carte jouée puis activée (ex. Path of Same Ends) crée
    // une passe « creuse » (sans résultat) suivie d'une passe porteuse. On retire
    // la creuse dès qu'une autre passe de la même carte porte un vrai résultat.
    const withEffect = new Set(exchanges.filter(isMeaningful).map(ex => ex.card));
    const shown = exchanges.filter(ex => isMeaningful(ex) || !withEffect.has(ex.card));

    if (shown.length) {
      const lbl = document.createElement('div');
      lbl.className = 'rex-grouplbl';
      lbl.textContent = 'Déroulé de l’échange';
      wrap.appendChild(lbl);
      shown.forEach(ex => wrap.appendChild(buildExchange(ex, active, defender)));
    } else {
      const none = document.createElement('div');
      none.className = 'rex-none';
      none.textContent = 'Aucune action de combat captée pour ce tour.';
      wrap.appendChild(none);
    }

    const opp = buildOppResponses(oppResponses, defender);
    if (opp) wrap.appendChild(opp);
    wrap.appendChild(buildSecondary(secondary));

    // Déductions certaines : arsenal de l'adversaire remonté depuis un tour futur.
    const ghosts = (ARSENAL_BACKFILL[currentTurnIndex] && ARSENAL_BACKFILL[currentTurnIndex][oppName]) || [];
    if (ghosts.length) {
      const note = document.createElement('div');
      note.className = 'rex-ghosts';
      note.innerHTML = '<div class="orsp-h">🔮 ' + escapeHtml(oppName) + ' tenait en arsenal (révélé plus tard)</div>';
      const scroll = document.createElement('div');
      scroll.className = 'board-scroll';
      ghosts.forEach(g => scroll.appendChild(makeGhostChip(g.card, g.revealedLabel)));
      note.appendChild(scroll);
      wrap.appendChild(note);
    }

    // Détail technique (toggle) : fil brut chronologique complet, non regroupé.
    if (showTechnical) {
      const head = document.createElement('div');
      head.className = 'rex-grouplbl tech';
      head.textContent = '🔧 Détail technique (chronologique)';
      wrap.appendChild(head);
      const box = document.createElement('div');
      box.className = 'rex-tech';
      t.events.filter(passesFilter).forEach(e => box.appendChild(buildEventRow(e)));
      wrap.appendChild(box);
    }
  }

  async function renderKnownCards() {
    const body = $('#knownCardsBody');
    const requestToken = ++renderKnownCards._token;
    const cumulative = { [myName]: [], [oppName]: [] };
    const seen = { [myName]: new Set(), [oppName]: new Set() };

    for (let ti = 0; ti <= currentTurnIndex; ti++) {
      const byPlayer = extractTurnCards(GAME.turns[ti]);
      [myName, oppName].forEach(player => {
        (byPlayer[player] || []).forEach(({ card, action }) => {
          if (!seen[player].has(card)) { seen[player].add(card); cumulative[player].push({ card, action }); }
        });
      });
    }

    body.innerHTML = '<div class="board-empty">Identification des équipements…</div>';
    const metaFor = {};
    const allCards = [...cumulative[myName], ...cumulative[oppName]].map(c => c.card);
    await Promise.all(allCards.map(async c => { metaFor[c] = await resolveCardMeta(c); }));
    if (requestToken !== renderKnownCards._token) return;

    body.innerHTML = '';
    // L'équipement en jeu est déjà affiché dans la bannière du match → on ne
    // garde ici que les AUTRES cartes vues (non-équipement), pour chaque joueur.
    [[myName, 'me'], [oppName, 'opp']].forEach(([player, side]) => {
      const list = cumulative[player];
      const other = list.filter(c => !(metaFor[c.card] && metaFor[c.card].isEquipment));
      const color = side === 'me' ? 'var(--gold)' : 'var(--violet)';

      const otherBlock = document.createElement('div');
      otherBlock.className = 'known-block';
      otherBlock.innerHTML = `<div class="who" style="color:${color}">${player}${side === 'me' ? ' (toi)' : ''} — cartes vues (${other.length})</div>`;
      const otherGrid = document.createElement('div'); otherGrid.className = 'known-grid';
      if (!other.length) otherGrid.innerHTML = '<div class="board-empty">Aucune carte vue pour l\'instant</div>';
      else other.forEach(({ card, action }) => otherGrid.appendChild(makeCardChip(card, action, true)));
      otherBlock.appendChild(otherGrid);
      body.appendChild(otherBlock);
    });
  }
  renderKnownCards._token = 0;

  function buildEventRow(e) {
    const info = eventLine(e);
    const row = document.createElement('div');
    row.className = 'event' + (info.secondary ? ' secondary' : '');

    // Ordre : icône → cartes → texte (tout centré verticalement, cf. CSS).
    const ic = document.createElement('div');
    ic.className = 'ev-icon';
    ic.textContent = info.icon || '•';
    row.appendChild(ic);

    // Miniatures de TOUTES les cartes de l'événement (ex. blocage multi-cartes).
    const cards = (info.cards || []).filter(Boolean);
    if (cards.length) {
      const thumbs = document.createElement('div');
      thumbs.className = 'ev-thumbs';
      cards.forEach(name => {
        const th = document.createElement('div');
        th.className = 'ev-thumb';
        th.title = name;
        const fb = document.createElement('span');
        fb.className = 'ev-thumb-fb';
        fb.textContent = name;
        th.appendChild(fb);
        thumbs.appendChild(th);
        resolveCardImage(name).then(url => { if (url) th.innerHTML = `<img src="${url}" alt="${name}" loading="lazy">`; });
      });
      row.appendChild(thumbs);
    }

    const txt = document.createElement('div');
    txt.className = 'ev-txt';
    txt.innerHTML = info.text || '';
    row.appendChild(txt);
    return row;
  }

  function passesFilter(e) {
    const info = eventLine(e);
    if (!showTechnical && (info.secondary || !PRIMARY_TYPES.has(e.type)) && !['played', 'pitched', 'activated', 'blocked', 'discarded', 'damageTaken', 'lifeGained', 'modeSelected', 'goAgain', 'undo', 'conceded', 'gameWon', 'combatResult'].includes(e.type)) {
      return false;
    }
    return true;
  }

  function renderTurn() {
    const t = GAME.turns[currentTurnIndex];
    // Le bandeau résumé porte désormais le libellé riche du tour ; ici on ne
    // garde qu'un compteur de position discret à côté des flèches.
    $('#turnLabel').textContent = (currentTurnIndex + 1) + ' / ' + GAME.turns.length;
    $('#prevTurn').disabled = currentTurnIndex === 0;
    $('#nextTurn').disabled = currentTurnIndex === GAME.turns.length - 1;

    renderTurnBoard(t);

    renderCurve();
    renderKnownCards();
  }

  function renderChainActive() { renderChain(); const active = document.querySelector('.link.active'); if (active && typeof active.scrollIntoView === 'function') { try { active.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' }); } catch (e) {} } }

  // ---- Helpers graphes pour les stats ----
  // Barres groupées (ex. menacé/infligé/subi par tour)
  function svgGroupedBars(rows, series) {
    const W = 400, H = 150, padL = 22, padR = 6, padTop = 10, padBot = 20;
    const plotW = W - padL - padR, plotH = H - padTop - padBot, n = rows.length || 1;
    let max = 1; rows.forEach(r => series.forEach(s => { if ((r[s.key] || 0) > max) max = r[s.key] || 0; }));
    const groupW = plotW / n, barW = Math.min(9, (groupW - 2) / series.length);
    const y = v => padTop + plotH - (Math.max(0, v || 0) / max) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    [0, Math.round(max / 2), max].forEach(v => { svg += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#262c3d"/><text x="${padL - 3}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${v}</text>`; });
    rows.forEach((r, i) => {
      const cx = padL + groupW * i + groupW / 2, totalW = barW * series.length + (series.length - 1);
      series.forEach((s, j) => {
        const val = r[s.key] || 0, x = cx - totalW / 2 + j * (barW + 1);
        svg += `<rect x="${x.toFixed(1)}" y="${y(val).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padTop + plotH - y(val)).toFixed(1)}" fill="${s.color}" rx="1"/>`;
      });
      svg += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${r.turn}</text>`;
    });
    return svg + '</svg>';
  }
  // Barres de tempo : durée par tour, couleur par côté, plus long en rouge
  function svgTempoBars(turns) {
    const rows = turns.filter(t => t.durationSec != null && t.turnNumber > 0);
    if (!rows.length) return null;
    const accent = accentColor();
    const W = 400, H = 150, padL = 26, padR = 6, padTop = 12, padBot = 20;
    const plotW = W - padL - padR, plotH = H - padTop - padBot, n = rows.length;
    let max = 1; rows.forEach(t => { if (t.durationSec > max) max = t.durationSec; });
    const groupW = plotW / n, barW = Math.min(16, groupW * 0.62);
    const y = v => padTop + plotH - (v / max) * plotH;
    const maxIdx = rows.reduce((mi, t, i, a) => t.durationSec > a[mi].durationSec ? i : mi, 0);
    const fmt = s => { const m = Math.floor(s / 60), ss = s % 60; return m ? m + 'm' + String(ss).padStart(2, '0') : s + 's'; };
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    [0, Math.round(max / 2), max].forEach(v => { svg += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#262c3d"/><text x="${padL - 3}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${fmt(v)}</text>`; });
    rows.forEach((t, i) => {
      const cx = padL + groupW * i + groupW / 2, x = cx - barW / 2;
      const col = i === maxIdx ? '#e0555a' : (t.side === 'me' ? accent : '#8b6bff');
      svg += `<rect x="${x.toFixed(1)}" y="${y(t.durationSec).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padTop + plotH - y(t.durationSec)).toFixed(1)}" fill="${col}" rx="1.5"/>`;
      svg += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${t.turnNumber}</text>`;
    });
    return svg + '</svg>';
  }
  // Barres de comparaison toi vs adversaire
  function cmpBars(me, opp) {
    const rows = [['Dégâts infligés', 'dealt'], ['Menace totale', 'threatened'], ['Dégâts bloqués', 'blocked'], ['Vie gagnée', 'lifeGained']];
    return rows.map(([lbl, key]) => {
      const mv = me.totals[key] || 0, ov = opp.totals[key] || 0, mx = Math.max(1, mv, ov);
      const bar = (v, cls) => `<div class="cmp-bar ${cls}" style="width:${(v / mx * 100).toFixed(1)}%"><span class="n ${v / mx < 0.28 ? 'out' : ''}">${v}</span></div>`;
      return `<div class="cmp-row"><div class="lbl">${lbl}</div><div class="bars">${bar(mv, 'me')}${bar(ov, 'opp')}</div></div>`;
    }).join('');
  }
  function cardTableHtml(cards) {
    const top = cards.filter(c => c.played || c.blocked || c.pitched || c.timesHit).sort((a, b) => b.played - a.played).slice(0, 14);
    return '<table class="off-table"><tr><th>Carte</th><th>Jouée</th>'
      + '<th title="Fois où la carte a été utilisée pour bloquer (défense)">En défense</th>'
      + '<th>Pitch</th>'
      + '<th title="Fois où la carte a porté un coup (attaque non bloquée)">Coups portés</th></tr>'
      + top.map(c => '<tr><td>' + c.name + '</td>'
        + '<td>' + (c.played || '<span class="muted">·</span>') + '</td>'
        + '<td>' + (c.blocked || '<span class="muted">·</span>') + '</td>'
        + '<td>' + (c.pitched || '<span class="muted">·</span>') + '</td>'
        + '<td class="' + (c.timesHit ? 'hit' : 'muted') + '">' + (c.timesHit || '·') + '</td></tr>').join('')
      + '</table>';
  }

  // Courbe lissée (Catmull-Rom → Bézier) passant par les points.
  let _lcSeq = 0;
  function lcSmooth(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return 'M' + pts[0].x.toFixed(1) + ',' + pts[0].y.toFixed(1);
    let d = 'M' + pts[0].x.toFixed(1) + ',' + pts[0].y.toFixed(1);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) + ' ' + p2.x.toFixed(1) + ',' + p2.y.toFixed(1);
    }
    return d;
  }

  // Graphe en courbe(s) lissée(s) avec infobulle au survol/tap (façon Talishar).
  // cfg = { title, turns:[n], series:[{label,color,values:[n]}], showAvg }
  function buildLineChart(cfg) {
    const W = 400, H = 172, padL = 28, padR = 12, padTop = 16, padBot = 22;
    const plotW = W - padL - padR, plotH = H - padTop - padBot, n = cfg.turns.length;
    let max = 0;
    cfg.series.forEach(s => s.values.forEach(v => { if (v > max) max = v; }));
    max = Math.max(6, Math.ceil(max / 6) * 6);
    const X = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const Y = v => padTop + plotH - (Math.max(0, v) / max) * plotH;
    const uid = 'lc' + (++_lcSeq);

    let grid = '';
    [0, max / 2, max].forEach(v => {
      grid += '<line x1="' + padL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(v).toFixed(1) + '" stroke="#262c3d" stroke-dasharray="2,4"/>'
        + '<text x="' + (padL - 4) + '" y="' + (Y(v) + 3).toFixed(1) + '" text-anchor="end" font-family="\'JetBrains Mono\',monospace" font-size="8" fill="#565b6e">' + Math.round(v) + '</text>';
    });
    let xlabels = '';
    cfg.turns.forEach((t, i) => { xlabels += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-family="\'JetBrains Mono\',monospace" font-size="8" fill="#565b6e">' + t + '</text>'; });

    let defs = '', areas = '', lines = '', dots = '', his = '';
    cfg.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => ({ x: X(i), y: Y(v) }));
      const line = lcSmooth(pts);
      const area = line + ' L' + X(n - 1).toFixed(1) + ',' + Y(0).toFixed(1) + ' L' + X(0).toFixed(1) + ',' + Y(0).toFixed(1) + ' Z';
      defs += '<linearGradient id="' + uid + 'g' + si + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + s.color + '" stop-opacity=".28"/><stop offset="100%" stop-color="' + s.color + '" stop-opacity="0"/></linearGradient>';
      areas += '<path d="' + area + '" fill="url(#' + uid + 'g' + si + ')"/>';
      lines += '<path d="' + line + '" fill="none" stroke="' + s.color + '" stroke-width="2.2"/>';
      dots += pts.map(p => '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="1.8" fill="' + s.color + '"/>').join('');
      his += '<circle class="lc-hi" cx="0" cy="0" r="3.4" fill="' + s.color + '" stroke="#e9e6da" stroke-width="1" style="opacity:0"/>';
    });

    let avgEl = '';
    if (cfg.showAvg) {
      const vals = cfg.series[0].values;
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      avgEl = '<line x1="' + padL + '" y1="' + Y(avg).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(avg).toFixed(1) + '" stroke="rgba(233,230,218,.35)" stroke-dasharray="4,4"/>'
        + '<text x="' + (padL + 3) + '" y="' + (Y(avg) - 3).toFixed(1) + '" font-family="\'JetBrains Mono\',monospace" font-size="8" fill="#8b8fa3">moy ' + Math.round(avg) + '</text>';
    }

    const legend = cfg.series.length > 1
      ? '<div class="off-legend">' + cfg.series.map(s => '<span><span class="dot" style="background:' + s.color + '"></span>' + s.label + '</span>').join('') + '</div>' : '';

    const wrap = document.createElement('div');
    wrap.className = 'off-chart lc';
    wrap.innerHTML = '<h4>' + escapeHtml(cfg.title) + '</h4><div class="lc-holder"><svg viewBox="0 0 ' + W + ' ' + H + '"><defs>' + defs + '</defs>'
      + grid + avgEl + areas + lines + dots
      + '<line class="lc-guide" x1="0" y1="' + padTop + '" x2="0" y2="' + (padTop + plotH) + '" style="opacity:0"/>' + his + xlabels
      + '</svg><div class="lc-tip"></div></div>' + legend;

    const svg = wrap.querySelector('svg'), tip = wrap.querySelector('.lc-tip');
    const guide = wrap.querySelector('.lc-guide'), hi = [].slice.call(wrap.querySelectorAll('.lc-hi'));
    const show = idx => {
      const gx = X(idx);
      guide.setAttribute('x1', gx.toFixed(1)); guide.setAttribute('x2', gx.toFixed(1)); guide.style.opacity = 1;
      let topY = plotH + padTop;
      cfg.series.forEach((s, si) => { const y = Y(s.values[idx]); hi[si].setAttribute('cx', gx.toFixed(1)); hi[si].setAttribute('cy', y.toFixed(1)); hi[si].style.opacity = 1; if (y < topY) topY = y; });
      tip.innerHTML = '<div class="lc-turn">Tour ' + cfg.turns[idx] + '</div>' + cfg.series.map(s => '<div class="lc-row" style="color:' + s.color + '">' + escapeHtml(s.label) + ' : <b>' + s.values[idx] + '</b></div>').join('');
      const r = svg.getBoundingClientRect();
      tip.style.left = (gx / W * r.width) + 'px';
      tip.style.top = (topY / H * r.height) + 'px';
      tip.classList.toggle('flip', gx > W * 0.62);
      tip.style.opacity = 1;
    };
    const hide = () => { tip.style.opacity = 0; guide.style.opacity = 0; hi.forEach(h => h.style.opacity = 0); };
    const move = e => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const cx = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * W;
      let idx = Math.round((cx - padL) / plotW * (n - 1));
      show(Math.max(0, Math.min(n - 1, idx)));
    };
    const holder = wrap.querySelector('.lc-holder');
    holder.addEventListener('pointermove', move);
    holder.addEventListener('pointerdown', move);
    holder.addEventListener('pointerleave', hide);
    return wrap;
  }

  // Dégâts RÉELS depuis la courbe de vie (fiable, contrairement au
  // totalDamageDealt de Talishar qui sous-compte l'arcanique). Pour une
  // partie perdue/gagnée par mort, la vie finale du perdant vaut 0 ; pour un
  // abandon, on garde la vie réelle au moment de l'abandon.
  function realDamage() {
    const ls = GAME.lifeSeries || { me: [], opp: [] };
    const meStart = (GAME.players.me && GAME.players.me.startLife) || ls.me[0] || 0;
    const oppStart = (GAME.players.opp && GAME.players.opp.startLife) || ls.opp[0] || 0;
    let meEnd = ls.me.length ? ls.me[ls.me.length - 1] : meStart;
    let oppEnd = ls.opp.length ? ls.opp[ls.opp.length - 1] : oppStart;
    if (GAME.result && !GAME.result.byConcession) {
      if (GAME.result.iWon === true) oppEnd = 0;
      else if (GAME.result.iWon === false) meEnd = 0;
    }
    return {
      dealt: Math.max(0, oppStart - Math.max(0, oppEnd)),
      taken: Math.max(0, meStart - Math.max(0, meEnd))
    };
  }

  function renderStats() {
    const grid = $('#statGrid');
    const wrap = $('#statsWrap');
    const off = GAME.endStats && GAME.endStats.me;

    const extra = wrap.querySelector('#offExtra');
    if (extra) extra.remove();

    if (off) {
      wrap.querySelector('h3').textContent = 'Stats de la partie';
      const num = v => (v == null ? '—' : v);
      const rd = realDamage();

      // Efficacité hors tour létal : part de la menace réellement infligée, en
      // excluant le dernier tour (souvent la charge létale qui gonfle la menace).
      let eff = '—';
      if (off.turns && off.turns.length) {
        const maxT = Math.max.apply(null, off.turns.map(t => t.turn));
        const dec = off.turns.filter(t => t.turn < maxT);
        const dSum = dec.reduce((a, t) => a + (t.dealt || 0), 0);
        const tSum = dec.reduce((a, t) => a + (t.threatened || 0), 0);
        if (tSum) eff = Math.round(dSum / tSum * 100) + '%';
      }

      const cards = [
        [rd.dealt, 'Dégâts infligés (réel)', 'gold', 'Vie perdue par l’adversaire — source fiable (courbe de vie).'],
        [rd.taken, 'Dégâts subis (réel)', 'red', 'Ta vie perdue — source fiable (courbe de vie).'],
        [num(off.totals.dealt), 'Dégâts infligés (combat)', '', 'Stat de combat de Talishar : ne compte pas tout (ex. dégâts arcaniques).'],
        [num(off.totals.threatened), 'Menace totale', 'violet', 'Dégâts POTENTIELS de tes attaques, avant blocage.'],
        [eff, 'Efficacité (hors tour létal)', 'gold', 'Part de ta menace réellement infligée, dernier tour exclu.'],
        [num(off.totals.blocked), 'Dégâts bloqués', 'green', 'Dégâts que tu as bloqués (défense au combat).'],
        [num(off.totals.prevented), 'Dégâts prévenus', 'green', 'Dégâts annulés par prévention (ex. arcanique), hors blocage.'],
        [num(off.totals.lifeGained), 'Vie gagnée', 'green'],
        [num(off.averages.dealtPerTurn), 'Combat infligé / tour', ''],
        [num(off.averages.threatenedPerTurn), 'Menace / tour', 'violet'],
        [num(off.averages.threatenedPerCard), 'Menace / carte', 'violet'],
        [num(off.averages.value), 'Valeur / tour', '', 'Indice composite de Talishar (menace + défense + tempo…).'],
        [num(off.averages.combatPerTurn), 'Valeur combat / tour', '', 'Indice de combat composite de Talishar.'],
        [num(off.averages.resourcesPerTurn), 'Ressources / tour', '', 'Pitch moyen utilisé par tour.'],
      ];
      grid.innerHTML = cards.map(([v, k, c, t]) => `<div class="stat-card"${t ? ` title="${escapeHtml(t)}"` : ''}><div class="v mono ${c}">${v}</div><div class="k">${k}</div></div>`).join('');

      const box = document.createElement('div');
      box.id = 'offExtra';
      let html = '<div class="off-note">Les chiffres <b>« (réel) »</b> viennent de la courbe de vie. Les autres sont ceux de <b>Talishar</b> — « Dégâts infligés (combat) » = combat seul, hors arcanique. Survole une carte pour le détail.</div>';

      // Graphes par tour façon Talishar (montés ensuite car interactifs) :
      // « Valeur par tour » et « Échange de pression » (Menacé vs Subi).
      html += '<div id="offCharts"></div>';

      // POINT 3 — tempo : durée de chaque tour (depuis les timestamps du log)
      const accent = accentColor();
      const tempo = svgTempoBars(GAME.turns);
      if (tempo) {
        html += '<div class="off-chart"><h4>Tempo — durée de chaque tour</h4>' + tempo
          + '<div class="off-legend">'
          + '<span><span class="dot" style="background:' + accent + '"></span>Ton tour</span>'
          + '<span><span class="dot" style="background:#8b6bff"></span>Tour adverse</span>'
          + '<span><span class="dot" style="background:#e0555a"></span>Le plus long</span></div>'
          + '<div class="off-note" style="margin-top:6px">Temps réel écoulé par tour (inclut les réactions de l\'adversaire).</div></div>';
      }

      // POINT 2 — comparaison toi vs adversaire (si dispo via swap)
      const opp = GAME.endStats.opp;
      if (opp) {
        html += '<div class="off-chart"><h4>Toi vs adversaire</h4>' + cmpBars(off, opp)
          + '<div class="off-legend">'
          + '<span><span class="dot" style="background:' + accent + '"></span>Toi</span>'
          + '<span><span class="dot" style="background:#8b6bff"></span>Adversaire</span></div></div>';
      }

      // Tableau des cartes (toi)
      if (off.cards && off.cards.length) html += '<h4 style="font-family:\'Cinzel\',serif;font-size:.8rem;color:var(--text-dim);margin:16px 0 4px;font-weight:600">Tes cartes</h4>' + cardTableHtml(off.cards);
      box.innerHTML = html;
      wrap.appendChild(box);

      // Montage des graphes interactifs par tour (façon Talishar).
      const mount = box.querySelector('#offCharts');
      if (mount && off.turns && off.turns.length) {
        const turns = off.turns.map(t => t.turn);
        mount.appendChild(buildLineChart({
          title: 'Valeur par tour', turns, showAvg: true,
          series: [{ label: 'Valeur', color: accent, values: off.turns.map(t => (t.threatened || 0) + (t.blocked || 0) + (t.prevented || 0) + (t.lifeGained || 0)) }]
        }));
        mount.appendChild(buildLineChart({
          title: 'Échange de pression', turns, showAvg: false,
          series: [
            { label: 'Menacé', color: accent, values: off.turns.map(t => t.threatened || 0) },
            { label: 'Subi', color: '#e0555a', values: off.turns.map(t => t.taken || 0) }
          ]
        }));
      }

      // Bloc adverse détaillé (grille + cartes) si dispo
      if (opp) {
        let oh = '<h3 style="margin-top:20px">Adversaire — stats officielles</h3>'
          + '<div class="off-note">Capturées grâce à « Switch Player Stats ».</div>';
        const num2 = v => (v == null ? '—' : v);
        const rd2 = realDamage();   // du point de vue adverse : infligé = ta vie perdue
        const ocards = [
          [rd2.taken, 'Dégâts infligés (réel)', 'gold', 'Ta vie perdue — source fiable (courbe de vie).'],
          [rd2.dealt, 'Dégâts subis (réel)', 'red', 'Vie perdue par l’adversaire — source fiable (courbe de vie).'],
          [num2(opp.totals.dealt), 'Dégâts infligés (combat)', '', 'Stat de combat de Talishar : hors arcanique.'],
          [num2(opp.totals.threatened), 'Menace totale', 'violet'],
          [num2(opp.totals.blocked), 'Dégâts bloqués', 'green'],
        ];
        oh += '<div class="stat-grid">' + ocards.map(([v, k, c, t]) => `<div class="stat-card"${t ? ` title="${escapeHtml(t)}"` : ''}><div class="v mono ${c}">${v}</div><div class="k">${k}</div></div>`).join('') + '</div>';
        if (opp.cards && opp.cards.length) oh += cardTableHtml(opp.cards);
        const holder = document.createElement('div');
        holder.innerHTML = oh;
        box.appendChild(holder);
      }
      return;
    }

    // Repli : stats reconstruites depuis le log (si pas de bloc officiel)
    wrap.querySelector('h3').textContent = 'Stats de la partie';
    const s = GAME.stats;
    const cards = [
      [s.damageDealt, 'Dégâts infligés'],
      [s.damageTaken, 'Dégâts encaissés'],
      [s.blocks, 'Blocages effectués'],
      [s.pitches, 'Cartes pitchées'],
      [s.myTurns, 'Tes tours'],
      [s.distinctCards, 'Cartes distinctes vues'],
    ];
    grid.innerHTML = cards.map(([v, k]) => `<div class="stat-card"><div class="v mono">${v}</div><div class="k">${k}</div></div>`).join('');
  }

  root.Replay = { show, reset, getGame: () => GAME };
})(typeof self !== 'undefined' ? self : this);
