// Googleフォームの回答CSV／予約客室数の取り込み
import { PATTERNS, patternSegments } from './model.js';

/** RFC4180 準拠のかんたんCSVパーサ（引用符・改行込みセル・BOM対応） */
export function parseCSV(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/** 全角→半角、空白除去。氏名の突き合わせ用 */
export function normalizeName(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　・,、]/g, '')
    .toLowerCase();
}

const NAME_HINTS = ['名前', '氏名', 'お名前', 'name', 'スタッフ'];
const DAY_HINTS = ['希望休', '休み', '休日', '休暇', '公休', 'off', '日にち', '日程'];
const TYPE_HINTS = ['種別', '区分', '種類'];
const SPECIAL_HINTS = ['有給', '有休', '年休', '特別休暇', '特休'];
const STREAK_HINTS = ['連休'];
const NOTE_HINTS = ['備考', '連絡', 'その他', 'コメント', '伝え', '要望'];

export function guessColumns(headers) {
  const h = headers.map((x) => String(x || '').toLowerCase());
  const has = (x, hints) => hints.some((k) => x.includes(k.toLowerCase()));
  const findIdx = (hints) => h.findIndex((x) => has(x, hints));
  const pick = (hints) => h.map((x, i) => (has(x, hints) ? i : -1)).filter((i) => i >= 0);

  // 「有給の列」「連休の列」は、希望休の列と取り違えないように先に分ける
  const specialCols = pick(SPECIAL_HINTS);
  const streakCol = findIdx(STREAK_HINTS);
  const noteCols = pick(NOTE_HINTS);
  const dayCols = pick(DAY_HINTS).filter((i) => !specialCols.includes(i) && i !== streakCol && !noteCols.includes(i));
  return { nameCol: findIdx(NAME_HINTS), dayCols, specialCols, streakCol, noteCols, typeCol: findIdx(TYPE_HINTS) };
}

/** 全角の数字・記号を半角に直す（９月３日 → 9月3日） */
export function toHalfWidth(value) {
  return String(value || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/／/g, '/').replace(/：/g, ':').replace(/，/g, ',')
    .replace(/[～∼－−‐‑]/g, '〜')   // 全角のチルダ・ハイフン類は、範囲を表す記号「〜」にそろえる
    .replace(/[⓪①②③④⑤⑥⑦⑧⑨]/g, (c) => String('⓪①②③④⑤⑥⑦⑧⑨'.indexOf(c)))
    .replace(/⑩/g, '10').replace(/⑪/g, '11').replace(/⑫/g, '12').replace(/⑬/g, '13').replace(/⑭/g, '14')
    .replace(/⑮/g, '15').replace(/⑯/g, '16').replace(/⑰/g, '17').replace(/⑱/g, '18').replace(/⑲/g, '19')
    .replace(/⑳/g, '20');
}

/**
 * 「10/9〜10/11」「10月9日〜11日」「10/15から11/15」のような、月つきの範囲を、指定の月について日にちの範囲にする。
 * 月をまたぐ範囲（10/15〜11/15）は、10月なら15日〜月末、11月なら1日〜15日。年をまたぐ（12/28〜1/3）も扱う。
 */
const MD_RANGE = /(\d{1,2})\s*[\/月.]\s*(\d{1,2})\s*日?\s*(?:[〜~\-ー–—]|から)\s*(?:(\d{1,2})\s*[\/月.]\s*)?(\d{1,2})\s*日?/g;
function mdRangeInMonth(m1, d1, m2, d2, month, daysInMonth) {
  const endM = m2 || m1;
  const endIdx = m1 > endM ? endM + 12 : endM;
  const cur = month >= m1 ? month : month + 12;
  if (cur < m1 || cur > endIdx) return null;
  const from = cur === m1 ? d1 : 1;
  const to = cur === endIdx ? d2 : daysInMonth;
  if (from > to) return null;
  return { from: Math.max(1, from), to: Math.min(daysInMonth, to) };
}

/** 「休み」「出勤」の言い回し */
const R_OFF = '(?:休み?|やすみ|お休み|オフ|off)';
const R_WORK = '(?:出勤|出社|勤務|復帰|入り)';

/**
 * 「10日まで出勤」「15日以降は休み」のような期間指定を取り出す。
 * @returns {{ranges: {from, to, why}[], rest: string}} rest は期間指定を取り除いた残り
 */
