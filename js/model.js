// ホテルかなろあ シフト自動作成 ― データモデル
// パターン定義・スタッフ初期値・必要人員ルールは、既存の「シフト_2024」スプレッドシート
// （パターンシート / R8 7月・8月の実績）から起こしています。

export const PATTERNS = {
  A: { code: 'A', time: '8:00〜17:00',              hours: 8, rest: 1 },
  B: { code: 'B', time: '9:00〜18:00',              hours: 8, rest: 1 },
  C: { code: 'C', time: '8:00〜10:00 / 15:30〜21:30', hours: 8, rest: 5 },
  D: { code: 'D', time: '11:00〜14:00 / 16:00〜21:00', hours: 8, rest: 2 },
  E: { code: 'E', time: '6:00〜8:00 / 16:00〜22:00',  hours: 8, rest: 8 },
  F: { code: 'F', time: '17:30〜21:30',             hours: 4, rest: 0 },
  G: { code: 'G', time: '10:00〜15:00',             hours: 5, rest: 0 },
  H: { code: 'H', time: '6:00〜10:00 / 11:00〜15:00', hours: 8, rest: 1 },
};
export const PATTERN_CODES = Object.keys(PATTERNS);

/**
 * パターンの就労時間を数値の区間に開く。日別タイムラインで「何時に何人いるか」を出すため。
 * 中抜け（C・D・E・H）は区間が2つになる。
 * 例: 'C' → [{from: 8, to: 10}, {from: 15.5, to: 21.5}]
 */
export function patternSegments(code) {
  const p = PATTERNS[code];
  if (!p) return [];
  const num = (s) => {
    const [h, m] = s.trim().split(':').map(Number);
    return h + (m || 0) / 60;
  };
  return p.time.split('/').map((span) => {
    const [a, b] = span.split('〜');
    return { from: num(a), to: num(b) };
  });
}

/** タイムラインで見せる時間帯（6:00〜22:00） */
export const DAY_START = 6;
export const DAY_END = 22;

// 勤務以外の記号（スプレッドシートで実際に使われているもの）
export const OFF_SYMBOLS = {
  '休': { label: '休み',       kind: 'off' },
  '特': { label: '特別休暇',   kind: 'off' },
  '✖': { label: '不在・NG',   kind: 'off' },
  '夜': { label: '夜勤・夜対応', kind: 'work' },
  '屋': { label: '屋台',       kind: 'work' },
  '出': { label: '出張',       kind: 'work' },
};

export const ROLES = ['厨房', 'フロント', '清掃', 'ホール', '全般'];

// 割当モード
//  auto   … パターン（A〜H）を自動で割り当てる
//  always … 記号なしの常勤。希望休・固定休以外は出勤（セルは空欄のまま）
//  manual … 自動では触らない（役員など。人が直接入力する）
export const ASSIGN_MODES = {
  auto:   '自動割当',
  always: '常勤（記号なし）',
  manual: '手入力のみ',
};

