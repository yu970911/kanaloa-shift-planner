// シフト表を1枚の画像（PNG）にする。
// 掲示・LINE共有用なので、画面のテーマに関係なく明るい配色で、表を横スクロールせず全日を1枚に収める。
import { PATTERNS, PATTERN_CODES, OFF_SYMBOLS, DOW_LABELS } from './model.js';
import { isWorkSymbol } from './solver.js';

const C = {
  page: '#ffffff', head: '#f8f9fa', line: '#e4e7ea', line2: '#eef0f2',
  ink: '#1f242a', ink2: '#555d66', muted: '#8d949c',
  sun: '#a8564c', sat: '#3d6a94',
  bad: '#a8564c', badBg: '#f7ecea', warn: '#a87a35', warnBg: '#f7f1e4',
  groupLine: '#c9cfd5',
};
// パターンの色（styles.css のライト配色と同じ）
const P = {
  A: ['#eceff4', '#4a6285'], B: ['#eceff4', '#4a6285'],
  C: ['#f4eef2', '#7d5a6e'], E: ['#f4eef2', '#7d5a6e'],
  D: ['#f6f1e7', '#8f6c33'], G: ['#f6f1e7', '#8f6c33'],
  F: ['#f7f1e4', '#a87a35'], H: ['#ebf2ee', '#417a61'],
};

const JP = '"Zen Kaku Gothic New", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';
const NUM = '"Archivo", "Zen Kaku Gothic New", sans-serif';

/** 画面で使っているWebフォントの読み込みを待つ（待たないと代わりの書体で描かれる） */
async function fontsReady() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`700 16px ${JP}`), document.fonts.load(`400 12px ${JP}`),
      document.fonts.load(`700 16px ${NUM}`),
    ]);
    await document.fonts.ready;
  } catch (e) { /* 読めなくても代わりの書体で描く */ }
}

/**
 * @param {object} p
 * @param {number} p.year
 * @param {number} p.month
 * @param {object[]} p.days     buildDays の結果
 * @param {object[]} p.members  表に出すスタッフ
 * @param {object} p.grid       { [memberId]: { [day]: 記号 } }
 * @param {object[]} p.dayStats validate の dayStats
 * @param {string} [p.note]     右上に小さく出す文言
 * @param {string} [p.title]    見出し（省略すると「◯年◯月 シフト表」。前半・後半のときは期間を入れる）
 * @returns {Promise<Blob>}
 */