export function extractRanges(value, daysInMonth, month) {
  let t = toHalfWidth(value);
  const ranges = [];
  const eat = (re, fn) => {
    t = t.replace(re, (...a) => {
      const r = fn(...a);
      if (r) ranges.push(r);
      return ' ';
    });
  };
  const clamp = (n) => Math.max(1, Math.min(daysInMonth, n));
  const D = '(\\d{1,2})\\s*日?';

  // ⓪ 「10/15〜11/15休み」「10/9から10/11まで休み」…月が書かれている範囲（月をまたぐものも）
  if (month) {
    eat(new RegExp(MD_RANGE.source + '\\s*(?:まで|迄)?\\s*(?:は\\s*)?(?:ずっと\\s*)?' + R_OFF, 'g'), (_, a, b, c, d) => {
      const r = mdRangeInMonth(Number(a), Number(b), c ? Number(c) : 0, Number(d), month, daysInMonth);
      return r ? { from: r.from, to: r.to, why: `${a}/${b}〜${c ? c + '/' : ''}${d}は休み` } : null;
    });
  }

  // ① 「3日から7日まで休み」…両端が書かれているもの
  eat(new RegExp(D + '\\s*(?:から|〜|~|-|ー)\\s*' + D + '\\s*(?:まで|迄)?\\s*(?:は\\s*)?(?:ずっと\\s*)?' + R_OFF, 'g'),
    (_, a, b) => (Number(a) <= Number(b) ? { from: clamp(Number(a)), to: clamp(Number(b)), why: `${a}日〜${b}日は休み` } : null));

  // ② 「10日まで出勤」→ 11日以降が休み（退社・産休など）
  eat(new RegExp(D + '\\s*(?:まで|迄)\\s*(?:は\\s*)?' + R_WORK, 'g'),
    (_, a) => (Number(a) < daysInMonth ? { from: clamp(Number(a) + 1), to: daysInMonth, why: `${a}日まで出勤（それ以降は休み）` } : null));

  // ③ 「15日から出勤」→ 14日までが休み（入社・復帰など）
  eat(new RegExp(D + '\\s*(?:から|以降|より)\\s*(?:は\\s*)?' + R_WORK, 'g'),
    (_, a) => (Number(a) > 1 ? { from: 1, to: clamp(Number(a) - 1), why: `${a}日から出勤（それ以前は休み）` } : null));

  // ④ 「20日以降は休み」
  eat(new RegExp(D + '\\s*(?:から|以降|より)\\s*(?:は\\s*)?(?:ずっと\\s*)?' + R_OFF, 'g'),
    (_, a) => ({ from: clamp(Number(a)), to: daysInMonth, why: `${a}日以降は休み` }));

  // ⑤ 「10日まで休み」
  eat(new RegExp(D + '\\s*(?:まで|迄)\\s*(?:は\\s*)?(?:ずっと\\s*)?' + R_OFF, 'g'),
    (_, a) => ({ from: 1, to: clamp(Number(a)), why: `${a}日まで休み` }));

  return { ranges, rest: t };
}

/** 期間を日にちの配列に開く */
export function rangeToDays(r) {
  const out = [];
  for (let d = r.from; d <= r.to; d++) out.push(d);
  return out;
}

/**
 * 「3連休が取りたい」のような、日にちを決めない連休の希望を取り出す。
 * @returns {number} 希望する連続休日数（無ければ 0）
 */
export function extractStreakWish(value) {
  const t = toHalfWidth(value);
  let max = 0;
  for (const m of t.matchAll(/(\d{1,2})\s*(?:連休|連続\s*(?:で)?\s*(?:の)?\s*休|日\s*連続\s*(?:で)?\s*休)/g)) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 14) max = Math.max(max, n);
  }
  return max;
}

/**
 * セルの文字列から日にちを取り出す。
 * "3, 8, 15" / "3日 8日" / "9/3" / "2026/09/03" / "3(木)" / "3〜5" いずれも可
 */
