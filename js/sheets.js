// Googleスプレッドシートとの連携（スプレッドシートに付けた Apps Script のウェブアプリ経由）。
// 連携先URLと合言葉は、シフトの保存データとは別に、このブラウザにだけ保存する。
// 保存データはスプレッドシートにも書き出すため、そこに合言葉が混ざらないようにしている。
import { DOW_LABELS } from './model.js';
import { isWorkSymbol } from './solver.js';

const SYNC_KEY = 'kanaloa-shift-sync-v1';
const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

export function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; }
}
/**
 * 連携の設定（ウェブアプリのURLと合言葉）を、リンク1本にまとめる／読み取る。
 * 他のパソコンでは、このリンクを開くだけで設定が入る。
 * リンクには合言葉が入るので、社内だけで共有すること。
 */
export function encodeSetup(cfg) {
  const json = JSON.stringify({ u: String(cfg.url || ''), k: String(cfg.key || '') });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeSetup(token) {
  try {
    const b64 = String(token || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || !isValidSheetUrl(obj.u) || !obj.k) return null;
    return { url: String(obj.u).trim(), key: String(obj.k) };
  } catch (e) {
    return null;
  }
}

export function saveSync(cfg) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; }
}
/** Apps Script のウェブアプリのURLだけを受け付ける（ほかの送り先にデータを送らないため） */
export const isValidSheetUrl = (u) => URL_RE.test(String(u || '').trim());
export const isSyncReady = () => {
  const c = loadSync();
  return isValidSheetUrl(c.url) && !!c.key;
};

const ERRORS = {
  key: '合言葉が違います。スクリプトの KEY と、ツールに入れた合言葉を見比べてください。',
  setup: 'スクリプトの合言葉（KEY）がまだ書き換えられていません。',
  nodata: 'スプレッドシートにまだデータがありません。先にどこかのパソコンから「スプレッドシートに反映」してください。',
  busy: 'ほかの人が書き込み中です。少し待ってからもう一度押してください。',
  action: '連携スクリプトが古いようです。最新の Code.gs を貼り直して、デプロイし直してください。',
  bad_request: '送った内容を読み取れませんでした。',
};

export async function callSheet(action, payload = {}) {
  const cfg = loadSync();
  if (!isValidSheetUrl(cfg.url)) throw new Error('連携先が設定されていません。「詳細設定 → スプレッドシート連携」でウェブアプリのURLを入れてください。');
  if (!cfg.key) throw new Error('合言葉が設定されていません。');
  let res;
  try {
    // text/plain にすると事前確認の通信が発生せず、Apps Script がそのまま受け取れる
    res = await fetch(cfg.url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, action, key: cfg.key }),
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error('スプレッドシートにつながりませんでした。ネットワークと、ウェブアプリの「アクセスできるユーザー：全員」を確認してください。');
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('スプレッドシートからの返事を読めませんでした。ウェブアプリのURL（…/exec で終わるもの）か確認してください。');
  }
  if (!json.ok) throw new Error(ERRORS[json.error] || `スプレッドシート側でエラーが出ました：${json.error}`);
  return json;
}

// スプレッドシートに書く色（ツールのライト配色と同じ）
const PAT_COLOR = {
  A: ['#eceff4', '#4a6285'], B: ['#eceff4', '#4a6285'],
  C: ['#f4eef2', '#7d5a6e'], E: ['#f4eef2', '#7d5a6e'],
  D: ['#f6f1e7', '#8f6c33'], G: ['#f6f1e7', '#8f6c33'],
  F: ['#f7f1e4', '#a87a35'], H: ['#ebf2ee', '#417a61'],
};
const HEAD_BG = '#f8f9fa';
const INK = '#1f242a', MUTED = '#8d949c';

/**
 * シフト表を、スプレッドシートに書ける形（値・背景色・文字色・太さの2次元配列）にする。
 * 列はツールの「スプレッドシートにコピー」と同じ並び（区分・名前・担当・出勤日数・日にち…）。
 */
