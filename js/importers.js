// Googleフォームの回答CSV／予約客室数の取り込み

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

export function guessColumns(headers) {
  const h = headers.map((x) => String(x || '').toLowerCase());
  const findIdx = (hints) => h.findIndex((x) => hints.some((k) => x.includes(k.toLowerCase())));
  const nameCol = findIdx(NAME_HINTS);
  const dayCols = h.map((x, i) => (DAY_HINTS.some((k) => x.includes(k.toLowerCase())) ? i : -1)).filter((i) => i >= 0);
  return { nameCol, dayCols, typeCol: findIdx(TYPE_HINTS) };
}

/** 全角の数字・記号を半角に直す（９月３日 → 9月3日） */
export function toHalfWidth(value) {
  return String(value || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/／/g, '/').replace(/：/g, ':').replace(/，/g, ',')
    .replace(/[⓪①②③④⑤⑥⑦⑧⑨]/g, (c) => String('⓪①②③④⑤⑥⑦⑧⑨'.indexOf(c)))
    .replace(/⑩/g, '10').replace(/⑪/g, '11').replace(/⑫/g, '12').replace(/⑬/g, '13').replace(/⑭/g, '14')
    .replace(/⑮/g, '15').replace(/⑯/g, '16').replace(/⑰/g, '17').replace(/⑱/g, '18').replace(/⑲/g, '19')
    .replace(/⑳/g, '20');
}

/** 「休み」「出勤」の言い回し */
const R_OFF = '(?:休み?|やすみ|お休み|オフ|off)';
const R_WORK = '(?:出勤|出社|勤務|復帰|入り)';

/**
 * 「10日まで出勤」「15日以降は休み」のような期間指定を取り出す。
 * @returns {{ranges: {from, to, why}[], rest: string}} rest は期間指定を取り除いた残り
 */
export function extractRanges(value, daysInMonth) {
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
  const counted = half.replace(/\d{1,2}\s*(?:連休|連勤|連続|日間|時間|週間|か月|ヶ月|名|人|回|泊|本|件)/g, ' ');

  // ③ 年を取り除く（2026/09/03 → 09/03）
  const work = counted.replace(/(?:19|20)\d{2}\s*[\/\-年.]\s*/g, '');

  // ④ 「月/日」形式を拾い、拾った部分は後段から外す
  const md = /(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})\s*日?/g;
  const spans = [];
  let m;
  while ((m = md.exec(work)) !== null) {
    if (Number(m[1]) === month) add(Number(m[2]));  // 別の月の指定は拾わない
    spans.push([m.index, m.index + m[0].length]);
  }
  let rest = '', pos = 0;
  for (const [s, e] of spans) { rest += work.slice(pos, s) + ' '; pos = e; }
  rest += work.slice(pos);

  // ⑤ 範囲指定 3〜5 / 3-5
  const range = /(\d{1,2})\s*[〜~ー–—]\s*(\d{1,2})/g;
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
 * @returns {{requests, matched, unmatched, preview}}
 */
export function importFormCsv(text, { members, month, daysInMonth, nameCol, dayCols, mapping = {} }) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { requests: {}, matched: [], unmatched: [], preview: [], headers: rows[0] || [] };
  const headers = rows[0];
  const guess = guessColumns(headers);
  const nc = nameCol === undefined || nameCol < 0 ? guess.nameCol : nameCol;
  const dc = dayCols && dayCols.length ? dayCols : guess.dayCols;

  const byName = new Map();
  for (const m of members) byName.set(normalizeName(m.name), m);

  const requests = {};
  const matched = [];
  const unmatched = [];
  const preview = [];

  for (const r of rows.slice(1)) {
    const rawName = nc >= 0 ? r[nc] : '';
    const key = normalizeName(rawName);
    const member = byName.get(key) || (mapping[rawName] ? members.find((m) => m.id === mapping[rawName]) : null);
    const cellText = dc.map((i) => r[i] || '').join(' ');
    const days = extractDays(cellText, month, daysInMonth);
    // 「特」「有給」などは備考欄に書かれることが多いので、行全体から判定する
    const sym = detectSymbol(r.filter((_, i) => i !== nc).join(' '));

    if (!member) {
      if (String(rawName).trim()) unmatched.push({ name: rawName, days, sym });
      continue;
    }
    requests[member.id] = requests[member.id] || {};
    // 同じ人が複数回出したときは、後の回答が上書き
    for (const d of days) requests[member.id][d] = sym;
    matched.push({ member, days, sym });
    preview.push({ name: member.name, days, sym });
  }
  return { requests, matched, unmatched, preview, headers };
}

/**
 * 予約客室数の貼り付けを取り込む。
 * 「1日目から順に並んだ数値」（タブ/カンマ/改行/スペース区切り）と
 * 「3\t12」形式（日にち→客室数）の両方に対応。
 */
export function parseRoomsInput(text, daysInMonth) {
  const lines = String(text || '').trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  const rooms = {};
  const pairLike = lines.length > 1 && lines.every((l) => /^\s*\d{1,2}\s*[\t,: ]\s*\d{1,3}\s*$/.test(l));
  if (pairLike) {
    for (const l of lines) {
      const [d, v] = l.trim().split(/[\t,: ]+/).map(Number);
      if (d >= 1 && d <= daysInMonth) rooms[d] = v;
    }
    return rooms;
  }
  const nums = String(text).split(/[\s,\t]+/).map((s) => s.trim()).filter((s) => s !== '' && /^\d+$/.test(s)).map(Number);
  nums.slice(0, daysInMonth).forEach((v, i) => { rooms[i + 1] = v; });
  return rooms;
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

/** LINEの日付区切り行（2026/09/03(水) など、日付だけの行） */
const DATE_ONLY_LINE = /^\s*(?:(?:19|20)\d{2}\s*[\/\-年.]\s*)?\d{1,2}\s*[\/\-月.]\s*\d{1,2}\s*日?\s*(?:[(（][日月火水木金土][)）])?\s*$/;

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
 * @returns {{requests, streaks, matched, needsCheck, ambiguous, unassigned, preview}}
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
    const { ranges, rest } = extractRanges(body, daysInMonth);
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
  for (const { member, lines } of byMember.values()) {
    const body = lines.join(' ').trim();
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

  return { requests, streaks, matched, needsCheck, ambiguous, unassigned, preview };
}