export function extractDays(value, month, daysInMonth) {
  const found = new Set();
  const add = (n) => { if (n >= 1 && n <= daysInMonth) found.add(n); };

  // ① 全角・丸数字を半角に直す（９月３日 → 9月3日 / ⑩日 → 10日）
  const half = toHalfWidth(value);

  // ② 日にちではない数え方を取り除く（3連休・2日間・5名 など）
  const counted = half.replace(/\d{1,2}\s*[:：]\s*\d{2}/g, ' ').replace(/\d{1,2}\s*(?:連休|連勤|連続|日間|時間|週間|か月|ヶ月|名|人|回|泊|本|件|室)/g, ' ');

  // ③ 年を取り除く（2026/09/03 → 09/03）
  const work = counted.replace(/(?:19|20)\d{2}\s*[\/\-年.]\s*/g, '');

  // ④-0 「10/9〜10/11」「10月9日〜11日」「10/15〜11/15」のような月つきの範囲を先に拾う
  const spans0 = [];
  let m;
  const mdr = new RegExp(MD_RANGE.source, 'g');
  while ((m = mdr.exec(work)) !== null) {
    const r = mdRangeInMonth(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0, Number(m[4]), month, daysInMonth);
    if (r) for (let d = r.from; d <= r.to; d++) add(d);
    spans0.push([m.index, m.index + m[0].length]);
  }
  let work1 = '', pos0 = 0;
  for (const [s0, e0] of spans0) { work1 += work.slice(pos0, s0) + ' '; pos0 = e0; }
  work1 += work.slice(pos0);

  // ④ 「月/日」形式を拾い、拾った部分は後段から外す
  const md = /(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})\s*日?/g;
  const spans = [];
  while ((m = md.exec(work1)) !== null) {
    if (Number(m[1]) === month) add(Number(m[2]));  // 別の月の指定は拾わない
    spans.push([m.index, m.index + m[0].length]);
  }
  let rest = '', pos = 0;
  for (const [s, e] of spans) { rest += work1.slice(pos, s) + ' '; pos = e; }
  rest += work1.slice(pos);

  // ⑤ 範囲指定 3〜5 / 3-5
  const range = /(\d{1,2})\s*日?\s*(?:[〜~ー–—]|から)\s*(\d{1,2})/g;   // 3〜5 / 3-5 / 3日から5日
  while ((m = range.exec(rest)) !== null) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a <= b) for (let d = a; d <= b; d++) add(d);
  }
  rest = rest.replace(range, ' ');

  // ⑥ 残りの数値
  for (const n of rest.match(/\d{1,2}/g) || []) add(Number(n));
  return [...found].sort((a, b) => a - b);
}

/** 「特」「有給」等の記載があれば特別休暇として扱う */
export function detectSymbol(rowText) {
  const t = String(rowText || '');
  if (/特|有給|有休|年休/.test(t)) return '特';
  if (/不在|来れ|来ら|行けま|行けな|伺えま|出られ|出勤でき|欠勤|不可|×|✖|✕/.test(t)) return '✖';
  return '休';
}

/**
 * フォーム回答CSVを requests 形式に変換する。
 * 「有給・特別休暇を使いたい日」の列があればその日を特に、
 * 「連休の希望」の列があれば連休の希望として取り込む。
 * @returns {{requests, streaks, matched, unmatched, preview}}
 */
export function importFormCsv(text, { members, month, daysInMonth, nameCol, dayCols, specialCols, streakCol, noteCols, mapping = {} }) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { requests: {}, streaks: {}, matched: [], unmatched: [], preview: [], notes: [], headers: rows[0] || [] };
  const headers = rows[0];
  const guess = guessColumns(headers);
  const nc = nameCol === undefined || nameCol < 0 ? guess.nameCol : nameCol;
  const dc = dayCols && dayCols.length ? dayCols : guess.dayCols;
  const sc = specialCols === undefined ? guess.specialCols : specialCols;
  const stc = streakCol === undefined ? guess.streakCol : streakCol;
  const nts = noteCols === undefined ? guess.noteCols : noteCols;

  const byName = new Map();
  for (const m of members) byName.set(normalizeName(m.name), m);

  const requests = {};
  const streaks = {};
  const matched = [];
  const unmatched = [];
  const preview = [];
  const notes = [];

  for (const r of rows.slice(1)) {
    const rawName = nc >= 0 ? r[nc] : '';
    const key = normalizeName(rawName);
    const member = byName.get(key) || (mapping[rawName] ? members.find((m) => m.id === mapping[rawName]) : null);
    const cellText = dc.map((i) => r[i] || '').join(' ');
    const days = extractDays(cellText, month, daysInMonth);
    const specialDays = sc.length ? extractDays(sc.map((i) => r[i] || '').join(' '), month, daysInMonth) : [];
    // 有給の列か連絡事項の列があるときは、休みの列だけで判定する。
    // 連絡事項の「もう来られません」「有給で」などで、選んだ日の記号が丸ごと変わらないように。
    // （連絡事項は取り込み結果に一覧で出すので、必要なら人が直す）
    // どちらの列も無い自由な形のCSVだけ、行全体から判定する。
    const narrow = sc.length > 0 || (nts || []).length > 0;
    const sym = narrow ? detectSymbol(cellText) : detectSymbol(r.filter((_, i) => i !== nc).join(' '));
    const streak = stc >= 0 ? extractStreakWish(r[stc] || '') : 0;
    // 連絡事項の「10日まで出勤」「15日から復帰」のような期間の書き方を拾う
    const noteText = (nts || []).map((i) => r[i] || '').join(' ').trim();
    const ranges = noteText ? extractRanges(noteText, daysInMonth, month).ranges : [];
    const rangeDays = ranges.flatMap(rangeToDays);

    if (!member) {
      if (String(rawName).trim()) unmatched.push({ name: rawName, days: [...new Set([...days, ...specialDays])], sym });
      continue;
    }
    requests[member.id] = requests[member.id] || {};
    // 同じ人が複数回出したときは、後の回答が上書き
    for (const d of rangeDays) requests[member.id][d] = '休';
    for (const d of days) requests[member.id][d] = sym;
    for (const d of specialDays) requests[member.id][d] = '特';
    if (streak) streaks[member.id] = Math.max(streaks[member.id] || 0, streak);
    if (noteText) notes.push({ member, text: noteText, ranges });
    const all = [...new Set([...days, ...specialDays, ...rangeDays])].sort((a, b) => a - b);
    matched.push({ member, days: all, sym, streak, ranges });
    preview.push({ name: member.name, days: all, sym, streak, special: specialDays, ranges });
  }
  return { requests, streaks, matched, unmatched, preview, notes, headers };
}

