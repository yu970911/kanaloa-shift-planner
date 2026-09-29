// ホテルかなろあ シフト自動作成 ― データモデル
// パターン定義・スタッフ初期値・必要人員ルールは、既存の「シフト_2024」スプレッドシート
// （R8 9月・10月シートの凡例 / 9月後半の実績 / 2026-09-28 のシフトMTG）から起こしています。

// 勤務パターンは、R8 9月・10月シートの凡例に合わせている（2026-09-28）。実働はどれも8時間。
//   B は 9:00 → 8:00 開始に変更（朝8時の送迎・朝食対応のため。忙しければ18時終了もあり、残業代を支給）
//   D は焼き鳥屋（昼 11:00〜14:00 は日下さんが厨房・ほかは清掃、夜 17:00〜22:00 が焼き鳥屋）
//   H は宮平さんのホテル業務（昼食 10:30〜13:30・夕食 16:30〜21:30）。ほかの人が入るときは、昼は部屋の清掃、夜はホール・清掃
//   E は朝食シフト、F は朝・夜のシフト。C・A は今は使っていない
export const PATTERNS = {
  A: { code: 'A', time: '8:00〜17:00',                hours: 8, rest: 1 },
  B: { code: 'B', time: '8:00〜17:00',                hours: 8, rest: 1 },
  C: { code: 'C', time: '8:00〜12:00 / 16:00〜20:00', hours: 8, rest: 4 },
  D: { code: 'D', time: '11:00〜14:00 / 17:00〜22:00', hours: 8, rest: 3 },
  E: { code: 'E', time: '6:30〜11:00 / 12:00〜15:30', hours: 8, rest: 1 },
  F: { code: 'F', time: '6:30〜9:30 / 16:30〜21:30',  hours: 8, rest: 6.5 },
  G: { code: 'G', time: '6:00〜11:00 / 13:30〜16:30', hours: 8, rest: 2.5 },
  H: { code: 'H', time: '10:30〜13:30 / 16:30〜21:30', hours: 8, rest: 3 },
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

export const ROLES = ['厨房', 'フロント', '清掃', 'ホール', '送迎', '全般'];

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
    nicknames: [],       // 呼び名（「スー」「ケー」など）。LINE・メッセージの取り込みで、この名前でも照合する
    ...opts,
  });
  // 2026年10月以降の名簿。石橋は長期休暇で今年は不在のため、在籍を外してシフトに入れない
  return [
    // 役員。毎日1日中いる扱い（記号なしで出勤）。労働時間の上限・法定休日の対象外
    m('川島裕介',        { kubun: '役員', roles: ['全般'], mode: 'always', targetDays: 31, maxConsecutive: 31, note: '役員。毎日出勤' }),
    m('宮平 絹江',       { roles: ['厨房'], patterns: ['H', 'G'], targetDays: 22 }),   // 基本は H（昼夜のホテル業務）
    m('日下 堅人',       { roles: ['厨房'], patterns: ['D', 'H'], targetDays: 22 }),
    m('石橋 大樹',       { roles: ['フロント'], mode: 'always', targetDays: 21, active: false, note: LEAVE_NOTE }),
    m('薄田 裕花',       { kubun: 'PA', roles: ['フロント', '清掃'], patterns: ['B'], targetDays: 20 }),
    m('EI KAY ZIN HAN',  { roles: ['フロント', '清掃', 'ホール'], patterns: ['H', 'B', 'D', 'E'], targetDays: 20, nicknames: ['ケー'] }),
    m('KYI SU THAR',     { roles: ['フロント', '清掃', 'ホール'], patterns: ['H', 'B', 'D', 'E'], targetDays: 20, nicknames: ['スー'] }),
    m('ギミレ アスナ',   { roles: ['清掃', 'ホール', '厨房'], patterns: ['B', 'H', 'D'], targetDays: 20, nicknames: ['アナ'] }),
    m('サムパツ',        { roles: ['清掃', 'ホール', '厨房', '送迎'], patterns: ['B', 'H', 'D'], targetDays: 20 }),
    m('島村 友子',       { kubun: 'PA', roles: ['清掃'], mode: 'manual', targetDays: 21, ...SHIMAMURA, ...SHIMAMURA_ABSENT }),
  ];
}