export async function renderShiftImage({ year, month, days, members, grid, dayStats, note = '', title = '' }) {
  await fontsReady();

  const S = 2;                       // 解像度（2倍で描いて縮小表示でもにじまないように）
  const pad = 32;
  const colK = 46, colN = 150, colW = 44, dayW = 38;
  const rowH = 30, headH = 58, footH = 26, titleH = 74;
  const left = colK + colN + colW;
  const tableW = left + days.length * dayW;
  const legendItems = [
    ...PATTERN_CODES.map((c) => ({ code: c, text: `${PATTERNS[c].time}（${PATTERNS[c].hours}h）` })),
    ...Object.entries(OFF_SYMBOLS).map(([k, v]) => ({ code: k, text: v.label })),
  ];

  // 凡例の折り返しを先に計算して、画像の高さを決める
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `400 12px ${JP}`;
  const legendRows = [];
  let row = [], x = 0;
  for (const it of legendItems) {
    const w = 24 + 6 + probe.measureText(it.text).width + 20;
    if (x + w > tableW && row.length) { legendRows.push(row); row = []; x = 0; }
    row.push({ ...it, w }); x += w;
  }
  if (row.length) legendRows.push(row);
  const legendH = legendRows.length * 30 + 10;

  const W = pad * 2 + tableW;
  const H = pad + titleH + headH + members.length * rowH + footH * 2 + 18 + legendH + pad;

  const canvas = document.createElement('canvas');
  canvas.width = W * S; canvas.height = H * S;
  const g = canvas.getContext('2d');
  g.scale(S, S);
  g.textBaseline = 'middle';
  g.fillStyle = C.page;
  g.fillRect(0, 0, W, H);

  const text = (s, x, y, { size = 12, weight = 400, color = C.ink, align = 'left', font = JP } = {}) => {
    g.font = `${weight} ${size}px ${font}`;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  };
  const hline = (x1, x2, y, color = C.line2, w = 1) => { g.fillStyle = color; g.fillRect(x1, Math.round(y), x2 - x1, w); };
  const vline = (x, y1, y2, color = C.line2) => { g.fillStyle = color; g.fillRect(Math.round(x), y1, 1, y2 - y1); };

  // ---- 見出し ----
  const X = pad;
  let Y = pad;
  text(title || `${year}年${month}月 シフト表`, X, Y + 18, { size: 26, weight: 700 });
  text('ホテルかなろあ', X, Y + 50, { size: 13, color: C.ink2 });
  const now = new Date();
  const stamp = `作成 ${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  text(stamp, X + tableW, Y + 18, { size: 12, color: C.muted, align: 'right' });
  if (note) text(note, X + tableW, Y + 50, { size: 12, color: C.bad, weight: 700, align: 'right' });
  Y += titleH;

  const tableTop = Y;
  const bodyTop = tableTop + headH;
  const bodyBottom = bodyTop + members.length * rowH;
  const footBottom = bodyBottom + footH * 2;

  // ---- 土日の帯（表の下地） ----
  days.forEach((d, i) => {
    if (d.dow !== 0 && d.dow !== 6) return;
    g.fillStyle = d.dow === 0 ? 'rgba(168,86,76,0.05)' : 'rgba(61,106,148,0.05)';
    g.fillRect(X + left + i * dayW, tableTop, dayW, footBottom - tableTop);
  });

  // ---- ヘッダ ----
  g.fillStyle = C.head;
  g.fillRect(X, tableTop, left, headH);
  text('区分', X + 8, tableTop + headH / 2, { size: 10.5, weight: 700, color: C.muted });
  text('名前', X + colK + 8, tableTop + headH / 2, { size: 10.5, weight: 700, color: C.muted });
  text('出勤', X + colK + colN + colW / 2, tableTop + headH / 2, { size: 10.5, weight: 700, color: C.muted, align: 'center' });
  days.forEach((d, i) => {
    const cx = X + left + i * dayW + dayW / 2;
    const dowColor = d.dow === 0 ? C.sun : d.dow === 6 ? C.sat : C.muted;
    text(String(d.day), cx, tableTop + 16, { size: 15, weight: 700, font: NUM, align: 'center' });
    text(DOW_LABELS[d.dow], cx, tableTop + 34, { size: 11, weight: 700, color: dowColor, align: 'center' });
    text(d.closed ? '休館' : `${d.rooms}室`, cx, tableTop + 49, { size: 9.5, color: C.muted, align: 'center' });
  });
  hline(X, X + tableW, tableTop + headH, C.line);

  // ---- 本体 ----
  let prevGroup = null;
  members.forEach((m, r) => {
    const y = bodyTop + r * rowH;
    const group = (m.roles || [])[0] || '';
    if (prevGroup !== null && group !== prevGroup) hline(X, X + tableW, y - 1, C.groupLine, 2);
    prevGroup = group;

    text(m.kubun || '', X + 8, y + rowH / 2, { size: 10.5, color: C.muted });
    text(m.name, X + colK + 8, y + rowH / 2, { size: 12.5, weight: 700 });

    let work = 0;
    days.forEach((d, i) => {
      const v = grid[m.id] ? grid[m.id][d.day] : '';
      const cx = X + left + i * dayW;
      const worked = isWorkSymbol(v) || (m.mode === 'always' && v === '');
      if (worked) work++;
      if (PATTERNS[v]) {
        g.fillStyle = P[v][0];
        g.fillRect(cx + 2, y + 3, dayW - 4, rowH - 6);
        text(v, cx + dayW / 2, y + rowH / 2 + 0.5, { size: 13, weight: 700, color: P[v][1], font: NUM, align: 'center' });
      } else if (v === '休') {
        text('休', cx + dayW / 2, y + rowH / 2, { size: 11.5, color: C.muted, align: 'center' });
      } else if (v === '特') {
        g.fillStyle = C.warnBg; g.fillRect(cx + 2, y + 3, dayW - 4, rowH - 6);
        text('特', cx + dayW / 2, y + rowH / 2, { size: 12, weight: 700, color: C.warn, align: 'center' });
      } else if (v === '✖') {
        g.fillStyle = C.badBg; g.fillRect(cx + 2, y + 3, dayW - 4, rowH - 6);
        text('✖', cx + dayW / 2, y + rowH / 2, { size: 12, weight: 700, color: C.bad, align: 'center' });
      } else if (v) {
        text(v, cx + dayW / 2, y + rowH / 2, { size: 12, weight: 700, color: C.ink2, align: 'center' });
      }
    });
    text(m.mode === 'manual' ? '—' : String(work), X + colK + colN + colW / 2, y + rowH / 2, { size: 13, weight: 700, font: NUM, align: 'center' });
    hline(X, X + tableW, y + rowH, C.line2);
  });

  // ---- 集計行 ----
  const foot = [
    ['必要人数', (ds) => [String(ds.required), false]],
    ['入っている人数', (ds) => [String(ds.filled), ds.filled < ds.required]],
  ];
  foot.forEach(([label, fn], k) => {
    const y = bodyBottom + k * footH;
    g.fillStyle = C.head;
    g.fillRect(X, y, left, footH);
    text(label, X + 8, y + footH / 2, { size: 11, weight: 700, color: C.ink2 });
    days.forEach((d, i) => {
      const ds = dayStats.find((s) => s.day === d.day);
      if (!ds) return;
      const [v, bad] = fn(ds);
      const cx = X + left + i * dayW;
      if (bad) { g.fillStyle = C.badBg; g.fillRect(cx, y, dayW, footH); }
      text(v, cx + dayW / 2, y + footH / 2, { size: 12, weight: 700, font: NUM, color: bad ? C.bad : C.ink, align: 'center' });
    });
    hline(X, X + tableW, y + footH, C.line2);
  });

  // ---- 罫線 ----
  vline(X + colK, tableTop, footBottom, C.line2);
  vline(X + colK + colN, tableTop, footBottom, C.line2);
  vline(X + left, tableTop, footBottom, C.line);
  for (let i = 1; i < days.length; i++) vline(X + left + i * dayW, tableTop, footBottom, C.line2);
  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.strokeRect(X + 0.5, tableTop + 0.5, tableW - 1, footBottom - tableTop - 1);

  // ---- 凡例 ----
  let ly = footBottom + 18;
  for (const lr of legendRows) {
    let lx = X;
    for (const it of lr) {
      const col = P[it.code];
      g.fillStyle = col ? col[0] : it.code === '特' ? C.warnBg : it.code === '✖' ? C.badBg : C.head;
      g.fillRect(lx, ly + 3, 24, 22);
      const fg = col ? col[1] : it.code === '特' ? C.warn : it.code === '✖' ? C.bad : C.ink2;
      text(it.code, lx + 12, ly + 14, { size: 12, weight: 700, color: fg, font: col ? NUM : JP, align: 'center' });
      text(it.text, lx + 30, ly + 14, { size: 12, color: C.ink2 });
      lx += it.w;
    }
    ly += 30;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/png');
  });
}