/**
 * 予約客室数（またはねっぱんの残室数）の貼り付けを読む。
 *  ・「1日目から順に並んだ数値」（タブ/カンマ/改行/スペース区切り）
 *  ・「3\t12」「10/3 12」「10月3日(土)\t12」「2026/10/3,12」のような、日にち→数の組（1行1日）
 * startDay … 数字だけを並べて貼ったときの最初の日（後半なら16）。
 * opts.month … 日にちに月が書かれているとき、この月のものだけ読む
 * opts.periodLength … 数字だけの並びが、この期間の日数より多ければ、月の1日目からの並びとみなす
 */
export function parseRoomsInput(text, daysInMonth, startDay = 1, opts = {}) {
  return parseRoomsInputDetail(text, daysInMonth, startDay, opts).rooms;
}

/**
 * parseRoomsInput と同じ。どちらの読み方をしたか（mode: 'pairs' 日付つきの行 ／ 'sequence' 数字だけの並び）も返す。
 * 日付つきの行が2行以上あれば、その行だけを読む（見出しや合計の行、曜日などの列が混ざっていても影響しない）。
 * 日付つきの行が無いときは、数字だけを1日目から順に並べたものとして読む。
 */
export function parseRoomsInputDetail(text, daysInMonth, startDay = 1, opts = {}) {
  const src = toHalfWidth(text);
  const lines = src.trim().split(/\r?\n/).filter((l) => /\d/.test(l));
  const rooms = {};
  const PAIR = /^\s*(?:(?:19|20)\d{2}\s*[\/\-年.]\s*)?(?:(\d{1,2})\s*[\/\-月.]\s*)?(\d{1,2})\s*日?\s*(?:[(（][日月火水木金土][)）])?\s*[\t,: ]+\s*(\d{1,3})\s*室?\s*$/;
  const pairs = lines.map((l) => PAIR.exec(l)).filter(Boolean);
  if (pairs.length >= 2) {
    for (const m of pairs) {
      const d = Number(m[2]), v = Number(m[3]);
      if (m[1] && opts.month && Number(m[1]) !== opts.month) continue;   // 別の月の行は読まない
      if (d >= 1 && d <= daysInMonth) rooms[d] = v;
    }
    return { rooms, mode: 'pairs' };
  }
  const nums = src.split(/[\s,\t]+/).map((x) => x.trim()).filter((x) => x !== '' && /^\d+$/.test(x)).map(Number);
  const start = opts.periodLength && nums.length > opts.periodLength ? 1 : startDay;
  nums.slice(0, daysInMonth - start + 1).forEach((v, i) => { rooms[start + i] = v; });
  return { rooms, mode: 'sequence' };
}

/**
 * ねっぱんの残室数から、予約客室数を出す（予約客室数＝全客室数−残室数）。0〜全客室数に収める
 */
export function roomsFromVacancy(vacancy, totalRooms = 28) {
  return Object.fromEntries(Object.entries(vacancy).map(([d, v]) => [d, Math.max(0, Math.min(totalRooms, totalRooms - Number(v)))]));
}

/* ---------------- 日ごとのリクエスト ---------------- */

