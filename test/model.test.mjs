// 名簿まわりの確認: node test/model.test.mjs
import { defaultMembers, migrateRoster, ROSTER_REV, defaultSlotRules, migrateRules, RULES_REV, expandSlots, alwaysWindow, PATTERNS, ROLES, buildDays, patternSegments, japanHolidays, cleanerCount } from '../js/model.js';
import { testRules, rulesV2 } from './fixtures.mjs';
import { testMembers } from './fixtures.mjs';

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  … ' + extra : ''));
  if (!cond) failed++;
};
const names = (list) => list.map((m) => m.name);

console.log('=== 2026年10月以降の名簿 ===');
const now = defaultMembers();
ok(JSON.stringify(names(now)) === JSON.stringify([
  '川島裕介', '宮平 絹江', '日下 堅人', '石橋 大樹', '薄田 裕花', 'EI KAY ZIN HAN',
  'KYI SU THAR', 'ギミレ アスナ', 'サムパツ', '島村 友子',
]), '名簿が10名になっている（アメリーさんは屋外の仕事なので外した）', names(now).join(' / '));
const kawa = now.find((m) => m.name === '川島裕介');
ok(kawa.kubun === '役員' && kawa.mode === 'always' && kawa.targetDays === 31, '川島さんは役員として毎日いる扱い');
for (const n of ['ギミレ アスナ', 'サムパツ']) ok(now.find((m) => m.name === n).roles.includes('厨房'), n + 'さんは夕方の厨房にも入れる');
const shima = now.find((m) => m.name === '島村 友子');
ok(shima.dailyHours === 4 && alwaysWindow(shima).from === 11 && alwaysWindow(shima).to === 15, '島村さんの勤務は 11:00〜15:00（4時間）');
ok(shima.mode === 'manual', '島村さんは風邪で不在のため、10月前半は空白（手入力のみ・枠に数えない）', shima.mode);
const off = now.filter((m) => m.active === false).map((m) => m.name);
ok(JSON.stringify(off) === JSON.stringify(['石橋 大樹']), '石橋だけ名簿に残して在籍を外す（薄田は10月も勤務）', off.join(' / ') || 'なし');
ok(now.find((m) => m.name === '薄田 裕花').active !== false, '薄田は在籍に戻っている');

console.log('\n=== 保存済みの古い名簿を切り替える ===');
const old = { year: 2026, month: 10, members: testMembers(), months: {} };
old.members.find((m) => m.name === '日下 堅人').targetDays = 19;           // 担当者が変えた設定
old.members.push({ id: 'new1', name: '新人 太郎', roles: ['清掃'], patterns: ['H'], mode: 'auto', targetDays: 18, active: true });
const moved = migrateRoster(old);
const left = ['山田 麗奈', '山下 創士朗', '駒澤 晴信', '大山 かんな', '焼き鳥'];   // 川島は役員として名簿に戻した
ok(!moved.members.some((m) => left.includes(m.name)), '辞めた人は外す', left.filter((n) => moved.members.some((m) => m.name === n)).join(', ') || 'なし');
ok(moved.members.find((m) => m.name === '石橋 大樹').active === false, '長期休暇の人は在籍を外す');
ok(moved.members.find((m) => m.name === '薄田 裕花').active !== false, '在籍に戻した人は、古いデータからでも在籍に戻る');
ok(moved.members.find((m) => m.name === '日下 堅人').targetDays === 19, '担当者が変えた設定は残す');
ok(moved.members.some((m) => m.name === '新人 太郎'), '担当者が自分で足した人は残す');
ok(moved.rosterRev === ROSTER_REV, '切り替え済みの印をつける');
ok(migrateRoster(moved) === moved, '2回目以降は何もしない');
ok(old.members.some((m) => m.name === '山田 麗奈'), '元のデータは書き換えない（読み込み直しても壊れない）');
ok(!moved.members.some((m) => m.name === 'アメリー'), 'アメリーさんは古いデータからも外す');
const kawa2 = moved.members.find((m) => m.name === '川島裕介');
ok(kawa2 && kawa2.mode === 'always', '川島さんは古いデータにも戻す');
ok(moved.members.find((m) => m.name === 'サムパツ').roles.includes('厨房'), '古いデータのサムパツさんにも厨房を足す');
const shima2 = moved.members.find((m) => m.name === '島村 友子');
ok(shima2.dailyHours === 4 && shima2.workFrom === 11, '島村さんの出勤時間は古いデータにも反映する');

const empty = migrateRoster({ year: 2026, month: 10, months: {} });
ok(names(empty.members.filter((m) => m.active !== false)).length === 9, '名簿が空の古いデータには、今の名簿を入れる', names(empty.members).length + '名');

