/* ============================================================
 * Résolution d'images de cartes (goagain.dev) — module partagé
 * ------------------------------------------------------------
 * Extrait du viewer standalone (inchangé sur le fond). Utilisé à
 * la fois par le replay (visuels de cartes/héros/équipement) et
 * par le dashboard (avatars de héros des matchups).
 *
 * Cache local (localStorage) pour ne pas re-questionner l'API à
 * chaque rendu — les métadonnées d'une carte ne changent pas.
 * ============================================================ */
(function (root) {
  'use strict';

  const cardMetaCache = (function () {
    try { return JSON.parse(localStorage.getItem('fabCardMetaCacheV2') || '{}'); }
    catch (e) { return {}; }
  })();
  function saveMetaCache() {
    try { localStorage.setItem('fabCardMetaCacheV2', JSON.stringify(cardMetaCache)); } catch (e) {}
  }

  function findImageUrl(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 5) return null;
    if (typeof obj === 'string') {
      if (/^https?:\/\//.test(obj) && /\.(png|jpe?g|webp|avif)(\?.*)?$/i.test(obj)) return obj;
      return null;
    }
    if (Array.isArray(obj)) { for (const it of obj) { const r = findImageUrl(it, depth + 1); if (r) return r; } return null; }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      const priority = keys.filter(k => /image|img|art|photo|picture|thumbnail/i.test(k));
      for (const k of priority) { const r = findImageUrl(obj[k], depth + 1); if (r) return r; }
      for (const k of keys) { if (priority.includes(k)) continue; const r = findImageUrl(obj[k], depth + 1); if (r) return r; }
    }
    return null;
  }

  // Cherche l'image FULL ART des Marvel : c'est la face « _BACK » d'une
  // impression « -MV » (ex. ROS254-MV_BACK.png), la pleine illustration sans
  // cadre. On accepte aussi le tag art_variations « FA » quand il est présent.
  function findFullArtImageUrl(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 6) return null;
    if (Array.isArray(obj)) {
      for (const it of obj) { const r = findFullArtImageUrl(it, depth + 1); if (r) return r; }
      return null;
    }
    if (typeof obj === 'object') {
      const av = obj.art_variations;
      const isFA = Array.isArray(av) && av.some(v => /^fa$|full/i.test(String(v)));
      const url = obj.image_url || obj.image || null;
      if (typeof url === 'string') {
        const file = url.split('/').pop() || '';
        // La pleine illustration est la FACE ARRIÈRE (_BACK) d'une Marvel (-MV).
        // NB : sur les sets récents (OMN), l'avant ET l'arrière sont tagués FA,
        // et l'avant vient en premier — on exige donc explicitement « _BACK ».
        if (/_BACK/i.test(file) && (/-MV/i.test(file) || isFA)) return url;
      }
      for (const k of Object.keys(obj)) { const r = findFullArtImageUrl(obj[k], depth + 1); if (r) return r; }
    }
    return null;
  }

  // Cherche l'image de la version « Marvel » (full-art premium). Sur le CDN
  // fabmaster, ces impressions ont un nom de fichier suffixé « -MV » (ex.
  // ROS254-MV.png) ; on écarte les dos de carte (« _BACK »). Renvoie la 1re
  // face avant Marvel trouvée, sinon null.
  function findMarvelImageUrl(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 6) return null;
    if (Array.isArray(obj)) {
      for (const it of obj) { const r = findMarvelImageUrl(it, depth + 1); if (r) return r; }
      return null;
    }
    if (typeof obj === 'object') {
      const url = obj.image_url || obj.image || null;
      if (typeof url === 'string') {
        const file = url.split('/').pop() || '';
        if (/-MV(\.|_|$)/i.test(file) && !/_BACK/i.test(file)) return url;   // face avant Marvel
      }
      for (const k of Object.keys(obj)) { const r = findMarvelImageUrl(obj[k], depth + 1); if (r) return r; }
    }
    return null;
  }

  const EQUIPMENT_RE = /\bequipment\b|\bhead\b|\bchest\b|\barms?\b|\blegs?\b|\boff-?hand\b|\bweapon\b/i;
  function findCardTypeInfo(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 5) return { isEquipment: false, label: null };
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      const typeKeys = Object.keys(obj).filter(k => /^(type|types|category|categories|class|classes|slot)$/i.test(k));
      for (const k of typeKeys) {
        const v = obj[k];
        const asText = Array.isArray(v) ? v.join(' ') : String(v || '');
        if (EQUIPMENT_RE.test(asText)) return { isEquipment: true, label: asText };
      }
      for (const k of Object.keys(obj)) {
        if (typeKeys.includes(k)) continue;
        const r = findCardTypeInfo(obj[k], depth + 1);
        if (r.isEquipment) return r;
      }
    }
    if (Array.isArray(obj)) { for (const it of obj) { const r = findCardTypeInfo(it, depth + 1); if (r.isEquipment) return r; } }
    return { isEquipment: false, label: null };
  }

  async function resolveCardMeta(name) {
    if (!name) return { image: null, isEquipment: false };
    if (cardMetaCache[name]) return cardMetaCache[name];
    const strip = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');   // ignore ponctuation/espaces/casse
    const target = strip(name);
    const query = async q => {
      try {
        const res = await fetch('https://api.goagain.dev/v1/cards?name=' + encodeURIComponent(q) + '&limit=15');
        if (!res.ok) return [];
        const json = await res.json();
        return json.data || json.cards || json.results || [];
      } catch (e) { return []; }
    };
    const exact = list => list.find(c => strip(c.name) === target) || null;   // ponctuation ignorée
    try {
      // Le grabber perd parfois la ponctuation du nom (« Fyendal's Spring Tunic »
      // stocké « Fyendals Spring Tunic », « Scorpio, Comet Tail » → « Scorpio
      // Comet Tail »). On cherche donc une correspondance EXACTE (ponctuation
      // ignorée) via plusieurs requêtes : nom brut, variante possessive (apostrophe
      // restituée), puis 1er mot seul. On n'accepte JAMAIS une carte proche mais
      // différente : mieux vaut pas d'image qu'une mauvaise.
      const firstList = await query(name);
      let best = exact(firstList);
      if (!best) {
        const variants = [];
        const poss = name.replace(/^(\S+?)s(\b)/, "$1's$2");     // Fyendals → Fyendal's
        if (poss !== name) variants.push(poss);
        const base = name.split(/[\s,]+/)[0];                     // Scorpio, Volzar, Fyendal…
        if (base && strip(base) !== target) variants.push(base);
        for (const v of variants) { best = exact(await query(v)); if (best) break; }
      }
      // Dernier recours seulement si aucune correspondance exacte : 1re carte avec image.
      if (!best) best = firstList.find(c => findImageUrl(c)) || firstList[0] || null;
      const image = best ? findImageUrl(best) : null;
      const typeInfo = best ? findCardTypeInfo(best) : { isEquipment: false, label: null };
      const meta = { image: image || null, isEquipment: typeInfo.isEquipment, typeLabel: typeInfo.label };
      cardMetaCache[name] = meta;
      saveMetaCache();
      return meta;
    } catch (e) {
      console.warn('[images] métadonnées introuvables pour', name, e);
      const meta = { image: null, isEquipment: false, typeLabel: null };
      cardMetaCache[name] = meta;
      saveMetaCache();
      return meta;
    }
  }
  async function resolveCardImage(name) { return (await resolveCardMeta(name)).image; }

  // Image de héros pour le carrousel/avatars : privilégie la version « Marvel »
  // (full-art) si l'API en renvoie une, sinon l'illustration standard. Cache dédié.
  // Version de cache : à bumper quand la logique de choix d'image héros change,
  // pour invalider les entrées mémorisées dans le navigateur.
  const HERO_IMG_CACHE_V = 'fa5';
  const stripName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');   // ignore ponctuation/espaces/casse
  async function resolveHeroCardImage(name) {
    if (!name) return null;
    const key = 'H:' + HERO_IMG_CACHE_V + ':' + name;
    if (cardMetaCache[key]) return cardMetaCache[key].image;
    try {
      // On requête sur le NOM DE BASE (1er mot) : plus fiable que le nom complet
      // qui peut différer (« Kayo Underhanded Cheat » vs « Kayo, Underhanded Cheat »).
      const base = name.split(/[\s,]+/)[0] || name;
      const res = await fetch('https://api.goagain.dev/v1/cards?name=' + encodeURIComponent(base) + '&limit=20');
      if (!res.ok) throw new Error('http ' + res.status);
      const json = await res.json();
      const list = (json.data || json.cards || json.results || []).filter(c => (c.types || []).indexOf('Hero') >= 0 || !c.types);
      const target = stripName(name);
      // Correspondance en ignorant la ponctuation ; sinon préfixe ; sinon 1re carte.
      const best = list.find(c => stripName(c.name) === target)
        || list.find(c => stripName(c.name).indexOf(target) === 0 || target.indexOf(stripName(c.name)) === 0)
        || list[0] || null;
      // Priorité : full art (face _BACK des Marvel) → face Marvel → illustration normale.
      const image = (best && (findFullArtImageUrl(best) || findMarvelImageUrl(best))) || (best ? findImageUrl(best) : null);
      cardMetaCache[key] = { image: image || null };
      saveMetaCache();
      return image || null;
    } catch (e) {
      return resolveCardImage(name);   // repli : illustration standard
    }
  }

  // ============================================================
  // Couleur d'accent par héros (pour le theming du tableau de bord)
  // ------------------------------------------------------------
  // Stratégie : extraction de la teinte dominante de l'illustration
  // via <canvas> (bornée en HSL pour rester lisible), avec repli
  // déterministe sur une teinte dérivée du nom si l'extraction échoue
  // (image absente ou canvas « tainted » faute de CORS). Mise en cache
  // dans localStorage, comme les métadonnées de cartes.
  // ============================================================
  const heroColorCache = (function () {
    try { return JSON.parse(localStorage.getItem('fabHeroColorV1') || '{}'); }
    catch (e) { return {}; }
  })();
  function saveHeroColorCache() {
    try { localStorage.setItem('fabHeroColorV1', JSON.stringify(heroColorCache)); } catch (e) {}
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s, l];
  }
  function hslToHex(h, s, l) {
    h /= 360;
    const f = n => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  // Borne saturation/luminosité pour garantir un accent lisible sur fond sombre.
  function clampAccent(h, s, l) {
    return hslToHex(h, Math.min(0.78, Math.max(0.42, s)), Math.min(0.64, Math.max(0.5, l)));
  }
  // Table héros → couleur d'accent (fait AUTORITÉ). Choisie d'après l'identité
  // visuelle de chaque héros/classe. Clé = fragment en minuscules cherché dans
  // le nom du héros (« Briar, Warden of Thorns » → « briar »). Facile à ajuster :
  // change simplement la valeur hex correspondante.
  const HERO_COLORS = {
    // Runeblade (terre / arcane)
    briar: '#46b56a', verdance: '#57c06f', viserai: '#8b6bff', chane: '#7d5cc4',
    // Draconic / élémentaire tempête
    aurora: '#57b6ef', dromai: '#c93b3b',
    // Wizard
    kano: '#d6483c', iyslander: '#74cdeb',
    // Illusionist
    prism: '#e2cf7e', enigma: '#9b7bff', dana: '#e0b24a',
    // Assassin
    uzuri: '#a566cc', arakni: '#7a8098', nuu: '#c2415f',
    // Ninja
    fai: '#e65a34', katsu: '#dd5560', zen: '#45bcae', benji: '#e5843f', ira: '#e6546a',
    // Brute
    kayo: '#cf7a3a', rhinar: '#bf7a34',
    // Guardian
    oldhim: '#5fa6a8', bravo: '#8894ac',
    // Warrior
    dorinthea: '#d6b84f', boltyn: '#eccf5f', victor: '#d6c452',
    // Ranger
    azalea: '#cf6152', lexi: '#4fb6c9',
    // Mechanologist
    dash: '#cf9440', maxx: '#e6b13f', teklovossen: '#45ad93',
    // Pugilist / autres
    betsy: '#d6a03f', florian: '#5cbf6e', oscilio: '#63aede'
  };
  function lookupHeroColor(name) {
    const n = String(name || '').toLowerCase();
    for (const k in HERO_COLORS) { if (n.indexOf(k) >= 0) return HERO_COLORS[k]; }
    return null;
  }
  // Couleur immédiate (synchrone) : table si connue, sinon repli déterministe.
  function heroColorSync(name) { return lookupHeroColor(name) || fallbackColor(name); }

  // Repli déterministe : teinte dérivée du nom (stable, distincte par héros).
  function fallbackColor(name) {
    let hash = 0;
    const str = String(name || '');
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    const hue = ((hash % 360) + 360) % 360;
    return clampAccent(hue, 0.55, 0.56);
  }
  function extractDominant(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const S = 24;
          const cv = document.createElement('canvas');
          cv.width = S; cv.height = S;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, S, S);
          const data = ctx.getImageData(0, 0, S, S).data;   // lève une erreur si canvas « tainted »
          let r = 0, g = 0, b = 0, wsum = 0;
          for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3]; if (a < 200) continue;
            const [, sat, lum] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
            if (lum < 0.12 || lum > 0.9) continue;           // ignore quasi-noir / quasi-blanc
            const w = sat * sat + 0.05;                       // privilégie les pixels vifs
            r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; wsum += w;
          }
          if (!wsum) return reject(new Error('no vivid pixels'));
          const [h, s, l] = rgbToHsl(r / wsum, g / wsum, b / wsum);
          resolve(clampAccent(h, s, l));
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('image load error'));
      img.src = url;
    });
  }
  async function resolveHeroColor(name) {
    if (!name) return fallbackColor(name);
    const tbl = lookupHeroColor(name);           // la table fait autorité
    if (tbl) return tbl;
    if (heroColorCache[name]) return heroColorCache[name];
    let color;
    try {
      const url = await resolveCardImage(name);
      color = url ? await extractDominant(url) : fallbackColor(name);
    } catch (e) {
      color = fallbackColor(name);
    }
    heroColorCache[name] = color;
    saveHeroColorCache();
    return color;
  }

  root.CardImages = { resolveCardMeta, resolveCardImage, resolveHeroCardImage, findImageUrl, findMarvelImageUrl, findFullArtImageUrl, findCardTypeInfo, resolveHeroColor, heroColorSync, lookupHeroColor, fallbackColor };
})(typeof self !== 'undefined' ? self : this);