const LEAVE_NOTE = '長期休暇（2026年は不在）';
/** 島村さんは記号なしで 11:00〜15:00 に出勤（清掃） */
const SHIMAMURA = { dailyHours: 4, workFrom: 11, note: '11:00〜15:00（記号なし）' };
/** 島村さんは風邪で9/30まで休み。10月前半は不在として空白にする（枠にも数えない）。戻ったら割当モードを「常勤（記号なし）」に戻す */
const SHIMAMURA_ABSENT = { mode: 'manual', note: '風邪のため9/30まで休み。10月前半は空白（不在扱い）。戻ったら「常勤（記号なし）」に戻す' };

/**
 * 名簿の入れ替え履歴。すでに保存されているデータにも、読み込むときに一度だけ当てる。
 * （担当者のブラウザやスプレッドシートに、古い名簿が残っているため）
 */
export const ROSTER_REV = 10;
const ROSTER_CHANGES = {
  // 2026年10月から
  2: {
    removed: ['川島裕介', '山田 麗奈', '山下 創士朗', '駒澤 晴信', '大山 かんな', '焼き鳥'],
    onLeave: ['石橋 大樹', '薄田 裕花'],
  },
  // 薄田は10月も勤務することが分かったので在籍に戻す（10/6以降の休みは希望休として入れる）
  3: {
    removed: [],
    onLeave: [],
    back: ['薄田 裕花'],
  },
  // アメリーは屋外の仕事でシフト表とは関係ないので外す。島村は記号なしで 11:00〜15:00
  4: {
    removed: ['アメリー'],
    patch: { '島村 友子': SHIMAMURA },
  },
  // 日下が休みの日の夕方の厨房は、ギミレ・サムパツも入る（2026-09-23 確認）
  5: {
    patch: {
      'ギミレ アスナ': { roles: ['清掃', 'ホール', '厨房'] },
      'サムパツ': { roles: ['清掃', 'ホール', '厨房'] },
    },
  },
  // 川島は役員として毎日1日中いるので、名簿に戻す（2026-09-23 確認）。足りない人は下で自動的に足される
  6: {},
  // サムパツは送迎もできる（2026-09-28 確認）。Bシフトの枠（フロント・送迎）に入れる
  7: {
    patch: {
      'サムパツ': { roles: ['清掃', 'ホール', '厨房', '送迎'] },
    },
  },
  // 夜のホール（E：16:00〜22:00）に入れる人を増やす。ホールができる EI KAY ZIN HAN・サムパツに E を足す（2026-09-28）
  8: {
    patch: {
      'EI KAY ZIN HAN': { patterns: ['H', 'B', 'D', 'E'] },
      'サムパツ': { patterns: ['B', 'H', 'D', 'E'] },
    },
  },
  // 9月後半のシートと2026-09-28のMTGに合わせる。夜のホールはEではなくH（16:30〜21:30）なので、サムパツのEは外す。
  // 宮平さんの基本はH（10:30〜13:30・16:30〜21:30）。島村さんは風邪で不在のため、10月前半は空白にする
  9: {
    patch: {
      '宮平 絹江': { patterns: ['H', 'G'] },
      'サムパツ': { patterns: ['B', 'H', 'D'] },
      '島村 友子': SHIMAMURA_ABSENT,
    },
  },
  // 呼び名を登録（LINE・議事録などで「スー」「ケー」「アナ」と呼ばれることが多いため。2026-09-29）
  10: {
    patch: {
      'KYI SU THAR': { nicknames: ['スー'] },
      'EI KAY ZIN HAN': { nicknames: ['ケー'] },
      'ギミレ アスナ': { nicknames: ['アナ'] },
    },
  },
};

/**
 * 保存データの名簿を、今の名簿に合わせる。
 *  - 辞めた人は外す
 *  - 長期休暇の人は在籍を外す（名簿には残るので、戻ってきたらチェックを入れるだけ）
 *  - 今の名簿にいて保存データに無い人は足す
 * 担当者が自分で追加した人や、担当・パターンの設定はそのまま残す。
 */
