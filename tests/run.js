/* ============================================================
 * Harnais de tests Node — SANS dépendance externe.
 * ------------------------------------------------------------
 * Vérifie :
 *   1. le parseur sur une fixture .txt fidèle au grabber ;
 *   2. le cœur d'agrégation du dashboard sur des records forgés ;
 *   3. la clé de déduplication de la couche DB.
 *
 * Lancement : `node tests/run.js` (ou `npm test`).
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { assert(a === b, msg + ' (attendu ' + JSON.stringify(b) + ', obtenu ' + JSON.stringify(a) + ')'); }

// ---------- 1. Parseur ----------
const Parser = require('../talishar-parser.js');
const raw = fs.readFileSync(path.join(__dirname, 'fixture-sample.txt'), 'utf8');
const rec = Parser.parse(raw);

console.log('Parseur —');
eq(rec.myName, 'Ehecalt', 'identité: myName');
eq(rec.oppName, 'Opponent', 'identité: oppName');
eq(rec.matchup, 'Briar vs Briar', 'matchup (miroir)');
eq(rec.format, 'blitz', 'format');
eq(rec.vsAI, false, 'vsAI');
eq(rec.source.gameId, '908070', 'gameId depuis en-tête');
assert(rec.result && rec.result.iWon === true, 'result.iWon = true');
assert(rec.result && rec.result.byConcession === true, 'result.byConcession = true (abandon)');
eq(rec.warnings.length, 0, 'aucun warning (identité cohérente)');
assert(rec.endStats && rec.endStats.me, 'endStats.me présent');
eq(rec.endStats.me.firstPlayer, true, 'endStats.me.firstPlayer');
eq(rec.endStats.me.won, true, 'endStats.me.won');
eq(rec.endStats.me.cards.length, 3, 'endStats.me.cards (3 cartes)');
assert(rec.endStats.opp && rec.endStats.opp.cards.length === 1, 'endStats.opp présent');
eq(rec.timeline.durationSec, 180, 'durée globale (timestamps)');

// Miroir : la main ne doit PAS avoir été filtrée par les cartes adverses.
const t1 = rec.turns.find(t => t.player === 'Ehecalt' && t.turnNumber === 1);
assert(t1 && Array.isArray(t1.hand) && t1.hand.indexOf('Bloodrush Bellow') >= 0, 'main tour 1 conservée (miroir)');
// Arsenal d'ouverture forcé vide (règle FaB).
eq(rec.turns[0].arsenal.length, 0, 'arsenal ouverture vide');

// ---------- 2. Agrégation dashboard ----------
const Dashboard = require('../js/dashboard.js');
console.log('Dashboard —');

function mkRec(o) {
  return {
    result: { iWon: o.iWon },
    vsAI: !!o.ai,
    format: o.format || 'blitz',
    players: { me: { hero: o.myHero || 'Briar' }, opp: { hero: o.oppHero } },
    source: { capturedAt: o.date },
    endStats: o.first == null ? null : {
      me: {
        won: o.iWon, firstPlayer: o.first,
        cards: o.cards || [],
        averages: { dealtPerTurn: o.dpt || 5, threatenedPerTurn: 7, threatenedPerCard: 2.5, value: 3 },
        totals: { dealt: o.dealt || 10, threatened: 14, blocked: 3 }
      }, opp: null
    }
  };
}
const entries = [
  { gameId: 'g1', record: mkRec({ iWon: true, oppHero: 'Dorinthea', first: true, date: '2026-07-01T10:00:00Z', cards: [{ name: 'Brutal Assault', played: 2, blocked: 0, pitched: 0, timesHit: 1 }] }) },
  { gameId: 'g2', record: mkRec({ iWon: false, oppHero: 'Dorinthea', first: false, date: '2026-07-02T10:00:00Z', cards: [{ name: 'Brutal Assault', played: 1, blocked: 1, pitched: 0, timesHit: 0 }] }) },
  { gameId: 'g3', record: mkRec({ iWon: true, oppHero: 'Briar', first: true, date: '2026-07-03T10:00:00Z' }) },
  { gameId: 'g4', record: mkRec({ iWon: true, oppHero: 'Briar', first: false, date: '2026-07-04T10:00:00Z' }) },
  { gameId: 'gAI', record: mkRec({ iWon: false, oppHero: 'Kano', first: false, date: '2026-07-05T10:00:00Z', ai: true }) }
];

// IA exclue par défaut : 4 parties, 3 victoires → 75 %.
const agg = Dashboard.aggregate(entries, {});
eq(agg.global.games, 4, 'IA exclue par défaut (4 parties)');
eq(agg.global.wins, 3, 'victoires');
eq(agg.global.winrate, 75, 'winrate global 75%');

// IA incluse : 5 parties.
eq(Dashboard.aggregate(entries, { includeAI: true }).global.games, 5, 'IA incluse (5 parties)');

// Matchup Dorinthea : 2 parties, 1 victoire → 50 %.
const dor = agg.byMatchup.find(m => m.hero === 'Dorinthea');
assert(dor && dor.games === 2 && dor.winrate === 50, 'matchup Dorinthea 1-1 (50%)');
const bri = agg.byMatchup.find(m => m.hero === 'Briar');
assert(bri && bri.games === 2 && bri.winrate === 100, 'matchup Briar 2-0 (100%)');

// 1er vs 2e joueur : 1er = g1(V) g3(V) → 100% ; 2e = g2(D) g4(V) → 50%.
eq(agg.firstSecond.first.winrate, 100, 'winrate 1er joueur');
eq(agg.firstSecond.second.winrate, 50, 'winrate 2e joueur');

// Perf cartes agrégée : Brutal Assault joué 3 fois sur 2 parties.
const ba = agg.cardPerf.find(c => c.name === 'Brutal Assault');
assert(ba && ba.played === 3 && ba.games === 2, 'carte Brutal Assault agrégée (3 joués / 2 parties)');

// Régression perf cartes : compteurs en string + doublon dans une même partie.
// - played doit être SOMMÉ numériquement (3), pas concaténé ("0010000").
// - games doit compter les PARTIES distinctes (2), pas les entrées de cartes (3).
const cardBugEntries = [
  { gameId: 'c1', record: mkRec({ iWon: true, oppHero: 'Kano', first: true, date: '2026-07-01T10:00:00Z',
      cards: [ { name: 'Quick Succession', played: '0', pitched: '1' },
               { name: 'Quick Succession', played: '1', pitched: '0' } ] }) },
  { gameId: 'c2', record: mkRec({ iWon: true, oppHero: 'Kano', first: true, date: '2026-07-02T10:00:00Z',
      cards: [ { name: 'Quick Succession', played: '2', pitched: '0' } ] }) }
];
const qs = Dashboard.aggregate(cardBugEntries, {}).cardPerf.find(c => c.name === 'Quick Succession');
eq(qs && qs.played, 3, 'perf cartes : played sommé numériquement (pas de concaténation)');
eq(qs && qs.games, 2, 'perf cartes : games = parties distinctes (pas entrées de cartes)');

// Filtre héros adverse.
eq(Dashboard.aggregate(entries, { oppHero: 'Briar' }).global.games, 2, 'filtre héros adverse');

// Filtre « mon héros » + facette myHeroes.
const meEntries = [
  { gameId: 'm1', record: mkRec({ iWon: true, myHero: 'Briar', oppHero: 'Kano', first: true, date: '2026-07-01T10:00:00Z' }) },
  { gameId: 'm2', record: mkRec({ iWon: false, myHero: 'Dorinthea', oppHero: 'Kano', first: false, date: '2026-07-02T10:00:00Z' }) }
];
const aggMe = Dashboard.aggregate(meEntries, {});
assert(aggMe.facets.myHeroes.length === 2 && aggMe.facets.myHeroes.indexOf('Dorinthea') >= 0, 'facette « mes héros » (2 valeurs)');
eq(Dashboard.aggregate(meEntries, { myHero: 'Briar' }).global.games, 1, 'filtre « mon héros »');

// Winrate par héros joué (« tes decks »).
const briHero = aggMe.byMyHero.find(h => h.hero === 'Briar');
const dorHero = aggMe.byMyHero.find(h => h.hero === 'Dorinthea');
assert(briHero && briHero.games === 1 && briHero.winrate === 100, 'byMyHero Briar 1-0 (100%)');
assert(dorHero && dorHero.games === 1 && dorHero.winrate === 0, 'byMyHero Dorinthea 0-1 (0%)');

// 1er/2e joueur détaillé par matchup : Dorinthea → g1 1er(V), g2 2e(D).
const dorMu = agg.byMatchup.find(m => m.hero === 'Dorinthea');
assert(dorMu && dorMu.first.games === 1 && dorMu.first.winrate === 100, 'byMatchup Dorinthea 1er : 1-0 (100%)');
assert(dorMu && dorMu.second.games === 1 && dorMu.second.winrate === 0, 'byMatchup Dorinthea 2e : 0-1 (0%)');
// 1er/2e par héros joué : Briar joué 4 fois → 1er g1,g3 (2-0), 2e g2,g4 (1-1 → 50%).
const briMy = agg.byMyHero.find(h => h.hero === 'Briar');
assert(briMy && briMy.first.winrate === 100 && briMy.second.winrate === 50, 'byMyHero Briar 1er 100% / 2e 50%');

// Meilleurs / pires matchups : Briar (2-0, 100%) devant Dorinthea (1-1, 50%).
// Briar 2-0 (100%) est favorable ; Dorinthea est à 50 % (ni l'un ni l'autre),
// donc « pires » est vide ici.
assert(agg.bestMatchups[0].hero === 'Briar', 'meilleur matchup = Briar (100%)');
eq(agg.worstMatchups.length, 0, 'aucun pire matchup (pas de matchup < 50%)');

// Régression : un matchup à 100 % ne doit JAMAIS apparaître dans les pires.
// Seuls > 50 % → meilleurs, < 50 % → pires ; un matchup à 50 % (Fai) n'est
// dans aucune des deux colonnes.
const bwEntries = [
  { gameId: 'w1', record: mkRec({ iWon: true,  oppHero: 'Lexi', first: true,  date: '2026-07-01T10:00:00Z' }) },
  { gameId: 'w2', record: mkRec({ iWon: true,  oppHero: 'Lexi', first: false, date: '2026-07-02T10:00:00Z' }) },
  { gameId: 'w3', record: mkRec({ iWon: false, oppHero: 'Kano', first: true,  date: '2026-07-03T10:00:00Z' }) },
  { gameId: 'w4', record: mkRec({ iWon: false, oppHero: 'Kano', first: false, date: '2026-07-04T10:00:00Z' }) },
  { gameId: 'w5', record: mkRec({ iWon: true,  oppHero: 'Fai',  first: true,  date: '2026-07-05T10:00:00Z' }) },
  { gameId: 'w6', record: mkRec({ iWon: false, oppHero: 'Fai',  first: false, date: '2026-07-06T10:00:00Z' }) }
];
const bwAgg = Dashboard.aggregate(bwEntries, {});
assert(bwAgg.bestMatchups.length === 1 && bwAgg.bestMatchups[0].hero === 'Lexi', 'meilleur = Lexi (100%)');
assert(bwAgg.worstMatchups.length === 1 && bwAgg.worstMatchups[0].hero === 'Kano', 'pire = Kano (0%)');
assert(!bwAgg.worstMatchups.some(m => m.winrate >= 50), 'aucun matchup ≥ 50% dans les pires (régression Lexi)');
assert(!bwAgg.bestMatchups.concat(bwAgg.worstMatchups).some(m => m.hero === 'Fai'), 'matchup à 50% (Fai) dans aucune colonne');

// Cartes en victoire vs défaite : Brutal Assault en V (g1) et en D (g2) → 50%.
const baWL = agg.cardWinLoss.find(c => c.name === 'Brutal Assault');
assert(baWL && baWL.gamesWon === 1 && baWL.gamesLost === 1 && baWL.winrate === 50, 'carte V/D Brutal Assault 1V/1D (50%)');

// Tendance : un point par partie décidée (4 hors IA).
eq(agg.trend.length, 4, 'tendance : 4 points');

// ---------- 3. Clé DB ----------
const DB = require('../js/db.js').FabDB;
console.log('DB —');
eq(DB.keyFor(rec, raw), '908070', 'clé DB = gameId');
eq(DB.keyFor({ source: {} }, 'abc'), DB.keyFor({ source: {} }, 'abc'), 'clé de repli déterministe');

// ---------- 4. Export / Import (sauvegarde multi-appareils) ----------
console.log('Export/Import —');
const backup = DB.buildExport([{ gameId: '908070', record: rec, raw }]);
eq(backup.kind, 'library', 'enveloppe: kind');
eq(backup.version, 1, 'enveloppe: version');
eq(backup.count, 1, 'enveloppe: count');
assert(Array.isArray(backup.games) && backup.games.length === 1, 'enveloppe: games[]');

// Réimport d'une enveloppe complète → entrée conservée telle quelle.
const roundtrip = DB.normalizeImport(backup);
eq(roundtrip.length, 1, 'normalize: enveloppe → 1 entrée');
eq(roundtrip[0].gameId, '908070', 'normalize: gameId préservé');

// Tolérance : tableau brut, entrée nue {record}, entrées invalides ignorées.
eq(DB.normalizeImport([{ gameId: 'x', record: rec }]).length, 1, 'normalize: tableau brut');
const nu = DB.normalizeImport({ record: rec, raw });
eq(nu.length, 1, 'normalize: {record} nu reconstruit');
eq(nu[0].gameId, '908070', 'normalize: gameId dérivé du record');
eq(DB.normalizeImport({ games: [{}, { foo: 1 }, null] }).length, 0, 'normalize: entrées sans record ignorées');
eq(DB.normalizeImport(null).length, 0, 'normalize: entrée nulle → []');

// ---------- 5. Couche de synchro (chargement + API) ----------
console.log('Sync —');
const Sync = require('../js/sync.js').FabSync;
['detectRepo', 'pull', 'push', 'getToken', 'setToken', 'clearToken', 'hasToken', 'canWrite', 'verifyToken']
  .forEach(fn => assert(typeof Sync[fn] === 'function', 'FabSync.' + fn + ' exposé'));

// ---------- Bilan ----------
console.log('\n' + passed + ' assertions OK, ' + failed + ' échec(s).');
process.exit(failed ? 1 : 0);