export function defaultMembers() {
  const m = (name, opts) => ({
    id: crypto.randomUUID(),
    name,
    kubun: '',          // 区分（役員 / PA など）
    roles: [],
    patterns: [],
    mode: 'auto',
    targetDays: 21,     // 月の目安出勤日数
    maxConsecutive: 6,  // 連続勤務の上限
    fixedOffDows: [],   // 固定休の曜日（0=日）
    active: true,
    note: '',
    ...opts,
  });
  return [
    m('川島裕介',        { kubun: '役員', roles: ['全般'], mode: 'manual', note: '役員。シフトは手入力' }),
    m('宮平 絹江',       { roles: ['厨房'], patterns: ['G', 'H'], targetDays: 22 }),
    m('日下 堅人',       { roles: ['厨房'], patterns: ['D', 'H'], targetDays: 22 }),
    m('山田 麗奈',       { kubun: 'PA', roles: ['厨房'], patterns: ['H', 'D'], targetDays: 20 }),
    m('山下 創士朗',     { kubun: 'PA', roles: ['厨房'], patterns: ['H'], targetDays: 20 }),
    m('駒澤 晴信',       { kubun: 'PA', roles: ['厨房'], patterns: ['H', 'D'], targetDays: 20 }),
    m('石橋 大樹',       { roles: ['フロント'], mode: 'always', targetDays: 21, note: '記号なし運用' }),
    m('薄田 裕花',       { kubun: 'PA', roles: ['フロント', '清掃'], patterns: ['B'], targetDays: 20 }),
    m('大山 かんな',     { kubun: 'PA', roles: ['フロント', '清掃', 'ホール'], patterns: ['B', 'C', 'D', 'H', 'E'], targetDays: 20 }),
    m('EI KAY ZIN HAN',  { roles: ['フロント', '清掃', 'ホール'], patterns: ['H', 'B', 'D'], targetDays: 20 }),
    m('KYI SU THAR',     { roles: ['フロント', '清掃', 'ホール'], patterns: ['H', 'B', 'D', 'E'], targetDays: 20 }),
    m('ギミレ アスナ',   { roles: ['清掃', 'ホール'], patterns: ['B', 'H', 'D'], targetDays: 20 }),
    m('サムパツ',        { roles: ['清掃', 'ホール'], patterns: ['B', 'H', 'D'], targetDays: 20 }),
    m('島村 友子',       { kubun: 'PA', roles: ['清掃'], mode: 'always', targetDays: 21, note: '記号なし運用' }),
    m('アメリー',        { roles: ['全般'], mode: 'manual' }),
    m('焼き鳥',          { roles: ['全般'], mode: 'always', targetDays: 19, note: '屋台。シフト表の焼き鳥行' }),
  ];
}

// 必要人員ルール
//   need = min(base + floor(客室数 / perRooms), max)
//   perRooms = 0 なら客室数に連動しない
// 既定値は R8 7月・8月の実績（G1 / D1〜2 / H3〜5 / B1〜3、1日あたり7〜10名）に合わせています。
export function defaultSlotRules() {
  return [
    { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 3, perRooms: 20, max: 5, enabled: true },
    { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
    { id: 's3', label: '厨房・夕',    pattern: 'D', roles: ['厨房'],                             base: 1, perRooms: 24, max: 2, enabled: true },
    { id: 's4', label: 'フロント・日中', pattern: 'B', roles: ['フロント', '清掃', 'ホール'],       base: 2, perRooms: 24, max: 3, enabled: true },
  ];
}

export function defaultOptions() {
  return {
    defaultRooms: 14,      // 客室数が未入力の日に使う既定値（全28室）
    maxConsecutive: 6,     // 連勤上限（全体）
    minOffDays: 8,         // 月の最低休日数
    iterations: 300,       // 生成の試行回数（多いほど精度が上がる）
    seed: 1,
    keepPattern: true,     // 前日と同じパターンを優先して安定させる
  };
}

// 必要枠を客室数から展開する
export function expandSlots(rules, rooms) {
  const slots = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const extra = r.perRooms > 0 ? Math.floor((rooms || 0) / r.perRooms) : 0;
    const need = Math.max(0, Math.min(r.base + extra, r.max));
    for (let i = 0; i < need; i++) {
      slots.push({ ruleId: r.id, label: r.label, pattern: r.pattern, roles: r.roles, optional: !!r.optional, index: i });
    }
  }
  return slots;
}

export const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

export function buildDays(year, month, rooms = {}, closedDays = [], defaultRooms = 0) {
  const n = new Date(year, month, 0).getDate();
  const days = [];
  for (let d = 1; d <= n; d++) {
    const date = new Date(year, month - 1, d);
    days.push({
      day: d,
      dow: date.getDay(),
      label: `${month}/${d}(${DOW_LABELS[date.getDay()]})`,
      rooms: rooms[d] === undefined || rooms[d] === '' ? defaultRooms : Number(rooms[d]),
      closed: closedDays.includes(d),
    });
  }
  return days;
}
