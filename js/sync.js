/* ============================================================
 * Synchro « dépôt GitHub comme base » — sans service tiers.
 * ------------------------------------------------------------
 * Modèle : chaque déploiement (le vôtre, ou l'instance d'un autre
 * joueur créée via « Use this template ») lit/écrit dans SON PROPRE
 * dépôt, auto-détecté depuis l'URL GitHub Pages. Chacun ses données.
 *
 *   - LECTURE  : `data/library.json` est servi en statique par Pages
 *                → chargé par un simple fetch relatif, SANS token.
 *                Synchro automatique au démarrage, sur tout appareil,
 *                et partage possible par simple URL.
 *   - ÉCRITURE : à l'import d'un log, la partie est poussée dans le
 *                dépôt via l'API GitHub Contents, avec le token perso
 *                (stocké localement, saisi une fois par appareil).
 *
 * L'IndexedDB (js/db.js) reste le cache local / hors-ligne : le nuage
 * n'est qu'une couche de partage entre appareils par-dessus.
 * ============================================================ */
(function (root) {
  'use strict';

  const TOKEN_KEY = 'fabSyncToken';
  const BRANCH_KEY = 'fabSyncBranch';
  const DATA_PATH = 'data/library.json';
  const RAW_DIR = 'data/raw/';                 // dépôts bruts du grabber (Phase 3)
  const RAW_INDEX = 'data/raw/index.json';     // manifeste des .txt déposés
  const DELETED_PATH = 'data/deleted.json';    // liste PARTAGÉE des gameId supprimés (inter-appareil)
  const API = 'https://api.github.com';

  // URL du fichier de données, relative au site déployé (marche sur
  // github.io, domaine custom, ou serveur local — pas seulement Pages).
  function dataUrl() { return new URL(DATA_PATH, document.baseURI).href; }
  function rawIndexUrl() { return new URL(RAW_INDEX, document.baseURI).href; }
  function rawFileUrl(id) { return new URL(RAW_DIR + encodeURIComponent(id) + '.txt', document.baseURI).href; }
  function deletedUrl() { return new URL(DELETED_PATH, document.baseURI).href; }

  // Devine {owner, repo} depuis l'URL Pages (`<owner>.github.io/<repo>/`).
  // Retourne null hors github.io → l'écriture est alors désactivée, mais
  // la lecture (fetch relatif) continue de fonctionner.
  function detectRepo() {
    const m = String(location.hostname).match(/^([^.]+)\.github\.io$/i);
    if (!m) return null;
    const owner = m[1];
    const parts = location.pathname.split('/').filter(Boolean);
    // Page de projet : /<repo>/…  ·  Page utilisateur : repo = <owner>.github.io
    const repo = parts.length ? parts[0] : (owner + '.github.io');
    return { owner, repo };
  }

  // ---------- Token (par appareil) ----------
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; } }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, String(t).trim()); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(BRANCH_KEY); }
  function hasToken() { return !!getToken(); }
  function canWrite() { return !!detectRepo() && hasToken(); }

  function ghHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  // ---------- Lecture (sans token) ----------
  async function fetchLibrary() {
    let res;
    try { res = await fetch(dataUrl(), { cache: 'no-store' }); }
    catch (e) { return null; }            // hors-ligne / fetch impossible
    if (res.status === 404) return { games: [] };
    if (!res.ok) throw new Error('lecture data: HTTP ' + res.status);
    try { return await res.json(); } catch (e) { return { games: [] }; }
  }

  // Manifeste des logs bruts déposés par le grabber (Phase 3). Tolère un
  // tableau nu, ou une enveloppe {raw:[…]} / {games:[…]}. Absent = [].
  async function fetchRawIndex() {
    let res;
    try { res = await fetch(rawIndexUrl(), { cache: 'no-store' }); }
    catch (e) { return []; }
    if (!res.ok) return [];
    try {
      const j = await res.json();
      if (Array.isArray(j)) return j;
      return (j && (j.raw || j.games)) || [];
    } catch (e) { return []; }
  }

  // Liste partagée des suppressions (data/deleted.json). Lecture statique, sans
  // token. Tolère un tableau nu ou une enveloppe {ids:[…]}. Absent = [].
  async function fetchDeleted() {
    let res;
    try { res = await fetch(deletedUrl(), { cache: 'no-store' }); }
    catch (e) { return []; }
    if (!res.ok) return [];
    try {
      const j = await res.json();
      if (Array.isArray(j)) return j.map(String);
      return ((j && j.ids) || []).map(String);
    } catch (e) { return []; }
  }

  // Descend le nuage → n'INSÈRE que les parties absentes en local.
  // Deux sources fusionnées, dédupliquées par gameId :
  //   1. data/library.json  : entrées déjà parsées (imports viewer).
  //   2. data/raw/*.txt      : logs bruts déposés par le grabber, parsés ici
  //      (chaque brut n'est récupéré qu'une fois par appareil).
  async function pull() {
    let added = 0, removed = 0, sawData = false;

    // --- 0. Suppressions PARTAGÉES (inter-appareil) ---
    // On applique d'abord la liste du dépôt : on retire localement les parties
    // supprimées ailleurs et on les mémorise (pierre tombale) pour ne jamais les
    // ré-injecter. Fusionnée avec les suppressions locales de cet appareil.
    const remoteDead = await fetchDeleted();
    if (remoteDead.length) {
      const local0 = await root.FabDB.getAllEntries();
      const have0 = new Set(local0.map(e => String(e.gameId)));
      for (const id of remoteDead) {
        if (root.FabDB.markDeleted) root.FabDB.markDeleted(id);
        if (have0.has(String(id))) { try { await root.FabDB.removeGame(id); removed++; } catch (e) { console.error(e); } }
      }
    }
    // Ensemble « à ne jamais ré-injecter » = suppressions locales ∪ distantes.
    const dead = new Set(root.FabDB.deletedIds ? root.FabDB.deletedIds() : []);

    // --- 1. Bibliothèque parsée ---
    const lib = await fetchLibrary();
    if (lib) {
      sawData = true;
      const cloud = root.FabDB.normalizeImport(lib);
      if (cloud.length) {
        const local = await root.FabDB.getAllEntries();
        const have = new Set(local.map(e => String(e.gameId)));
        for (const e of cloud) {
          if (have.has(String(e.gameId)) || dead.has(String(e.gameId))) continue;
          try { await root.FabDB.putEntry(e); added++; } catch (err) { console.error(err); }
        }
      }
    }

    // --- 2. Logs bruts du grabber (nécessite le parseur chargé) ---
    const parser = root.TalisharParser;
    let updated = 0;
    if (parser) {
      const idx = await fetchRawIndex();
      if (idx.length) {
        sawData = true;
        const local = await root.FabDB.getAllEntries();
        // Map id → entrée : on a besoin du syncStamp local pour repérer une
        // partie corrigée en amont (même gameId, contenu du .txt différent).
        const byId = new Map(local.map(e => [String(e.gameId), e]));
        for (const it of idx) {
          const id = String((it && (it.gameId || it.id)) || it || '');
          if (!id || dead.has(id)) continue;
          const stamp = (it && it.uploadedAt) || null;   // horodatage du dépôt
          const existing = byId.get(id);
          // Déjà en local : on ne re-télécharge QUE si le dépôt annonce une
          // version plus récente que celle qu'on a stockée (uploadedAt).
          // syncStamp absent = partie stockée avant cette fonctionnalité →
          // on rafraîchit une fois pour récupérer les corrections amont.
          const isUpdate = !!existing;
          if (isUpdate && !(stamp && (!existing.syncStamp || stamp > existing.syncStamp))) continue;
          try {
            const r = await fetch(rawFileUrl(id), { cache: 'no-store' });
            if (!r.ok) continue;
            const txt = await r.text();
            const rec = parser.parse(txt);
            if (!rec || (!rec.myName && (!rec.playersList || rec.playersList.length < 2))) continue;
            const gid = String((rec.source && rec.source.gameId) || id);
            if (dead.has(gid)) continue;   // supprimée volontairement → ne pas ré-injecter
            await root.FabDB.putGame(rec, txt, { syncStamp: stamp });   // stocke le raw + l'horodatage dépôt
            byId.set(gid, { gameId: gid, syncStamp: stamp });
            if (isUpdate) updated++; else added++;
          } catch (err) { console.error(err); }
        }
      }
    }

    if (!sawData) return { added: 0, removed: removed, updated: updated, offline: true };
    return { added: added, removed: removed, updated: updated };
  }

  // ---------- Écriture (avec token) ----------
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

  async function defaultBranch(repo, token) {
    const cached = localStorage.getItem(BRANCH_KEY);
    if (cached) return cached;
    try {
      const r = await fetch(API + '/repos/' + repo.owner + '/' + repo.repo, { headers: ghHeaders(token) });
      if (r.ok) { const j = await r.json(); const b = j.default_branch || 'main'; localStorage.setItem(BRANCH_KEY, b); return b; }
    } catch (e) { /* ignore */ }
    return 'main';
  }

  // Lit l'état courant de data/library.json (contenu + sha pour l'update).
  async function readRemote(repo, token, branch) {
    const url = API + '/repos/' + repo.owner + '/' + repo.repo + '/contents/' + DATA_PATH + '?ref=' + encodeURIComponent(branch);
    const r = await fetch(url, { headers: ghHeaders(token) });
    if (r.status === 404) return { sha: null, library: { app: 'fab', kind: 'library', version: 1, games: [] } };
    if (!r.ok) throw new Error('lecture dépôt: HTTP ' + r.status);
    const j = await r.json();
    return { sha: j.sha, library: JSON.parse(base64ToUtf8(j.content)) };
  }

  // Allège l'entrée avant envoi : le `raw` (log brut) reste en local, le
  // nuage ne stocke que le record parsé + métadonnées (dépôt plus léger).
  function cloudEntry(entry) {
    const e = Object.assign({}, entry);
    delete e.raw;
    return e;
  }

  // Pousse une ou plusieurs entrées (upsert par gameId) dans le dépôt.
  // Read-modify-write avec 1 nouvelle tentative en cas de conflit (409).
  async function push(entries) {
    const repo = detectRepo();
    const token = getToken();
    if (!repo || !token) return { pushed: 0, skipped: true };
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (!list.length) return { pushed: 0 };
    const branch = await defaultBranch(repo, token);

    for (let attempt = 0; attempt < 2; attempt++) {
      const { sha, library } = await readRemote(repo, token, branch);
      const byId = new Map((library.games || []).map(g => [String(g.gameId), g]));
      for (const e of list) byId.set(String(e.gameId), cloudEntry(e));
      const next = root.FabDB.buildExport(Array.from(byId.values()));

      const body = {
        message: 'sync: +' + list.length + ' partie(s)',
        content: utf8ToBase64(JSON.stringify(next)),
        branch: branch
      };
      if (sha) body.sha = sha;

      const url = API + '/repos/' + repo.owner + '/' + repo.repo + '/contents/' + DATA_PATH;
      const r = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
      if (r.ok) return { pushed: list.length };
      if (r.status === 409 && attempt === 0) continue;   // conflit → relire et refaire
      const detail = await r.text().catch(() => '');
      throw new Error('écriture dépôt: HTTP ' + r.status + ' ' + detail.slice(0, 200));
    }
    return { pushed: 0 };
  }

  // ---------- Suppressions partagées (écriture de data/deleted.json) ----------
  function buildDeleted(ids) {
    return { app: 'fab', kind: 'deleted', version: 1, ids: Array.from(new Set(ids.map(String))) };
  }
  // Read-modify-write de data/deleted.json ; `mutate(set)` modifie l'ensemble
  // d'ids et renvoie le nouvel ensemble. 1 nouvelle tentative sur conflit 409.
  async function writeDeleted(mutate) {
    const repo = detectRepo(), token = getToken();
    if (!repo || !token) return { ok: false, skipped: true };
    const branch = await defaultBranch(repo, token);
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = API + '/repos/' + repo.owner + '/' + repo.repo + '/contents/' + DELETED_PATH;
      const r0 = await fetch(url + '?ref=' + encodeURIComponent(branch), { headers: ghHeaders(token) });
      let sha = null, cur = [];
      if (r0.ok) { const j = await r0.json(); sha = j.sha; try { const p = JSON.parse(base64ToUtf8(j.content)); cur = Array.isArray(p) ? p : (p.ids || []); } catch (e) { cur = []; } }
      else if (r0.status !== 404) throw new Error('lecture deleted: HTTP ' + r0.status);
      const next = mutate(new Set(cur.map(String)));
      const body = { message: 'sync: suppressions partagées', content: utf8ToBase64(JSON.stringify(buildDeleted(Array.from(next)))), branch: branch };
      if (sha) body.sha = sha;
      const r = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
      if (r.ok) return { ok: true };
      if (r.status === 409 && attempt === 0) continue;
      const detail = await r.text().catch(() => '');
      throw new Error('écriture deleted: HTTP ' + r.status + ' ' + detail.slice(0, 150));
    }
    return { ok: false };
  }
  async function pushDeletion(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    if (!list.length) return { ok: true };
    return writeDeleted(set => { list.forEach(id => set.add(id)); return set; });
  }
  async function pushUndelete(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    if (!list.length) return { ok: true };
    return writeDeleted(set => { list.forEach(id => set.delete(id)); return set; });
  }

  // Vérifie que le token a bien accès en écriture au dépôt détecté.
  async function verifyToken() {
    const repo = detectRepo();
    const token = getToken();
    if (!repo || !token) return { ok: false, reason: 'no-repo-or-token' };
    try {
      const r = await fetch(API + '/repos/' + repo.owner + '/' + repo.repo, { headers: ghHeaders(token) });
      if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
      const j = await r.json();
      const push = j.permissions && j.permissions.push;
      return { ok: !!push, reason: push ? 'ok' : 'lecture-seule' };
    } catch (e) { return { ok: false, reason: 'réseau' }; }
  }

  root.FabSync = {
    detectRepo, dataUrl,
    getToken, setToken, clearToken, hasToken, canWrite,
    fetchLibrary, fetchDeleted, pull, push, pushDeletion, pushUndelete, verifyToken
  };
})(typeof self !== 'undefined' ? self : this);