console.log('\n=== 必要人員のルール（2026-09-28 シフトMTG・9月後半のシートに合わせる） ===');
const rulesNow = defaultSlotRules();
const slotsOf = (rooms, dow, need, hol) => expandSlots(rulesNow, rooms, dow, need, hol);
const cnt = (slots, id) => slots.filter((s) => s.ruleId === id).length;
const wk = slotsOf(14, 1);   // 平日（月）・14室
ok(cnt(wk, 's3') === 2 && cnt(wk, 's1') === 1 && cnt(wk, 's4') === 1 && cnt(wk, 's7') === 1, '平日（14室）：焼き鳥屋D2・清掃ホールH1・フロント送迎B1・宮平さんの厨房H1', wk.map((s) => s.ruleId).join(','));
ok(wk.filter((s) => !s.optional).length === 4, '平日の必須は4名（宮平さんの厨房は空きでOK）');
ok(rulesNow.every((r) => r.pattern !== 'E' && r.pattern !== 'F' && r.pattern !== 'G'), '今は使っていないパターン（E・F・G・C）の枠は置かない（朝食は川島さん）');
ok(rulesNow.every((r) => !(r.roles || []).includes('フロント') || r.pattern === 'B'), '夜のフロントは置かない（フロントはBだけ）');

const yk = rulesNow.find((r) => r.id === 's3');
ok(slotsOf(14, 3).every((s) => s.ruleId !== 's3') && slotsOf(14, 6).every((s) => s.ruleId !== 's3'), '焼き鳥屋は水曜・土曜が休み（9月のシートと同じ）');
ok([0, 1, 2, 4, 5].every((dow) => cnt(slotsOf(14, dow), 's3') === 2), '焼き鳥屋は日・月・火・木・金に2名');
ok(yk.leadName === '日下 堅人' && yk.poolNames[0] === 'ギミレ アスナ' && yk.poolNames.slice(1).sort().join() === 'EI KAY ZIN HAN,KYI SU THAR',
  '焼き鳥屋は日下さん中心・アスナさん優先・KYI SU／EI KAY ZIN HAN が控え');

// 夜のホール（H の夜）：平日1名、休日（土・日・祝）2名
ok(cnt(slotsOf(14, 1), 's1') === 1 && cnt(slotsOf(14, 4), 's1') === 1, '清掃・ホール（H）は平日1名');
ok(cnt(slotsOf(14, 6), 's1') === 2 && cnt(slotsOf(14, 0), 's1') === 2, '土・日は2名');
ok(cnt(slotsOf(14, 1, null, true), 's1') === 2, '祝日は2名');
const hall = rulesNow.find((r) => r.id === 's1');
ok(hall.pattern === 'H' && hall.roles.join() === '清掃,ホール', '夜のホールはH（16:30〜21:30）・担当は清掃とホール');
const kit = rulesNow.find((r) => r.id === 's7');
ok(kit.pattern === 'H' && kit.optional && kit.poolNames.join() === '宮平 絹江', '宮平さんの昼夜の厨房（H）は、宮平さんだけが入れる・空きでOK');

// B：客室20室ごとに1名増える（満室は手厚く）
ok(cnt(slotsOf(0, 1), 's4') === 1 && cnt(slotsOf(20, 1), 's4') === 2 && cnt(slotsOf(28, 1), 's4') === 2, 'Bは客室20室ごとに1名増える', [0, 20, 28].map((n) => cnt(slotsOf(n, 1), 's4')).join('・'));
const bRule = rulesNow.find((r) => r.id === 's4');
ok(bRule.pattern === 'B' && bRule.roles.includes('送迎') && bRule.roles.includes('フロント') && !bRule.roles.includes('清掃'), 'Bの枠は「フロント・送迎」（フロントか送迎ができる人）', bRule.roles.join('・'));