export function migrateRoster(state) {
  const rev = state && state.rosterRev ? state.rosterRev : 1;
  if (!state || rev >= ROSTER_REV) return state;
  const norm = (n) => String(n || '').replace(/[\s　]/g, '');
  let members = Array.isArray(state.members) ? state.members.map((m) => ({ ...m })) : [];
  for (let r = rev + 1; r <= ROSTER_REV; r++) {
    const ch = ROSTER_CHANGES[r];
    if (!ch) continue;
    const removed = new Set((ch.removed || []).map(norm));
    const leave = new Set((ch.onLeave || []).map(norm));
    const back = new Set((ch.back || []).map(norm));
    members = members.filter((m) => !removed.has(norm(m.name)));
    for (const m of members) {
      if (leave.has(norm(m.name))) { m.active = false; m.note = LEAVE_NOTE; }
      if (back.has(norm(m.name))) { m.active = true; if (m.note === LEAVE_NOTE) m.note = ''; }
    }
    for (const [name, fields] of Object.entries(ch.patch || {})) {
      const m = members.find((x) => norm(x.name) === norm(name));
      if (m) Object.assign(m, fields);
    }
  }
  const have = new Set(members.map((m) => norm(m.name)));
  for (const d of defaultMembers()) if (!have.has(norm(d.name))) members.push(d);
  return { ...state, members, rosterRev: ROSTER_REV };
}

// 必要人員ルール
//   need = min(base + floor(客室数 / perRooms), max)
//   perRooms = 0 なら客室数に連動しない
//
// 既定値の根拠（2026-09-21 に見直し）
//   R8年9月20日（日）満室の実績：H3（朝食・清掃）／D2（厨房の日下・ホールのギミレ）／F1（厨房の山田）／B1（フロント）
//     ＋島村さんが記号なしで 11:00〜15:00、役員の川島さんが1日中。これで満室を回せた
//   R7年10月の実績：1日平均 H1.8／B1.6／D0.4（記号での出勤は平均4.8名）
// ⇒ 満室で H3・厨房D1・ホールD1・B1、普段（20室未満）は H2・厨房D1・B1
//   山田さん（F）・石橋さん（B）は10月から不在なので、その分は既定値に入れていない（入れても埋まらない）。
//   川島さんは役員として毎日いるが、記号なしなので枠には数えない
//   以前の既定値（R8年7〜8月の繁忙期ベース、満室で10名）は多すぎたので置き換えた
export const RULES_REV = 6;
// 2026-09-28 シフトMTG と 9月後半のシートに合わせて見直し（rev 6）。実際の動きは次のとおり
//   朝    川島さんが6時から朝食を8時に仕上げる → 朝食の枠は置かない。8時にBの人が来て送迎（フロントは川島さんも見る）
//   昼    宮平さん（H）と日下さん（D）が厨房でランチ。ほかの人（B・H・Dのアスナさん）は部屋の清掃。清掃は多くて3〜4人
//   夕・夜 焼き鳥屋（D 17:00〜22:00）は日下さん＋アスナさんの2名（水・土は休み。日下さんが休みなら休業）。
//         ホテルの夕食は、厨房が川島さん＋宮平さん（H。川島さんが不在ならけ子さん）、ホールは平日1名・休日2名（H）。夜のフロントは不要
//   leadName … この人が入る日だけ営業する（休みなら休業）／poolNames … 入れる人（先頭が優先）／closedDows … 休業の曜日
//   cleaner … その枠の人は昼に清掃をする（cleanExcept 名は清掃に数えない）。cleanFill … 清掃の人数を増やすとき、足す枠
export function defaultSlotRules() {
  return [
    // 昼の部屋清掃とディナーのホール（H）。平日1名、休日（土・日・祝）2名。清掃を増やしたい日は、予約客室数の欄で指定する
    { id: 's1', label: '清掃・ホール（昼夜）', pattern: 'H', roles: ['清掃', 'ホール'],           base: 1, perRooms: 0,  max: 1, enabled: true, holidayCount: 2, cleaner: true, cleanFill: true },
    // 宮平さんの昼夜の厨房（夜の厨房は川島さんと2人）。宮平さんが休みでも川島さん・け子さんで回るので、空きでOK
    { id: 's7', label: 'ホテル厨房（宮平）',   pattern: 'H', roles: ['厨房'],                     base: 1, perRooms: 0,  max: 1, enabled: true, optional: true, poolNames: ['宮平 絹江'] },
    { id: 's3', label: '焼き鳥屋・夕',         pattern: 'D', roles: ['厨房', 'ホール'],           base: 2, perRooms: 0,  max: 2, enabled: true,
      closedDows: [3, 6], leadName: '日下 堅人', poolNames: ['ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'], cleaner: true, cleanExcept: 1 },
    // 朝8時から。送迎とフロント。満室の日は手厚く（客室20室ごとに1名）
    { id: 's4', label: 'フロント・送迎（8時〜）', pattern: 'B', roles: ['フロント', '送迎'],     base: 1, perRooms: 20, max: 3, enabled: true, cleaner: true },
  ];
}

