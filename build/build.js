/* ============================================================
 * Build optionnel — régénère une version FICHIER UNIQUE
 * (build/standalone.html) à partir de index.html + des modules.
 * ------------------------------------------------------------
 * Utile pour un usage hors-ligne rapide (ouvrir un seul .html).
 * NB : la persistance multi-parties (IndexedDB) reste fiable
 * surtout sur l'origine stable de GitHub Pages ; en file://, le
 * standalone sert surtout au replay d'un log collé/importé.
 *
 * Lancement : `node build/build.js` (ou `npm run build`).
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const css = read('css/style.css');
const scripts = ['talishar-parser.js', 'js/images.js', 'js/db.js', 'js/sync.js', 'js/replay.js', 'js/dashboard.js']
  .map(f => '<script>\n' + read(f) + '\n</script>').join('\n');

let html = read('index.html');
// Remplace le <link> CSS par un <style> inliné (tolère un ?v=… de cache-bust).
html = html.replace(/<link rel="stylesheet" href="css\/style\.css[^"]*">/, '<style>\n' + css + '\n</style>');
// Remplace le bloc des <script src> par les scripts inlinés (tolère ?v=…).
html = html.replace(
  /<!-- Modules partagés[\s\S]*?<script src="js\/dashboard\.js[^"]*"><\/script>/,
  '<!-- Modules inlinés (build fichier-unique) -->\n' + scripts
);

const out = path.join(ROOT, 'build', 'standalone.html');
fs.writeFileSync(out, html, 'utf8');
console.log('build/standalone.html régénéré (' + Math.round(html.length / 1024) + ' Ko)');
