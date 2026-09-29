// テスト用の必要人員ルール（R8年7〜8月ベースの旧既定値）。実際の既定値が変わってもテストの前提が変わらないように固定。
export function testRules() {
  return [
    { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 3, perRooms: 20, max: 5, enabled: true },
    { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
    { id: 's3', label: '厨房・夕',    pattern: 'D', roles: ['厨房'],                             base: 1, perRooms: 24, max: 2, enabled: true },
    { id: 's4', label: 'フロント・日中', pattern: 'B', roles: ['フロント', '清掃', 'ホール'],       base: 2, perRooms: 24, max: 3, enabled: true },
  ];
}

// 2026-09-21 版の既定値（焼き鳥屋のルールを入れる前）。保存データの置き換えテスト用
export function rulesV2() {
  return [
    { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 2, perRooms: 20, max: 3, enabled: true },
    { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
    { id: 's3', label: '厨房・夕',    pattern: 'D', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true },
    { id: 's5', label: 'ホール・夕',  pattern: 'D', roles: ['ホール', '清掃', 'フロント'],       base: 0, perRooms: 24, max: 1, enabled: true },
    { id: 's4', label: 'フロント・日中', pattern: 'B', roles: ['フロント', '清掃', 'ホール'],     base: 1, perRooms: 0,  max: 1, enabled: true },
  ];
}

// テスト用の名簿（2026年9月時点の16名）。
// 実際の名簿（js/model.js の defaultMembers）が入れ替わっても、テストの前提が変わらないように固定している。
export function testMembers() {
  const m = (name, opts) => ({
    id: crypto.randomUUID(),
    name,
    kubun: '',          // 区分（空欄＝社員 / PA / 役員）
    dailyHours: 8,      // 常勤（記号なし）の1日の労働時間。労働時間の上限チェックに使う
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