export function buildSheetTable({ days, members, grid, dayStats }) {
  const values = [], backgrounds = [], fontColors = [], fontWeights = [];
  const push = (v, b, f, w) => { values.push(v); backgrounds.push(b); fontColors.push(f); fontWeights.push(w); };
  const n = days.length;
  const dowColor = (d) => (d.dow === 0 ? '#a8564c' : d.dow === 6 ? '#3d6a94' : MUTED);
  const dayBg = (d) => (d.dow === 0 ? '#faf1f0' : d.dow === 6 ? '#eff3f8' : '#ffffff');

  // 見出し3行：日にち／曜日／予約客室数
  push(['区分', '名前', '担当', '出勤', ...days.map((d) => String(d.day))],
    Array(4 + n).fill(HEAD_BG), ['#8d949c', '#8d949c', '#8d949c', '#8d949c', ...days.map(() => INK)], Array(4 + n).fill('bold'));
  push(['', '', '', '', ...days.map((d) => DOW_LABELS[d.dow])],
    Array(4 + n).fill(HEAD_BG), [MUTED, MUTED, MUTED, MUTED, ...days.map(dowColor)], Array(4 + n).fill('bold'));
  push(['', '', '', '', ...days.map((d) => (d.closed ? '休館' : `${d.rooms}室`))],
    Array(4 + n).fill(HEAD_BG), Array(4 + n).fill(MUTED), Array(4 + n).fill('normal'));

  const groupBreaks = [];
  let prev = null;
  members.forEach((m) => {
    const group = (m.roles || [])[0] || '';
    if (prev !== null && group !== prev) groupBreaks.push(values.length);
    prev = group;
    const cells = [], bgs = [], fcs = [], fws = [];
    let work = 0;
    for (const d of days) {
      const raw = grid[m.id] ? grid[m.id][d.day] : '';
      const v = raw === null || raw === undefined ? '' : raw;
      if (isWorkSymbol(v) || (m.mode === 'always' && v === '')) work++;
      cells.push(v);
      if (PAT_COLOR[v]) { bgs.push(PAT_COLOR[v][0]); fcs.push(PAT_COLOR[v][1]); fws.push('bold'); }
      else if (v === '特') { bgs.push('#f7f1e4'); fcs.push('#a87a35'); fws.push('bold'); }
      else if (v === '✖') { bgs.push('#f7ecea'); fcs.push('#a8564c'); fws.push('bold'); }
      else if (v === '休') { bgs.push(dayBg(d)); fcs.push(MUTED); fws.push('normal'); }
      else { bgs.push(dayBg(d)); fcs.push(INK); fws.push(v ? 'bold' : 'normal'); }
    }
    push(
      [m.kubun || '', m.name, (m.roles || []).join('/'), m.mode === 'manual' ? '—' : String(work), ...cells],
      ['#ffffff', '#ffffff', '#ffffff', '#ffffff', ...bgs],
      [MUTED, INK, MUTED, INK, ...fcs],
      ['normal', 'bold', 'normal', 'bold', ...fws],
    );
  });

  const foot = [
    ['必要人数', (ds) => [String(ds.required), false]],
    ['入っている人数', (ds) => [String(ds.filled), ds.filled < ds.required]],
  ];
  groupBreaks.push(values.length);
  for (const [label, fn] of foot) {
    const vals = [], bgs = [], fcs = [];
    for (const d of days) {
      const ds = dayStats.find((x) => x.day === d.day);
      const [v, bad] = ds ? fn(ds) : ['', false];
      vals.push(v); bgs.push(bad ? '#f7ecea' : HEAD_BG); fcs.push(bad ? '#a8564c' : INK);
    }
    push(['', label, '', '', ...vals], [HEAD_BG, HEAD_BG, HEAD_BG, HEAD_BG, ...bgs], [INK, '#555d66', INK, INK, ...fcs], Array(4 + n).fill('bold'));
  }

  return {
    values, backgrounds, fontColors, fontWeights, groupBreaks,
    headerRows: 3, frozenCols: 4, colWidths: [46, 130, 120, 44], dayColWidth: 34,
  };
}

/** 保存データのうち、スプレッドシートに預けるもの（ブラウザの一時的な表示状態は含めない） */
export function stateForSheet(state) {
  return JSON.stringify({ ...state, _savedAt: new Date().toISOString(), _version: 1 });
}