// 「13日は超多忙なので全員出勤」のような、日ごとの指示を読む。
// 個人の希望休は importMessages が読むので、ここでは人の名前を使わない指示だけを扱う。
const RQ_FULL = /(?:全員|みんな|総員|全スタッフ|スタッフ全員)\s*(?:で\s*)?(?:出勤|出社|出て|出られ|出る|入っ|入れ|入る|フル|体制|稼働|対応)|フル\s*出勤|フル\s*稼働|総出|全員フル/;
const RQ_CLOSED = /休館|全館\s*休|ホテル\s*(?:は\s*)?(?:お)?休み/;
const RQ_SHOP_CLOSED = /(?:焼き鳥|屋台)[^、。]*?(?:休み|休業|お休み|やらない|閉め|なし)/;
const RQ_FULLHOUSE = /満室|超満|満館/;
const RQ_ROOMS = /(\d{1,2})\s*室/;
const RQ_CLEAN = /(?:清掃|掃除)[^\d、。]{0,6}(\d{1,2})(?:\s*[〜~\-ー]\s*(\d{1,2}))?\s*(?:人|名)/;
// 枠の呼び方（ホール・フロント・送迎・焼き鳥・厨房）→ 枠のラベルに含まれる言葉
const RQ_SLOTS = [
  { say: /ホール/, label: /ホール/ },
  { say: /フロント|送迎/, label: /フロント|送迎/ },
  { say: /焼き鳥|屋台/, label: /焼き鳥/ },
  { say: /厨房|キッチン/, label: /厨房/ },
];
const COUNT_EXPR = /\d{1,2}\s*(?:[〜~\-ー]\s*\d{1,2})?\s*(?:人|名|室)/g;
// 「全員出勤ではない」「清掃は要らない」のような否定・取り消しは、間違えて反映しない
const RQ_NEG = /(?:ではない|じゃない|ではなく|じゃなく|しない|しなくて|不要|いらない|要らない|なくてい|中止|取り消|取消|やめ)/;
const RQ_MOOD = /超多忙|多忙|忙し|繁忙|お祭り|祭り|まつり|イベント|花火|連休|大会/;

function rqEffects(clause, { rules, totalRooms }) {
  const fx = [];
  const t = clause;
  if (RQ_FULL.test(t)) fx.push({ kind: 'full' });
  if (RQ_CLOSED.test(t)) fx.push({ kind: 'closed' });
  if (RQ_SHOP_CLOSED.test(t)) {
    const r = rules.find((x) => /焼き鳥/.test(x.label || ''));
    if (r) fx.push({ kind: 'slot', ruleId: r.id, label: r.label, value: 0 });
  }
  if (RQ_FULLHOUSE.test(t)) fx.push({ kind: 'rooms', value: totalRooms });
  else { const m = RQ_ROOMS.exec(t); if (m) fx.push({ kind: 'rooms', value: Math.min(totalRooms, Number(m[1])) }); }
  const c = RQ_CLEAN.exec(t);
  if (c) fx.push({ kind: 'clean', value: Number(c[2] || c[1]) });
  for (const sl of RQ_SLOTS) {
    if (sl.say.test('清掃') || /焼き鳥|屋台/.test(sl.say.source) && RQ_SHOP_CLOSED.test(t)) continue;
    const m = new RegExp('(?:' + sl.say.source + ')[^\\d、。]{0,6}(\\d{1,2})\\s*(?:人|名)').exec(t);
    const r = m && rules.find((x) => sl.label.test(x.label || ''));
    if (m && r) fx.push({ kind: 'slot', ruleId: r.id, label: r.label, value: Number(m[1]) });
  }
  return fx;
}

/**
 * 日ごとのリクエストを読む。
 * 例：「13日は超多忙なので全員出勤」「9、10、11日は満室で清掃4人」「16〜18日は全員出勤、20日は焼き鳥屋は休み」
 * @returns {{items: {days: number[], effects: object[], note: string, text: string}[], unread: {text: string, why: string}[]}}
 */
