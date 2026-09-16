// 取り込み・出力の確認: node test/importers.test.mjs
import {
  parseCSV, extractDays, extractRanges, extractStreakWish, rangeToDays, toHalfWidth,
  importFormCsv, importMessages, parseRoomsInput, toTSV, normalizeName,
} from '../js/importers.js';
import { defaultMembers, buildDays } from '../js/model.js';

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  … ' + extra : ''));
  if (!cond) failed++;
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, JSON.stringify(a) + ' / ' + JSON.stringify(b));

console.log('=== CSVパーサ ===');
eq(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']], '基本のCSV');
eq(parseCSV('a,b\n"1,5",2'), [['a', 'b'], ['1,5', '2']], '引用符の中のカンマ');
eq(parseCSV('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'BOM付き・CRLF');
eq(parseCSV('a,b\n"改行\n入り",2'), [['a', 'b'], ['改行\n入り', '2']], 'セル内改行');

console.log('\n=== 日にちの読み取り（9月・30日） ===');
eq(extractDays('3, 8, 15', 9, 30), [3, 8, 15], 'カンマ区切り');
eq(extractDays('3日 8日 20日', 9, 30), [3, 8, 20], '「日」付き');
eq(extractDays('9/5, 9/6', 9, 30), [5, 6], '月/日 形式');
eq(extractDays('2026/09/03', 9, 30), [3], '年月日 形式');
eq(extractDays('15〜17', 9, 30), [15, 16, 17], '範囲指定');
eq(extractDays('8/30', 9, 30), [], '別の月は拾わない');
eq(extractDays('35, 40', 9, 30), [], '月の日数を超える数値は無視');
eq(extractDays('3(木) 12(土)', 9, 30), [3, 12], '曜日付き');

console.log('\n=== 氏名の突き合わせ ===');
ok(normalizeName('山田 麗奈') === normalizeName('山田　麗奈'), '全角/半角スペースを無視');
ok(normalizeName('EI KAY ZIN HAN') === normalizeName('ei kay zin han'), '英字の大小を無視');

console.log('\n=== フォーム回答の取り込み ===');
const members = defaultMembers();
const csv = [
  'タイムスタンプ,お名前,希望休の日,備考',
  '2026/08/20 9:01,山田 麗奈,"3, 4, 12",',
  '2026/08/20 9:12,山下　創士朗,"8日 9日 20日",',
  '2026/08/20 10:02,駒澤 晴信,"15〜17",有給希望',
  '2026/08/20 10:30,存在しない人,"5, 6",',
].join('\n');
const res = importFormCsv(csv, { members, month: 9, daysInMonth: 30 });
const id = (n) => members.find((m) => m.name === n).id;
eq(Object.keys(res.requests[id('山田 麗奈')]).map(Number), [3, 4, 12], '希望休が日付ごとに入る');
ok(res.requests[id('山下 創士朗')]['20'] === '休', '全角スペースの氏名も一致する');
ok(res.requests[id('駒澤 晴信')]['16'] === '特', '「有給」は特別休暇として取り込む');
ok(res.unmatched.length === 1 && res.unmatched[0].name === '存在しない人', '名簿にない人は未マッチとして残る');

console.log('\n=== 予約客室数の取り込み ===');
eq(parseRoomsInput('8 8 12 24 24', 30), { 1: 8, 2: 8, 3: 12, 4: 24, 5: 24 }, '1日目から順に並んだ数値');
eq(parseRoomsInput('8\t8\t12', 30), { 1: 8, 2: 8, 3: 12 }, 'タブ区切り');
eq(parseRoomsInput('3\t12\n4\t20\n5\t18', 30), { 3: 12, 4: 20, 5: 18 }, '日付と客室数の組');

console.log('\n=== スプレッドシート貼り付け用TSV ===');
const days = buildDays(2026, 9, {}, [], 10);
const grid = {};
for (const m of members) {
  grid[m.id] = {};
  for (const d of days) grid[m.id][d.day] = d.day % 4 === 0 ? '休' : (m.mode === 'always' ? '' : 'H');
}
const tsv = toTSV(members, days, grid, { header: false });
const lines = tsv.split('\n');
const cols = lines[0].split('\t');
ok(lines.length === members.length, '行数がスタッフ数と一致', lines.length + '行');
ok(cols.length === 4 + days.length, '列数 = 区分・名前・担当・出勤日数 + 日数', cols.length + '列');
const kusaka = lines.find((l) => l.startsWith('\t日下 堅人'));
ok(kusaka.split('\t')[3] === '23', '出勤日数が計算されている（30日 - 休7日 = 23）', kusaka.split('\t')[3]);
const always = lines.find((l) => l.includes('石橋 大樹'));
ok(always.split('\t')[3] === '23', '常勤（記号なし）も出勤日数に数える', always.split('\t')[3]);
const manual = lines.find((l) => l.includes('アメリー'));
ok(manual !== undefined, '手入力の人も行として出力される');

console.log('\n=== メッセージからの取り込み ===');
const msg = (text) => importMessages(text, { members, month: 9, daysInMonth: 30 });
const daysOf = (r, name) => (r.matched.find((x) => x.member.name === name) || {}).days;
const symOf = (r, name) => (r.matched.find((x) => x.member.name === name) || {}).sym;

const line1 = msg([
  '2026/08/20(木)',
  '09:12\t山田 麗奈\t来月の希望休です。3日、4日、12日でお願いします',
  '09:20\t山下 創士朗\t8日 9日 20日 休みたいです',
  '10:02\t駒澤 晴信\t15〜17 有給で取りたいです',
].join('\n'));
eq(daysOf(line1, '山田 麗奈'), [3, 4, 12], 'LINEエクスポート形式から読み取る');
eq(daysOf(line1, '山下 創士朗'), [8, 9, 20], '複数人をまとめて読み取る');
eq(symOf(line1, '駒澤 晴信'), '特', '「有給」を特別休暇として扱う');
ok(!(daysOf(line1, '山田 麗奈') || []).includes(9), '送信時刻(09:12)を日にちと誤読しない');

const line2 = msg('宮平 絹江\n7日と14日休み希望\n\n日下 堅人\n21日、28日おねがいします');
eq(daysOf(line2, '宮平 絹江'), [7, 14], '名前が行、内容が次の行でも読み取る');
eq(daysOf(line2, '日下 堅人'), [21, 28], '次の名前が出るまでを1人分として扱う');

const line3 = msg('山田　麗奈さん\n９月３日、９月４日 休み希望');
eq(daysOf(line3, '山田 麗奈'), [3, 4], '全角の数字・敬称つきでも読み取る');

const line4 = msg('2026/09/03(水)\n宮平 絹江\n25日おねがいします');
eq(daysOf(line4, '宮平 絹江'), [25], '日付区切り行を希望休と誤読しない');

const line5 = msg('10:23 来月3日と4日、お休みいただけますか\n10:24 よろしくお願いします');
ok(line5.matched.length === 0, '名前がないときは matched に入れない');
eq(line5.unassigned && line5.unassigned.days, [3, 4], '名前がないときは unassigned として返す');

const line6 = msg('大山 かんな\n12日 13日 どうしても来られません');
eq(symOf(line6, '大山 かんな'), '✖', '「来られません」を不在・NGとして扱う');

const line7 = msg('こんにちは\nよろしくお願いします');
ok(line7.matched.length === 0 && line7.unassigned === null, '日にちが無い雑談は何も取り込まない');

console.log('\n=== 苗字だけ・名前だけの照合 ===');
const nameOf = (r, name) => r.matched.some((x) => x.member.name === name);

const s1 = msg('日下\t6日12日は休み');
eq(daysOf(s1, '日下 堅人'), [6, 12], '苗字だけで本人を特定する');
const s2 = msg('絹江さん\t7日休みたいそうです');
eq(daysOf(s2, '宮平 絹江'), [7], '名前だけでも本人を特定する');
const s3 = msg('駒澤\t3日 4日 休み\n石橋\t8日休みます');
ok(nameOf(s3, '駒澤 晴信') && nameOf(s3, '石橋 大樹'), '苗字だけの行が続いても混ざらない');
eq(daysOf(s3, '駒澤 晴信'), [3, 4], '前の人の日にちを引き継がない');

console.log('\n=== 日にちではない数字を拾わない ===');
eq(extractDays('一度3連休が欲しい', 9, 30), [], '「3連休」を3日と読まない');
eq(extractDays('2日間お休みください', 9, 30), [], '「2日間」を2日と読まない');
eq(extractDays('5名で対応します', 9, 30), [], '「5名」を5日と読まない');
eq(extractDays('3連休のうち4日と5日', 9, 30), [4, 5], '数え方は外し、日にちは拾う');
eq(extractDays('９月３日', 9, 30), [3], 'CSV側でも全角を読める');

console.log('\n=== 確認が必要な分の切り分け ===');
const c1 = msg('宮平 絹江\t一度3連休が欲しい');
ok(c1.matched.length === 1 && c1.matched[0].streak === 3, '「3連休」を連休の希望として取り込む');
ok(c1.matched[0].days.length === 0, '連休希望は日にちを決めない');
ok(c1.needsCheck.length === 0, '連休希望は確認欄に回さない');

const c2 = msg('駒澤\t10日は出勤です');
ok(c2.matched.length === 0, '期間として読めない「出勤」の話は取り込まない');
ok(c2.needsCheck.length === 1 && c2.needsCheck[0].days.includes(10), '確認欄には日にち付きで出す');

const c3 = msg('日下\t6日は休み');
ok(c3.matched.length === 1 && c3.needsCheck.length === 0, '普通の希望休は確認欄に入れない');

console.log('\n=== 同じ苗字が2人いるとき ===');
const dup = [...members, { id: 'dup1', name: '日下 花子', active: true, roles: [], patterns: [], mode: 'auto' }];
const a1 = importMessages('日下\t6日は休み', { members: dup, month: 9, daysInMonth: 30 });
ok(a1.matched.length === 0, '苗字が重なるときは勝手に決めない');
ok(a1.ambiguous.length === 1, 'あいまいな分として返す');
eq(a1.ambiguous[0].members.map((m) => m.name).sort(), ['日下 堅人', '日下 花子'], '候補を両方返す');
const a2 = importMessages('日下 堅人\t6日は休み', { members: dup, month: 9, daysInMonth: 30 });
ok(a2.matched.length === 1, 'フルネームなら重なっていても特定できる');

console.log('\n=== 期間の指定（〜まで / 〜から） ===');
const rg = (t, n = 31) => extractRanges(t, n).ranges.map((r) => [r.from, r.to]);
eq(rg('10日まで出勤で退社'), [[11, 31]], '「10日まで出勤」→ 11日以降が休み');
eq(rg('15日から出勤します'), [[1, 14]], '「15日から出勤」→ 14日までが休み');
eq(rg('20日以降はお休みします'), [[20, 31]], '「20日以降は休み」');
eq(rg('10日まで休みます'), [[1, 10]], '「10日まで休み」');
eq(rg('3日から7日まで休み'), [[3, 7]], '「3日から7日まで休み」');
eq(rg('6日12日は休み'), [], '日にちの列挙は期間として扱わない');
eq(rangeToDays({ from: 3, to: 6 }), [3, 4, 5, 6], '期間を日にちに開く');
ok(toHalfWidth('⑩日まで出勤').startsWith('10'), '丸数字（⑩）を数字として読む');
eq(rg('⑩日まで出勤'), [[11, 31]], '丸数字の期間も読める');

const g1 = importMessages('駒澤\t10日まで出勤で退社', { members, month: 10, daysInMonth: 31 });
eq(daysOf(g1, '駒澤 晴信'), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], '退社の連絡を期間の休みとして取り込む');
ok(g1.needsCheck.length === 0, '期間として読めたら確認欄に回さない');

const g2 = importMessages('山田 麗奈\t15日から出勤します\n日下\t6日12日は休み', { members, month: 10, daysInMonth: 31 });
eq(daysOf(g2, '山田 麗奈'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], '入社・復帰も期間として読む');
eq(daysOf(g2, '日下 堅人'), [6, 12], '期間と日にち列挙が混ざっても取り違えない');

console.log('\n=== 連休の希望 ===');
ok(extractStreakWish('一度3連休が欲しい') === 3, '「3連休」');
ok(extractStreakWish('3連休が取りたい') === 3, '「3連休が取りたい」');
ok(extractStreakWish('2日連続で休みたい') === 2, '「2日連続で休み」');
ok(extractStreakWish('6日は休み') === 0, '普通の希望休は連休希望にしない');
ok(extractStreakWish('20連休ください') === 0, '現実的でない日数は拾わない');

const g3 = msg('宮平 絹江\t3連休が取りたい\n日下\t6日は休み');
const kinue = members.find((m) => m.name === '宮平 絹江');
ok(g3.streaks[kinue.id] === 3, '連休希望をスタッフごとに返す');
eq(daysOf(g3, '日下 堅人'), [6], '連休希望が他の人に影響しない');

console.log(failed === 0 ? '\n全項目 PASS' : '\n' + failed + '件 FAIL');
process.exit(failed === 0 ? 0 : 1);