// 清掃の合計人数
const cleaners = (rooms, dow, need, hol) => cleanerCount(rulesNow, rooms, dow, need, hol);
ok(cleaners(14, 1) === 3, '平日の清掃は3名（B1・H1・Dのアスナさん1）', String(cleaners(14, 1)));
ok(cleaners(14, 6) === 3 && cleaners(14, 0) === 4, '土曜は焼き鳥屋が休みなので3名、日曜はH2名で4名', `${cleaners(14, 6)}・${cleaners(14, 0)}`);
ok(cleaners(14, 3) === 2, '水曜は焼き鳥屋が休みなので2名', String(cleaners(14, 3)));
const c4 = slotsOf(14, 5, { clean: 4 });
ok(cleaners(14, 5, { clean: 4 }) === 4 && cnt(c4, 's1') === 2, '10/2のように清掃を4名にすると、H（清掃・ホール）が1名増える', `H${cnt(c4, 's1')}`);
ok(cleaners(14, 5, { clean: 2 }) === 3, '清掃を今より少なく指定しても減らさない');
ok(cnt(slotsOf(14, 5, { clean: '' }), 's1') === 1, '指定が空欄なら自動に戻る');
ok(cnt(slotsOf(14, 5, { s1: 3 }), 's1') === 3, '枠のidで人数を直接指定することもできる');
const dd0 = buildDays(2026, 10, {}, [], 14, { 2: { clean: 4 } }, [9]);
ok(dd0[1].need && dd0[1].need.clean === 4 && dd0[0].need === null && dd0[8].full && !dd0[7].full, '日ごとの指定（清掃の人数・全員出勤）はその日にだけ付く');

const oldRules = migrateRules({ rules: testRules(), members: [] });
ok(oldRules.rulesRev === RULES_REV && oldRules.rules.some((r) => r.id === 's7'), '以前の既定値のままなら、新しいルールに置き換える');
const v2 = migrateRules({ rules: rulesV2(), rulesRev: 2, members: [] });
ok(v2.rulesRev === RULES_REV && v2.rules.some((r) => r.label === '焼き鳥屋・夕') && !v2.rules.some((r) => r.id === 's5'), '9月21日版の既定値のままなら、新しいルールに置き換える');
const v5 = migrateRules({ rules: [
  { id: 's1', label: '朝食・清掃', pattern: 'H', roles: ['厨房', '清掃', 'ホール', 'フロント'], base: 2, perRooms: 20, max: 4, enabled: true },
  { id: 's2', label: '厨房・昼', pattern: 'G', roles: ['厨房'], base: 1, perRooms: 0, max: 1, enabled: true, optional: true },
  { id: 's3', label: '焼き鳥屋・夕', pattern: 'D', roles: ['厨房', 'ホール'], base: 2, perRooms: 0, max: 2, enabled: true,
    closedDows: [0, 3], leadName: '日下 堅人', poolNames: ['ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'] },
  { id: 's4', label: 'フロント・送迎（日中）', pattern: 'B', roles: ['フロント', '送迎'], base: 1, perRooms: 0, max: 1, enabled: true },
  { id: 's6', label: 'ホール・夜', pattern: 'E', roles: ['ホール'], base: 1, perRooms: 0, max: 1, enabled: true, holidayCount: 2 },
], rulesRev: 5, members: [] });
ok(!v5.rules.some((r) => r.id === 's6') && v5.rules.find((r) => r.id === 's3').closedDows.join() === '3,6', '夜のホールをEにしていた版のままなら、H・水土休みの新しいルールに置き換える');
const custom = testRules(); custom[0].base = 1;
const kept = migrateRules({ rules: custom, members: [] });
ok(kept.rules[0].base === 1, '担当者が自分で変えたルールは置き換えない');