export function parseDayRequests(text, { month, daysInMonth, rules = [], totalRooms = 28 }) {
  const items = [], unread = [];
  const lines = toHalfWidth(text).split(/[\r\n。！!]+/).map((x) => x.trim()).filter(Boolean);
  const opt = { rules, totalRooms };
  for (const line of lines) {
    if (/^[※＊*]/.test(line)) continue;
    // 読点で切る。ただし「9、10、11日は…」のような日にちの並びは、指示の言葉が出るまでひとまとめにする
    const clauses = [];
    let acc = '';
    // 読点のほか、空白のあとに日にちが続くところでも切る（「12日は全員出勤 13日は満室」）
    for (const seg of line.split(/[、,，]|[ 　]+(?=\d{1,2}\s*(?:日|\/|月))/).map((x) => x.trim()).filter(Boolean)) {
      acc = acc ? acc + '、' + seg : seg;
      if (rqEffects(acc, opt).length) { clauses.push(acc); acc = ''; }
    }
    if (acc) clauses.push(acc);

    let prevDays = [];
    for (const clause of clauses) {
      const effects = rqEffects(clause, opt);
      if (effects.length && RQ_NEG.test(clause)) { unread.push({ text: clause, why: '取り消し・否定の指示は反映しません（消すときは、その日の欄で変えてください）' }); continue; }
      const dayText = clause.replace(COUNT_EXPR, ' ');
      let days = extractDays(dayText, month, daysInMonth);
      if (!days.length && /\d{1,2}\s*[\/月]\s*\d{1,2}/.test(dayText) && !/^\s*$/.test(dayText)) {
        unread.push({ text: clause, why: 'この月の日にちではありません' });
        continue;
      }
      if (!days.length && effects.length) days = prevDays;   // 「13日は全員出勤、清掃は4人」のように日にちを省いたときは、前の日にちを引き継ぐ
      if (!effects.length) {
        unread.push({ text: clause, why: RQ_MOOD.test(clause) ? '何をするか（全員出勤・清掃4人など）も書いてください' : '日ごとの指示として読み取れませんでした' });
        continue;
      }
      if (!days.length) { unread.push({ text: clause, why: '日にちが読み取れませんでした' }); continue; }
      prevDays = days;
      const why = /([^はが、。\d\s]+?)\s*(?:なので|のため|だから|につき)/.exec(clause);
      items.push({ days, effects, note: why ? why[1] : '', text: clause });
    }
  }
  return { items, unread };
}

/** シフト表（スプレッドシート）に貼り付けるTSVを作る */
export function toTSV(members, days, grid, { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push(['区分', '名前', '担当', '出勤日数', ...days.map((d) => d.day)].join('\t'));
  }
  for (const m of members) {
    if (m.active === false) continue;
    const cells = days.map((d) => {
      const v = grid[m.id] ? grid[m.id][d.day] : '';
      return v === null || v === undefined ? '' : v;
    });
    const work = cells.filter((v, i) => v !== '休' && v !== '特' && v !== '✖' && !(m.mode === 'manual' && v === '')).length;
    lines.push([m.kubun || '', m.name, (m.roles || []).join('/'), work, ...cells].join('\t'));
  }
  return lines.join('\n');
}

/* ===== メッセージ（LINE・チャット）からの取り込み ===== */

/**
 * LINEの日付区切り行（2026/09/03(水) のように年が入っているもの）だけを読み飛ばす。
 * 「10月12日」のように年の無い行は、本人が希望日だけを書いた行なので読み飛ばさない。
 */
const DATE_ONLY_LINE = /^\s*(?:19|20)\d{2}\s*[\/\-年.]\s*\d{1,2}\s*[\/\-月.]\s*\d{1,2}\s*日?\s*(?:[(（][日月火水木金土][)）])?\s*$/;

/**
 * 日にちと紛らわしいものを消す。
 *  - 送信時刻（10:23 / 9:01:05）… 10日・23日と誤読されるため
 *  - 既読・スタンプ・画像などの定型語
 */
export function stripMessageNoise(line) {
  return toHalfWidth(line)
    .replace(/\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?/g, ' ')
    .replace(/\[?(?:写真|画像|スタンプ|動画|ファイル|既読|通話時間)\]?/g, ' ')
    .replace(/[\t]+/g, ' ');
}

/** 休みの希望らしい言い回し */
const OFF_WORDS = /休|やすみ|ヤスミ|有給|有休|年休|振休|代休|不在|来れ|来ら|行けま|行けな|伺えま|出られ|欠勤|off/i;
/** 休みの希望ではなさそうな言い回し */
const WORK_WORDS = /出勤|出社|勤務|退社|入社|働け|シフト入/;
/** 「早番希望」のような、出勤する時間帯の希望 */
const SHIFT_WISH = /早番|早出|遅番|遅出/;
/**
 * 日にちとして読まないメモ行。
 * 「※5日はフェリーで那覇に出るため、14時頃上がり」のような伝言を、
 * 休み希望の日として取り込まないようにする（そのまま連絡事項として残す）。
 */
const NOTE_LINE = /^\s*(?:[※＊*・]|[（(]?\s*(?:連絡事項|連絡|メモ|備考|その他)\s*[）)]?\s*[:：]?)/;

/**
 * 早番＝いちばん早く始まる記号、遅番＝いちばん遅くまでの記号。その人が対応できる記号の中から選ぶ。
 * 同じ早さ（遅さ）のときは、名簿で先に並んでいる記号（その人の基本の勤務）にする。
 */
