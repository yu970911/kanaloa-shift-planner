// 1ファイル版を作る:  node build.mjs
// js/*.js と styles.css と index.html を、サーバー不要の単一HTMLにまとめます。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SRC, 'dist', 'kanaloa-shift-planner.html');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };

/* ---------- 1. JS を1本にまとめる ---------- */
const order = ['js/model.js', 'js/solver.js', 'js/period.js', 'js/importers.js', 'js/image.js', 'js/sheets.js', 'js/app.js'];
const decls = new Map();
const parts = [];
for (const f of order) {
  let code = read(f);
  code = code.replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';\s*$/gm, '');
  code = code.replace(/^export\s+(const|let|async\s+function|function|class)\s/gm, '$1 ');
  if (/^\s*(import|export)\s/m.test(code)) die('未処理の import/export が残っています: ' + f);
  for (const m of code.matchAll(/^(?:const|let|async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (decls.has(m[1])) die(`重複した名前: ${m[1]}（${decls.get(m[1])} と ${f}）`);
    decls.set(m[1], f);
  }
  parts.push(`/* ===== ${f} ===== */\n${code.trim()}`);
}
const js = parts.join('\n\n');

/* ---------- 2. CSS ----------
   styles.css 側で、閲覧者のテーマ3状態（システム設定のまま／明示的にライト／明示的にダーク）を
   すでに書き分けてあるので、ここでは素通しで埋め込む。 */
const css = read('styles.css');
for (const need of [
  '@media (prefers-color-scheme: dark)',
  ':root:not([data-theme="light"])',
  ':root[data-theme="dark"]',
]) {
  if (!css.includes(need)) die(`styles.css に ${need} がありません（テーマ切替が壊れます）`);
}

/* ---------- 3. index.html の中身を取り出す ---------- */
const html = read('index.html');
const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) die('<body> を取り出せませんでした');
const body = bodyMatch[1].replace(/<script type="module"[\s\S]*?<\/script>\s*/, '').trim();

/* ---------- 4. 1ファイルに書き出す ---------- */
// Google Fonts の読み込みタグは head から拾って残す
const fontLinks = (html.match(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g) || []).join('\n');
if (!fontLinks) die('フォントの読み込みタグが見つかりませんでした');

const out = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>かなろあシフト自動作成</title>
${fontLinks}
<style>
${css}</style>

${body}

<script type="module">
${js}
</script>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');
console.log(`書き出し: ${OUT}`);
console.log(`サイズ: ${Math.round(out.length / 1024)}KB（JS ${Math.round(js.length / 1024)}KB / CSS ${Math.round(css.length / 1024)}KB）`);
console.log(`まとめた宣言: ${decls.size}件`);
