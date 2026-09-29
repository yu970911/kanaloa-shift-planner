// 15日ごとの期間（前半 1〜15日 ／ 後半 16日〜月末）と、完成の締切・スタッフへの通知文。
// 画面には依存しない関数だけを置く（テストしやすいように）。
import { DOW_LABELS, PATTERNS, OFF_SYMBOLS, alwaysWindow, lunchDuty } from './model.js';

export const PERIOD_NAMES = { first: '前半', second: '後半' };
/** 期間の開始日の何日前までに、シフトを完成させて通知するか */
export const DEADLINE_DAYS_BEFORE = 2;
const HALF = 15;

const daysInMonth = (year, month) => new Date(year, month, 0).getDate();
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const MS_DAY = 24 * 60 * 60 * 1000;
/** 日付どうしの差（日数）。夏時間などで24時間ぴったりにならなくても丸める */
const diffDays = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / MS_DAY);

/** 期間の範囲。from〜to は日にち（1始まり） */
export function periodRange(year, month, which) {
  const monthDays = daysInMonth(year, month);
  const first = which !== 'second';
  const from = first ? 1 : HALF + 1;
  const to = first ? HALF : monthDays;
  return {
    which: first ? 'first' : 'second',
    name: PERIOD_NAMES[first ? 'first' : 'second'],
    year, month, from, to, monthDays,
    length: to - from + 1,
    span: `${month}/${from}〜${month}/${to}`,
    title: `${month}月${PERIOD_NAMES[first ? 'first' : 'second']}（${month}/${from}〜${month}/${to}）`,
  };
}

/** 期間の最初の日 */
export const periodStart = (year, month, which) => new Date(year, month - 1, periodRange(year, month, which).from);

/** 完成の締切日（期間の開始日の N 日前） */
export function deadlineOf(year, month, which, daysBefore = DEADLINE_DAYS_BEFORE) {
  const s = periodStart(year, month, which);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() - daysBefore);
}

/** 今日から見た期間。開始日がまだ先の、いちばん近い期間を返す（開始日当日は過ぎたものとして次へ） */
export function nextPeriod(now = new Date()) {
  let year = now.getFullYear(), month = now.getMonth() + 1, which = 'first';
  for (let i = 0; i < 4; i++) {
    if (diffDays(periodStart(year, month, which), now) > 0) return { year, month, which };
    if (which === 'first') which = 'second';
    else { which = 'first'; month++; if (month > 12) { month = 1; year++; } }
  }
  return { year, month, which };
}

/** 前の期間・次の期間 */
export function shiftPeriod({ year, month, which }, delta) {
  let idx = year * 24 + (month - 1) * 2 + (which === 'second' ? 1 : 0) + delta;
  const y = Math.floor(idx / 24);
  idx -= y * 24;
  return { year: y, month: Math.floor(idx / 2) + 1, which: idx % 2 ? 'second' : 'first' };
}

/**
 * 締切の状態。
 *  done    … 完成（確定）済み
 *  overdue … 締切を過ぎたのに未完成
 *  today   … 今日が締切
 *  soon    … 締切まで3日以内
 *  ok      … まだ余裕がある
 */
export function deadlineStatus(now, deadline, doneAt) {
  const left = diffDays(deadline, now);
  if (doneAt) return { state: 'done', daysLeft: left };
  if (left < 0) return { state: 'overdue', daysLeft: left };
  if (left === 0) return { state: 'today', daysLeft: 0 };
  return { state: left <= 3 ? 'soon' : 'ok', daysLeft: left };
}

export const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}(${DOW_LABELS[d.getDay()]})`;

/** 締切の一行説明（画面の帯に出す） */
export function deadlineMessage(period, deadline, status) {
  const when = fmtDate(deadline);
  switch (status.state) {
    case 'done': return `${period.name}のシフトは完成しています（締切 ${when}）`;
    case 'overdue': return `締切（${when}）を${-status.daysLeft}日過ぎています。${period.name}のシフトがまだ完成していません`;
    case 'today': return `今日が締切です（${when}）。${period.name}のシフトを完成させて、スタッフに通知してください`;
    default: return `${period.name}のシフトは ${when} までに完成させて通知します（あと${status.daysLeft}日）`;
  }
}

/* ---------------- 通知文 ---------------- */

const valueOf = (grid, m, day) => {
  const v = grid && grid[m.id] ? grid[m.id][day] : undefined;
  return v === null || v === undefined ? undefined : v;
};

/** 1日ぶんの表示（「H　6:00〜10:00 / 11:00〜15:00」「休み」など） */
export function dayText(m, v) {
  if (v === undefined) return '未定';
  if (PATTERNS[v]) {
    const ld = lunchDuty(m, v);   // ランチの時間の仕事（宮平・日下は厨房、ほかは清掃）
    return `${v}　${PATTERNS[v].time}${ld ? `（${ld.time}は${ld.duty}）` : ''}`;
  }
  if (v === '休') return '休み';
  if (v === '特') return '特別休暇';
  if (v === '✖') return '休み（不在）';
  if (OFF_SYMBOLS[v]) return `${v}　${OFF_SYMBOLS[v].label}`;
  if (v === '' && m.mode === 'always') return `出勤　${alwaysWindow(m).label}`;
  return v || '休み';
}

const isWorkValue = (m, v) => (
  v === undefined ? false
    : PATTERNS[v] ? true
      : v === '' ? m.mode === 'always'
        : !!OFF_SYMBOLS[v] && OFF_SYMBOLS[v].kind === 'work'
);

/**
 * スタッフへ送る文面を作る。
 *  common    … 全員に送る文面（画像を添えて送る想定）
 *  perPerson … 個人ごとの勤務予定（その人だけに送る／自分の分を確認してもらう）
 */
export function buildNotice({ period, members, days, grid, contact = '' }) {
  const head = `${period.month}月${period.name}（${period.span}）`;
  const common = [
    '【シフトのお知らせ】ホテルかなろあ',
    `${head}のシフトができました。`,
    '自分の勤務日と時間を確認してください。',
    '間違いや変更したいことがあれば、早めに連絡をお願いします。',
    ...(contact ? [contact] : []),
  ].join('\n');

  const perPerson = [];
  for (const m of members) {
    if (m.active === false) continue;
    if (m.kubun === '役員') continue;   // 役員（川島さん）は毎日いる扱いで、勤務の通知は不要
    const lines = [];
    let work = 0, off = 0, any = false;
    for (const d of days) {
      const v = valueOf(grid, m, d.day);
      if (v !== undefined) any = true;
      if (isWorkValue(m, v)) work++; else if (v !== undefined) off++;
      lines.push(`${d.label}　${d.closed && v === '休' ? '休館日' : dayText(m, v)}`);
    }
    // 手入力のみの人で、何も入っていなければ通知の対象にしない
    if (m.mode === 'manual' && !any) continue;
    const text = [
      `${m.name}さん`,
      `${head}のシフトです。`,
      '',
      ...lines,
      '',
      `出勤 ${work}日／休み ${off}日`,
      '確認をお願いします。',
    ].join('\n');
    perPerson.push({ id: m.id, name: m.name, work, off, text });
  }
  return { common, perPerson };
}