function wishPattern(m, early) {
  const list = (m.patterns || []).filter((p) => PATTERNS[p]);
  if (!list.length) return null;
  const from = (p) => Math.min(...patternSegments(p).map((s) => s.from));
  const to = (p) => Math.max(...patternSegments(p).map((s) => s.to));
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (early ? from(a.p) - from(b.p) : to(b.p) - to(a.p)) || a.i - b.i)[0].p;
}

/**
 * 「13日、20日早番希望」のような、出勤の希望を読む。
 * 休みの希望と混ざらないよう、行ごとに判定する。
 * @returns {{days, label, pattern}|null} 日にちが読み取れなければ null
 */
function readShiftWish(line, member, month, daysInMonth) {
  const { ranges, rest } = extractRanges(line, daysInMonth, month);
  const days = [...new Set([...ranges.flatMap(rangeToDays), ...extractDays(rest, month, daysInMonth)])].sort((a, b) => a - b);
  if (!days.length) return null;
  const early = /早番|早出/.test(line);
  return { days, label: early ? '早番' : '遅番', pattern: wishPattern(member, early) };
}

/**
 * スタッフ名の照合キーを作る。フルネームに加えて、苗字だけ・名前だけでも当たるようにする。
 * 「日下」→ 日下 堅人 / 「絹江」→ 宮平 絹江 のように書かれることが多いため。
 * 同じキーが複数人に当たる場合（同じ苗字が2人など）は ambiguous 印をつけ、勝手に決めない。
 */
export function memberKeys(members) {
  const keys = [];
  for (const m of members) {
    if (m.active === false) continue;
    const full = normalizeName(m.name);
    if (full.length >= 2) keys.push({ member: m, key: full, kind: 'full' });
    const parts = String(m.name).split(/[\s　・,、]+/).filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) {
        const k = normalizeName(p);
        if (k.length >= 2 && k !== full) keys.push({ member: m, key: k, kind: 'part' });
      }
    }
    // 呼び名（「スー」「ケー」など）。フルネーム・苗字と同じ扱いで照合する
    for (const n of m.nicknames || []) {
      const k = normalizeName(n);
      if (k.length >= 1 && k !== full) keys.push({ member: m, key: k, kind: 'nickname' });
    }
  }
  // 同じキーに何人が当たるかを数える
  const owners = new Map();
  for (const k of keys) {
    if (!owners.has(k.key)) owners.set(k.key, new Set());
    owners.get(k.key).add(k.member.id);
  }
  for (const k of keys) k.ambiguous = owners.get(k.key).size > 1;
  return keys.sort((a, b) => b.key.length - a.key.length);  // 長いキーから先に照合
}

/**
 * 1行から発言者を割り出す。
 * 実際のメッセージは「名前 本文」の形が多いので、行頭の一致を優先する。
 * @returns {{member}|{ambiguous:true, key, members}|null}
 */
function findSpeaker(lineKey, keys) {
  if (!lineKey) return null;
  const head = keys.filter((x) => lineKey.startsWith(x.key));
  const pick = head.length
    ? head
    : keys.filter((x) => x.kind === 'full' && lineKey.includes(x.key));  // 行の途中はフルネームのみ
  if (!pick.length) return null;
  const best = pick[0];                                     // キーの長い順に並んでいる
  const tie = pick.filter((x) => x.key === best.key);
  if (best.ambiguous || tie.length > 1) {
    return { ambiguous: true, key: best.key, members: [...new Map(tie.map((t) => [t.member.id, t.member])).values()] };
  }
  return { member: best.member };
}

/**
 * メッセージを貼り付けて希望休を取り込む。
 * 名前が出てきた行から、次の名前が出てくるまでを、その人の発言とみなす。
 * 苗字だけ・名前だけでも照合する。判断がつかない分は取り込まず、画面側で選んでもらう。
 *
 * 「※…」で始まる行は日にちとして読まず、連絡事項として返す。
 * @returns {{requests, streaks, matched, needsCheck, ambiguous, unassigned, preview, notes}}
 */