console.log('\n=== 勤務パターン（9月・10月シートの凡例） ===');
const seg = (c) => patternSegments(c).map((x) => `${x.from}-${x.to}`).join(' ');
ok(PATTERNS.B.time === '8:00〜17:00' && PATTERNS.B.hours === 8, 'Bは8:00開始（8:00〜17:00）に変更', PATTERNS.B.time);
ok(seg('D') === '11-14 17-22' && PATTERNS.D.hours === 8, 'D（焼き鳥屋）は 11:00〜14:00 / 17:00〜22:00', seg('D'));
ok(seg('H') === '10.5-13.5 16.5-21.5' && PATTERNS.H.hours === 8, 'H（宮平さんの昼夜）は 10:30〜13:30 / 16:30〜21:30', seg('H'));
ok(seg('G') === '6-11 13.5-16.5' && PATTERNS.G.hours === 8, 'Gは 6:00〜11:00 / 13:30〜16:30', seg('G'));
ok(seg('E') === '6.5-11 12-15.5', 'Eは朝食シフト 6:30〜11:00 / 12:00〜15:30', seg('E'));
ok(seg('F') === '6.5-9.5 16.5-21.5', 'Fは朝・夜のシフト 6:30〜9:30 / 16:30〜21:30', seg('F'));
ok(seg('C') === '8-12 16-20', 'Cは 8:00〜12:00 / 16:00〜20:00', seg('C'));
ok(Object.values(PATTERNS).every((p) => p.hours === 8), '実働はどのパターンも8時間');
ok(ROLES.includes('送迎'), '担当に「送迎」がある');
const dm = defaultMembers();
ok(dm.find((m) => m.name === 'サムパツ').roles.includes('送迎'), 'サムパツさんは送迎ができる');
const oldSam = migrateRoster({ rosterRev: 6, members: [{ id: 'x', name: 'サムパツ', roles: ['清掃', 'ホール', '厨房'], patterns: ['B'], mode: 'auto', active: true }], months: {} });
ok(oldSam.members.find((m) => m.name === 'サムパツ').roles.includes('送迎'), '古いデータのサムパツさんにも送迎を足す');
const bOk = dm.filter((m) => (m.patterns || []).includes('B') && bRule.roles.some((r) => (m.roles || []).includes(r))).map((m) => m.name).sort();
ok(JSON.stringify(bOk) === JSON.stringify(['EI KAY ZIN HAN', 'KYI SU THAR', 'サムパツ', '薄田 裕花'].sort()), 'Bに入れるのは サムパツ・KYI SU・EI KAY ZIN HAN・薄田', bOk.join('・'));
ok(dm.find((m) => m.name === '宮平 絹江').patterns[0] === 'H', '宮平さんの基本はH（昼夜のホテル業務）');
ok(!dm.find((m) => m.name === 'サムパツ').patterns.includes('E'), 'サムパツさんにEは付けない（Eは朝食シフト）');
const old9 = migrateRoster({ rosterRev: 8, members: [
  { id: 'a', name: '宮平 絹江', roles: ['厨房'], patterns: ['G', 'H'], mode: 'auto', active: true },
  { id: 'b', name: 'サムパツ', roles: ['ホール'], patterns: ['B', 'H', 'D', 'E'], mode: 'auto', active: true },
  { id: 'c', name: '島村 友子', roles: ['清掃'], patterns: [], mode: 'always', active: true },
], months: {} });
ok(old9.members.find((m) => m.name === '宮平 絹江').patterns[0] === 'H' && !old9.members.find((m) => m.name === 'サムパツ').patterns.includes('E')
  && old9.members.find((m) => m.name === '島村 友子').mode === 'manual', '古いデータにも、宮平さんH・サムパツE外し・島村さん不在を反映する');

console.log('\n=== 祝日・全員出勤の日 ===');
{
  const h26 = japanHolidays(2026);
  ok(h26.has('10-12'), '2026年10月の祝日：10/12（スポーツの日）');
  ok(!h26.has('10-5') && !h26.has('10-19'), '10/5・10/19 は祝日ではない');
  ok(h26.has('9-21') && h26.has('9-22') && h26.has('9-23'), '2026年9月：敬老の日 9/21・国民の休日 9/22・秋分の日 9/23');
  ok(h26.has('5-6'), '2026年5月6日は振替休日（5/3が日曜）');
  ok(h26.has('3-20') && h26.has('1-12') && h26.has('11-23') && h26.has('8-11'), '春分（3/20）・成人の日（1/12）・勤労感謝・山の日');
  const dd = buildDays(2026, 10, {}, [], 14, {}, [9, 10, 11]);
  ok(dd[11].hol === true && dd[11].dow === 1, '10/12 は月曜だが祝日として扱う');
  ok(dd[8].full && dd[9].full && dd[10].full && !dd[7].full && !dd[11].full, '全員出勤の日は 10/9・10・11 だけ');
}

console.log('\n=== 呼び名（2026-09-29） ===');
{
  const dm = defaultMembers();
  ok(dm.find((m) => m.name === 'KYI SU THAR').nicknames.includes('スー'), 'KYI SU THAR さんの呼び名は「スー」');
  ok(dm.find((m) => m.name === 'EI KAY ZIN HAN').nicknames.includes('ケー'), 'EI KAY ZIN HAN さんの呼び名は「ケー」');
  ok(dm.find((m) => m.name === 'ギミレ アスナ').nicknames.includes('アナ'), 'ギミレ アスナ さんの呼び名は「アナ」');
  const old = migrateRoster({ rosterRev: 9, members: [
    { id: 'k', name: 'KYI SU THAR', roles: ['ホール'], patterns: ['H'], mode: 'auto', active: true },
    { id: 'e', name: 'EI KAY ZIN HAN', roles: ['ホール'], patterns: ['H'], mode: 'auto', active: true },
  ], months: {} });
  ok(old.members.find((m) => m.name === 'KYI SU THAR').nicknames.includes('スー') && old.members.find((m) => m.name === 'EI KAY ZIN HAN').nicknames.includes('ケー'),
    '古いデータにも呼び名を足す');
}

console.log(failed === 0 ? '\n全項目 PASS' : '\n' + failed + '件 FAIL');
process.exit(failed === 0 ? 0 : 1);