/** rev 5 の既定値（夜のホールをEにしていた版）。保存データがこれのままなら、新しい既定値に置き換える */
const RULES_V5 = [
  { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 2, perRooms: 20, max: 4, enabled: true },
  { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
  { id: 's3', label: '焼き鳥屋・夕', pattern: 'D', roles: ['厨房', 'ホール'],                   base: 2, perRooms: 0,  max: 2, enabled: true,
    closedDows: [0, 3], leadName: '日下 堅人', poolNames: ['ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'] },
  { id: 's4', label: 'フロント・送迎（日中）', pattern: 'B', roles: ['フロント', '送迎'],       base: 1, perRooms: 0,  max: 1, enabled: true },
  { id: 's6', label: 'ホール・夜',  pattern: 'E', roles: ['ホール'],                           base: 1, perRooms: 0,  max: 1, enabled: true, holidayCount: 2 },
];

/** rev 4 の既定値（Bを送迎に、清掃を最大4人にした版）。保存データがこれのままなら、新しい既定値に置き換える */
const RULES_V4 = [
  { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 2, perRooms: 20, max: 4, enabled: true },
  { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
  { id: 's3', label: '焼き鳥屋・夕', pattern: 'D', roles: ['厨房', 'ホール'],                   base: 2, perRooms: 0,  max: 2, enabled: true,
    closedDows: [0, 3], leadName: '日下 堅人', poolNames: ['ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'] },
  { id: 's4', label: 'フロント・送迎（日中）', pattern: 'B', roles: ['フロント', '送迎'],       base: 1, perRooms: 0,  max: 1, enabled: true },
];

/** rev 3 の既定値（焼き鳥屋のルールを入れた版）。保存データがこれのままなら、新しい既定値に置き換える */
const RULES_V3 = [
  { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 2, perRooms: 20, max: 3, enabled: true },
  { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
  { id: 's3', label: '焼き鳥屋・夕', pattern: 'D', roles: ['厨房', 'ホール'],                   base: 2, perRooms: 0,  max: 2, enabled: true,
    closedDows: [0, 3], leadName: '日下 堅人', poolNames: ['ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'] },
  { id: 's4', label: 'フロント・日中', pattern: 'B', roles: ['フロント', '清掃', 'ホール'],     base: 1, perRooms: 0,  max: 1, enabled: true },
];

/** rev 2 の既定値（2026-09-21 に見直したもの）。保存データがこれのままなら、新しい既定値に置き換える */
const RULES_V2 = [
  { id: 's1', label: '朝食・清掃',  pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 2, perRooms: 20, max: 3, enabled: true },
  { id: 's2', label: '厨房・昼',    pattern: 'G', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true, optional: true },
  { id: 's3', label: '厨房・夕',    pattern: 'D', roles: ['厨房'],                             base: 1, perRooms: 0,  max: 1, enabled: true },
  { id: 's5', label: 'ホール・夕',  pattern: 'D', roles: ['ホール', '清掃', 'フロント'],       base: 0, perRooms: 24, max: 1, enabled: true },
  { id: 's4', label: 'フロント・日中', pattern: 'B', roles: ['フロント', '清掃', 'ホール'],     base: 1, perRooms: 0,  max: 1, enabled: true },
];

/** 以前の既定値（R8年7〜8月ベース）。保存データがこれのままなら、新しい既定値に置き換える */
const RULES_V1 = [
  { id: 's1', label: '朝食・清掃', pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 3, perRooms: 20, max: 5, enabled: true },
  { id: 's2', label: '厨房・昼', pattern: 'G', roles: ['厨房'], base: 1, perRooms: 0, max: 1, enabled: true, optional: true },
  { id: 's3', label: '厨房・夕', pattern: 'D', roles: ['厨房'], base: 1, perRooms: 24, max: 2, enabled: true },
  { id: 's4', label: 'フロント・日中', pattern: 'B', roles: ['フロント', '清掃', 'ホール'], base: 2, perRooms: 24, max: 3, enabled: true },
];
const ruleKey = (list) => JSON.stringify((list || [])
  .map((r) => [r.id, r.label, r.pattern, [...(r.roles || [])].sort(), Number(r.base), Number(r.perRooms), Number(r.max), r.enabled !== false, !!r.optional, r.closedDows || [], r.leadName || '', r.poolNames || [], r.holidayCount === undefined ? null : r.holidayCount, !!r.cleaner, r.cleanExcept || 0, !!r.cleanFill])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

/**
 * 保存データの必要人員ルールを、新しい既定値に合わせる。
 * 担当者が自分で変えたルールは触らない（以前の既定値のままのときだけ置き換える）。
 */
export function migrateRules(state) {
  if (!state || (state.rulesRev || 1) >= RULES_REV) return state;
  const untouched = !state.rules || [RULES_V1, RULES_V2, RULES_V3, RULES_V4, RULES_V5].some((v) => ruleKey(state.rules) === ruleKey(v));
  return { ...state, rules: untouched ? defaultSlotRules() : state.rules, rulesRev: RULES_REV };
}

/**
 * 労働条件の既定値。
 * 労働時間・休日のルールは労働基準法（全国共通）で、沖縄県独自の基準ではありません。
 *  - 週の法定労働時間 40時間（32条）。常時10人未満の接客娯楽業のみ44時間の特例（40条）
 *  - 1か月単位の変形労働時間制（32条の2）を就業規則で定めている場合は、
 *    月の合計が「週の上限 × 暦日数 ÷ 7」以内なら、週40時間を超える週があってもよい
 *  - 法定休日は毎週1日以上（35条）
 *  - 役員は労働基準法上の労働者に当たらないため、上限の対象外
 * 「社員は月8日休み」のような休日数は法律ではなく、会社の就業規則のルール。
 */
export function defaultLabor() {
  return {
    mode: 'monthly',                    // 'monthly' 1か月単位の変形労働時間制（ホテルで一般的）/ 'weekly' 暦週ごとに判定
    weeklyLimit: 40,                    // 週の上限時間（特例事業場のみ44）
    weekStart: 0,                       // 暦週の起算曜日（0=日曜）
    offDaysByKubun: { 社員: 8, PA: 8 }, // 会社として確保する月の休日数
    exemptKubun: ['役員'],              // 労働時間の上限を当てはめない区分
  };
}

/** 区分を正規化する（空欄は社員） */
export const kubunOf = (m) => (m && m.kubun ? m.kubun : '社員');
export const KUBUN_LIST = ['社員', 'PA', '役員'];

/** 月の労働時間の上限（1か月単位の変形労働時間制の計算式） */
export const monthlyHourCap = (labor, daysInMonth) => (labor.weeklyLimit * daysInMonth) / 7;

/** その日が、月初から数えて何番目の暦週か */
export const weekIndex = (labor, days, day) => {
  const offset = (days[0].dow - (labor.weekStart || 0) + 7) % 7;
  return Math.floor((day - days[0].day + offset) / 7);
};

/** 1日の勤務記号から労働時間を出す（パターンに無い記号・常勤の空欄は、その人の1日の時間） */
export function hoursOf(m, val) {
  if (PATTERNS[val]) return PATTERNS[val].hours;
  if (val === '休' || val === '特' || val === '✖' || val === null || val === undefined) return 0;
  if (val === '' && m.mode !== 'always') return 0;
  return m.dailyHours || 8;
}

/**
 * 記号なしで出勤する人の時間帯。workFrom（何時から）と dailyHours（何時間）から出す。
 * 6時間を超える日は休憩1時間を足す（未設定なら 9:00〜18:00）
 */
export function alwaysWindow(m) {
  const from = Number.isFinite(m.workFrom) ? m.workFrom : 9;
  const hours = m.dailyHours || 8;
  const to = Math.min(DAY_END, from + hours + (hours > 6 ? 1 : 0));
  return { from, to, label: `${from}:00〜${to}:00` };
}

/**
 * ランチの時間は、宮平さん・日下さんが厨房、それ以外の人は清掃（2026-09-28 確認）。
 * ランチの時間帯に入るのは H（10:30〜13:30）と D（11:00〜14:00）。
 */
export const LUNCH_KITCHEN = ['宮平 絹江', '日下 堅人'];
export const LUNCH_SEGMENT = { H: '10:30〜13:30', D: '11:00〜14:00' };
const normSpace = (n) => String(n || '').replace(/[\s　]/g, '');
/** その人がそのパターンで働くとき、ランチの時間にする仕事。ランチの時間帯が無いパターンは null */
export function lunchDuty(m, code) {
  const time = LUNCH_SEGMENT[code];
  if (!time) return null;
  const kitchen = LUNCH_KITCHEN.some((n) => normSpace(n) === normSpace(m && m.name));
  return { time, duty: kitchen ? '厨房' : '清掃' };
}

export function defaultOptions() {
  return {
    defaultRooms: 14,      // 客室数が未入力の日に使う既定値（全28室）
    maxConsecutive: 6,     // 連勤上限（全体）
    minOffDays: 8,         // 月の最低休日数（区分ごとの設定が無いときに使う）
    iterations: 300,       // 生成の試行回数（多いほど精度が上がる）
    seed: 1,
    keepPattern: true,     // 前日と同じパターンを優先して安定させる
    deadlineDaysBefore: 2, // 期間の開始日の何日前までに、シフトを完成させて通知するか
    totalRooms: 28,        // 全客室数。ネッパンの在庫数（空き）から予約客室数を出すのに使う（予約客室数＝全客室数−在庫数）
    labor: defaultLabor(),
  };
}

// 必要枠を客室数から展開する
// dow を渡すと、休業の曜日（closedDows）の枠は出さない
// need … その日だけ人数を指定するとき（予約客室数の欄で指定）
//   { clean: 4 }  … その日の清掃の合計人数。B・H・Dのアスナさんなど「昼に清掃をする人」が足りなければ、清掃を増やす枠（cleanFill）に足す
//   { 枠のid: 人数 } … その枠の人数を直接指定
// holiday … 祝日か（土日は dow から分かる）。枠に holidayCount があれば、土・日・祝はその人数
export function expandSlots(rules, rooms, dow, need, holiday) {
  const slots = [];
  const counts = {};
  const off = dow === 0 || dow === 6 || !!holiday;
  for (const r of rules) {
    if (!r.enabled) continue;
    if (dow !== undefined && Array.isArray(r.closedDows) && r.closedDows.includes(dow)) continue;
    const extra = r.perRooms > 0 ? Math.floor((rooms || 0) / r.perRooms) : 0;
    const forced = need && need[r.id] !== undefined && need[r.id] !== '' && need[r.id] !== null ? Number(need[r.id]) : null;
    const count = forced !== null && Number.isFinite(forced) ? Math.max(0, forced)
      : r.holidayCount !== undefined && r.holidayCount !== null && r.holidayCount !== '' && off ? Math.max(0, Number(r.holidayCount))
        : Math.max(0, Math.min(r.base + extra, r.max));
    counts[r.id] = count;
  }
  // 清掃の合計人数の指定：昼に清掃をする人の数が足りなければ、清掃を増やす枠に足す
  const want = need && need.clean !== undefined && need.clean !== '' && need.clean !== null ? Number(need.clean) : null;
  if (want !== null && Number.isFinite(want)) {
    const fill = rules.find((r) => r.enabled && r.cleanFill && counts[r.id] !== undefined);
    if (fill) {
      const cleaners = rules.reduce((a, r) => a + (r.cleaner && counts[r.id] !== undefined ? Math.max(0, counts[r.id] - (r.cleanExcept || 0)) : 0), 0);
      if (want > cleaners) counts[fill.id] += want - cleaners;
    }
  }
  for (const r of rules) {
    for (let i = 0; i < (counts[r.id] || 0); i++) {
      slots.push({ ruleId: r.id, label: r.label, pattern: r.pattern, roles: r.roles, optional: !!r.optional, index: i });
    }
  }
  return slots;
}

/** その日の清掃の人数（昼に清掃をする枠の数）。画面の目安表示に使う */
export function cleanerCount(rules, rooms, dow, need, holiday) {
  const slots = expandSlots(rules, rooms, dow, need, holiday);
  return rules.reduce((a, r) => {
    if (!r.enabled || !r.cleaner) return a;
    const n = slots.filter((s) => s.ruleId === r.id).length;
    return a + Math.max(0, n - (r.cleanExcept || 0));
  }, 0);
}

export const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 日本の祝日（土日でも含む）。返すのは「月-日」の集合。振替休日と国民の休日も入れる。
 * 春分・秋分は 1980〜2099 年に使える近似式。
 */
export function japanHolidays(year) {
  const set = new Set();
  const add = (m, d) => set.add(`${m}-${d}`);
  // 第n月曜日
  const nthMon = (m, n) => {
    const first = new Date(year, m - 1, 1).getDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  add(1, 1);                       // 元日
  add(1, nthMon(1, 2));            // 成人の日
  add(2, 11);                      // 建国記念の日
  if (year >= 2020) add(2, 23);    // 天皇誕生日
  const g = year - 1980;
  add(3, Math.floor(20.8431 + 0.242194 * g - Math.floor(g / 4)));   // 春分の日
  add(4, 29);                      // 昭和の日
  add(5, 3); add(5, 4); add(5, 5); // 憲法記念日・みどりの日・こどもの日
  add(7, nthMon(7, 3));            // 海の日
  add(8, 11);                      // 山の日
  add(9, nthMon(9, 3));            // 敬老の日
  add(9, Math.floor(23.2488 + 0.242194 * g - Math.floor(g / 4)));   // 秋分の日
  add(10, nthMon(10, 2));          // スポーツの日
  add(11, 3);                      // 文化の日
  add(11, 23);                     // 勤労感謝の日

  const key = (d) => `${d.getMonth() + 1}-${d.getDate()}`;
  const base = [...set];
  // 日曜と重なった祝日は、次の平日（祝日でない日）が振替休日
  for (const k of base) {
    const [m, d] = k.split('-').map(Number);
    if (new Date(year, m - 1, d).getDay() !== 0) continue;
    const t = new Date(year, m - 1, d + 1);
    while (set.has(key(t))) t.setDate(t.getDate() + 1);
    set.add(key(t));
  }
  // 前日と翌日が祝日にはさまれた平日は、国民の休日
  for (let m = 1; m <= 12; m++) {
    const n = new Date(year, m, 0).getDate();
    for (let d = 2; d < n; d++) {
      const dow = new Date(year, m - 1, d).getDay();
      if (dow === 0 || dow === 6 || set.has(`${m}-${d}`)) continue;
      if (set.has(`${m}-${d - 1}`) && set.has(`${m}-${d + 1}`)) set.add(`${m}-${d}`);
    }
  }
  return set;
}

// fullDays … 全員出勤の日（超多忙の日）
// notes … 日ごとのメモ（お祭り・超多忙など。リクエストの理由）
export function buildDays(year, month, rooms = {}, closedDays = [], defaultRooms = 0, needs = {}, fullDays = [], notes = {}) {
  const hols = japanHolidays(year);
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
      need: needs && needs[d] ? needs[d] : null,   // その日だけの人数の指定
      hol: hols.has(`${month}-${d}`),              // 祝日（土日は含まない）
      full: fullDays.includes(d),                  // 全員出勤の日
      note: notes && notes[d] ? notes[d] : '',     // 日ごとのメモ
    });
  }
  return days;
}