export function importMessages(text, { members, month, daysInMonth }) {
  const keys = memberKeys(members);

  const blocks = [];      // { member, lines } … 発言者が分かった分
  const ambiguousBlocks = [];  // { key, members, lines } … 誰か絞れない分
  const orphan = [];      // 名前が出てこない分
  let cur = null;

  for (const raw of String(text || '').split(/\r?\n/)) {
    if (DATE_ONLY_LINE.test(raw)) { continue; }   // 日付区切りは読み飛ばす
    const line = stripMessageNoise(raw);
    if (!line.trim()) continue;
    const hit = findSpeaker(normalizeName(line), keys);
    if (hit && hit.ambiguous) {
      cur = { ambiguous: true, key: hit.key, members: hit.members, lines: [line] };
      ambiguousBlocks.push(cur);
    } else if (hit) {
      cur = { member: hit.member, lines: [line] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      orphan.push(line);
    }
  }

  /**
   * 本文から「何日休みたいか」を読み解く。
   * 期間指定（10日まで出勤 など）→ 日にちの列挙 → 連休希望 の順に見る。
   */
  const readBody = (body) => {
    const { ranges, rest } = extractRanges(body, daysInMonth, month);
    const fromRanges = ranges.flatMap(rangeToDays);
    const fromList = extractDays(rest, month, daysInMonth);
    const days = [...new Set([...fromRanges, ...fromList])].sort((a, b) => a - b);
    return { days, ranges, streak: extractStreakWish(body), sym: detectSymbol(body) };
  };

  // 同じ人の複数発言をまとめる
  const byMember = new Map();
  for (const b of blocks) {
    const prev = byMember.get(b.member.id);
    if (prev) prev.lines.push(...b.lines);
    else byMember.set(b.member.id, { member: b.member, lines: [...b.lines] });
  }

  const requests = {};
  const streaks = {};
  const matched = [];
  const needsCheck = [];
  const preview = [];
  const notes = [];
  for (const { member, lines } of byMember.values()) {
    // 「※…」で始まる伝言は、日にちとして読まずに連絡事項として残す
    for (const line of lines.filter((l) => NOTE_LINE.test(l))) {
      notes.push({ member, text: line.replace(NOTE_LINE, '').trim() || line.trim(), ranges: [] });
    }
    const said = lines.filter((l) => !NOTE_LINE.test(l));

    // 「13日、20日早番希望」は休みの希望ではないので、先に分けて読む
    for (const line of said.filter((l) => SHIFT_WISH.test(l))) {
      const w = readShiftWish(line, member, month, daysInMonth);
      if (!w) continue;
      if (!w.pattern) {
        needsCheck.push({ member, days: w.days, sym: '休', text: line, reason: w.label + 'の希望ですが、この人に入れられる記号がありません' });
        continue;
      }
      requests[member.id] = requests[member.id] || {};
      for (const d of w.days) requests[member.id][d] = w.pattern;
      matched.push({ member, days: w.days, sym: w.pattern, wish: w.label, streak: 0, ranges: [], text: line });
      preview.push({ name: member.name, days: w.days, sym: w.pattern, wish: w.label, streak: 0 });
    }

    const body = said.filter((l) => !SHIFT_WISH.test(l)).join(' ').trim();
    const { days, ranges, streak, sym } = readBody(body);

    // 「3連休が取りたい」… 日にちは決めず、シフト生成時に連休を作る
    if (streak) streaks[member.id] = Math.max(streaks[member.id] || 0, streak);

    if (!days.length) {
      if (streak) {
        matched.push({ member, days: [], sym, streak, text: body });
        preview.push({ name: member.name, days: [], sym, streak });
      } else if (OFF_WORDS.test(body)) {
        needsCheck.push({ member, days: [], sym, text: body, reason: '日にちを読み取れませんでした' });
      }
      continue;
    }

    // 期間として読めていれば確かなので、そのまま取り込む。
    // 期間でもなく「出勤」の話に見えるものだけ、確認に回す。
    const looksWork = !ranges.length && WORK_WORDS.test(body) && !OFF_WORDS.test(body);
    if (looksWork) {
      needsCheck.push({ member, days, sym, text: body, reason: '休みの希望ではないかもしれません' });
      continue;
    }
    requests[member.id] = requests[member.id] || {};
    for (const d of days) requests[member.id][d] = sym;
    matched.push({ member, days, sym, streak, ranges, text: body });
    preview.push({ name: member.name, days, sym, streak });
  }

  // 誰か絞れなかった分
  const ambiguous = [];
  for (const b of ambiguousBlocks) {
    const body = b.lines.join(' ').trim();
    const { days, streak, sym } = readBody(body);
    if (!days.length && !streak) continue;
    ambiguous.push({ key: b.key, members: b.members, days, streak, sym, text: body });
  }

  // 名前が1つも見つからなかったときは、全文をまとめて返す（画面側で人を選ぶ）
  const orphanText = orphan.join(' ').trim();
  const orphanRead = orphanText ? readBody(orphanText) : { days: [], streak: 0, sym: '休' };
  const unassigned = (orphanRead.days.length || orphanRead.streak)
    ? { days: orphanRead.days, streak: orphanRead.streak, sym: orphanRead.sym, text: orphanText }
    : null;

  return { requests, streaks, matched, needsCheck, ambiguous, unassigned, preview, notes };
}
