// 取り込み・出力の確認: node test/importers.test.mjs
import {
  parseCSV, extractDays, extractRanges, extractStreakWish, rangeToDays, toHalfWidth,
  importFormCsv, importMessages, guessColumns, parseRoomsInput, parseRoomsInputDetail, roomsFromVacancy, parseDayRequests, toTSV, normalizeName,
} from '../js/importers.js';
import { buildDays, defaultSlotRules } from '../js/model.js';
import { testMembers } from './fixtures.mjs';

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
const members = testMembers();
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
ok(res.requests[id('駒澤 晴信')]['16'] === '休', '備考の文章で、選んだ日の記号を勝手に変えない');
ok((res.notes || []).some((n) => n.member.name === '駒澤 晴信' && n.text === '有給希望'), '備考は取り込み結果の連絡事項に出す');
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
eq(daysOf(line4, '宮平 絹江'), [25], '年入りの日付区切り行は読み飛ばす');

// 名前・日付・用件を別々の行で送ってくる形（LINEではこれが多い）
const line4b = msg('アスナ\n\n9月12日\n\n希望休み');
eq(daysOf(line4b, 'ギミレ アスナ'), [12], '名前・日付・用件が別の行でも読み取る');
const line4c = msg('2026/09/01(月)\n日下\n\n9月6日\n\n休み希望');
eq(daysOf(line4c, '日下 堅人'), [6], '年無しの日付だけの行は、区切りではなく希望日として読む');

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

console.log('\n=== Googleフォーム（休み希望）の回答CSV ===');
// gas/CreateForm.gs が作るフォームの回答をそのまま再現（2026年10月）
const formCsv = [
  'タイムスタンプ,お名前,10月の希望休,連休の希望,連絡事項',
  '2026/09/20 9:01,宮平 絹江,"10/3（土）, 10/4（日）, 10/12（月）",3連休,',
  '2026/09/20 9:12,日下 堅人,"10/6（火）, 10/12（月）",なし,12日は有給でお願いします',
  '2026/09/20 9:30,駒澤 晴信,,なし,10日まで出勤で退社します。もう来られません',
  '2026/09/20 9:35,山田 麗奈,,2連休,',
  '2026/09/20 9:40,薄田 裕花,"10/2（金）",なし,子どもの行事があります。来られません',
].join('\n');
const fg = guessColumns(parseCSV(formCsv)[0]);
eq([fg.nameCol, fg.dayCols, fg.specialCols, fg.streakCol, fg.noteCols], [1, [2], [], 3, [4]], 'フォームの列を種類ごとに見分ける');

const fr = importFormCsv(formCsv, { members, month: 10, daysInMonth: 31 });
const fDays = (name) => (fr.preview.find((p) => p.name === name) || {}).days;
const mid = (name) => members.find((m) => m.name === name).id;
eq(fDays('宮平 絹江'), [3, 4, 12], '「10/3（土）」形式の選択肢から日にちを読む');
ok(fr.streaks[mid('宮平 絹江')] === 3, '「3連休」を連休の希望として取り込む');
ok(fr.streaks[mid('山田 麗奈')] === 2, '希望休が無くても連休の希望だけ取り込める');
ok(fr.requests[mid('日下 堅人')][6] === '休' && fr.requests[mid('日下 堅人')][12] === '休', 'チェックした日は休みとして入る（有給かどうかは連絡事項を見て人が決める）');
ok(fr.requests[mid('駒澤 晴信')][11] === '休' && fr.requests[mid('駒澤 晴信')][31] === '休', '連絡事項の「10日まで出勤」を11日以降の休みとして取り込む');
ok(fr.requests[mid('駒澤 晴信')][10] === undefined, '「10日まで出勤」の10日は出勤のまま');
ok(fr.requests[mid('薄田 裕花')][2] === '休', '連絡事項に「来られません」があっても他の人の記号は変わらない');
ok(fr.notes.length === 3, '連絡事項が書かれた人だけ一覧に出す', fr.notes.map((n) => n.member.name).join(', '));
ok(fr.notes.find((n) => n.member.name === '薄田 裕花').ranges.length === 0, '期間として読めない連絡事項は「要確認」として残す');

// 「来られません」「有給で」に引きずられて、選んだ日の記号が丸ごと変わらないこと
ok(fr.requests[mid('薄田 裕花')][2] === '休', '連絡事項の「来られません」で休みが✖に変わらない');
const komaDays = Object.values(fr.requests[mid('駒澤 晴信')]);
ok(komaDays.every((x) => x === '休'), '退社の連絡も休みとして入る', [...new Set(komaDays)].join(','));

// 有給の列があるフォーム（以前の形）の回答も、引き続き読める
const oldForm = [
  'タイムスタンプ,お名前,10月の希望休,有給・特別休暇を使いたい日,連休の希望,連絡事項',
  '2026/09/20 9:12,日下 堅人,"10/6（火）, 10/12（月）","10/12（月）",なし,',
].join('\n');
const ofr = importFormCsv(oldForm, { members, month: 10, daysInMonth: 31 });
ok(ofr.requests[mid('日下 堅人')][12] === '特' && ofr.requests[mid('日下 堅人')][6] === '休', '有給の列がある回答では、その日を特にする');

// 連絡事項の列も有給の列も無い自由な形のCSVは、今までどおり行全体から判定する
const freeCsv = [
  'お名前,希望休の日,種別',
  '山田 麗奈,"3, 4, 12",有給',
].join('\n');
const frr = importFormCsv(freeCsv, { members, month: 10, daysInMonth: 31 });
ok(frr.requests[mid('山田 麗奈')][3] === '特', '連絡事項の列が無いCSVは、行全体から「特」を判定する');

console.log('\n=== 出勤の希望（早番・遅番） ===');
{
  const text = ['宮平', '10月9、10、11日希望休', '13日、20日早番希望'].join('\n');
  const r = importMessages(text, { members, month: 10, daysInMonth: 31 });
  const miya = members.find((m) => m.name === '宮平 絹江');
  const req = r.requests[miya.id] || {};
  ok(req[9] === '休' && req[10] === '休' && req[11] === '休', '同じ人の「9、10、11日希望休」は休みで入る', JSON.stringify(req));
  // 宮平さんの G（6:00〜）と H（6:00〜）は同じ早さ。同じときは名簿で先の G（基本の勤務）
  ok(req[13] === 'G' && req[20] === 'G', '「13日、20日早番希望」は休みにせず、早番の記号で入れる（同じ早さなら基本のG）', `13→${req[13]} / 20→${req[20]}`);
  const kusa = members.find((m) => m.name === '日下 堅人');
  const r2 = importMessages(['日下', '13日早番希望'].join('\n'), { members, month: 10, daysInMonth: 31 });
  ok((r2.requests[kusa.id] || {})[13] === 'H', '早さが違えば、いちばん早い記号（日下さんはH）', String((r2.requests[kusa.id] || {})[13]));
  ok(r.matched.some((x) => x.wish === '早番'), '取り込み結果に「早番」と出る');
}
{
  const samu = members.find((m) => m.name === 'サムパツ');
  const r = importMessages('サムパツ 5日遅番希望', { members, month: 10, daysInMonth: 31 });
  ok((r.requests[samu.id] || {})[5] === 'D', '遅番は、いちばん遅くまでの記号（D）で入れる', JSON.stringify(r.requests[samu.id]));
}

console.log('\n=== ※ で始まる伝言 ===');
{
  const usuda = members.find((m) => m.name === '薄田 裕花');
  const text = ['薄田 裕花', '10月6日以降は休み', '※5日はフェリーで那覇に出るため、14時頃上がりでお願いします'].join('\n');
  const r = importMessages(text, { members, month: 10, daysInMonth: 31 });
  const req = r.requests[usuda.id] || {};
  ok(req[6] === '休' && req[31] === '休', '「6日以降は休み」は6日から月末まで休みで入る', Object.keys(req).length + '日');
  ok(!req[5], '※の行の「5日」は休みにしない（6日以降の休みとは別）', req[5] || 'なし');
  const solo = importMessages(['薄田 裕花', '10月20日 希望休', '※5日は14時頃上がりでお願いします'].join(String.fromCharCode(10)), { members, month: 10, daysInMonth: 31 });
  const sreq = solo.requests[usuda.id] || {};
  ok(Object.keys(sreq).join(',') === '20', '※の行の日にち・時刻は一切拾わない', JSON.stringify(sreq));
  ok(r.notes.length === 1 && r.notes[0].member.name === '薄田 裕花', '※の行は連絡事項として残す', JSON.stringify(r.notes.map((n) => n.text)));
}

console.log('\n=== ねっぱんの残室数 → 予約客室数（全客室数28−残室数） ===');
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(eq(parseRoomsInput('10 12 8', 31), { 1: 10, 2: 12, 3: 8 }), '数字だけの並びは1日目から');
  ok(eq(parseRoomsInput('10 12 8', 31, 16), { 16: 10, 17: 12, 18: 8 }), '後半なら16日目から');
  const twoMonth = Array.from({ length: 31 }, (_, i) => i + 1).join(' ');
  ok(Object.keys(parseRoomsInput(twoMonth, 31, 16, { periodLength: 16 })).length === 31 && parseRoomsInput(twoMonth, 31, 16, { periodLength: 16 })[1] === 1,
    '後半を開いていても、期間より多い数字（1か月分）が貼られたら1日から');
  ok(eq(parseRoomsInput('3\t12\n4\t9', 31), { 3: 12, 4: 9 }), '「日付 数」の組');
  ok(eq(parseRoomsInput('10/1\t14\n10/2\t10\n10/3\t6', 31, 1, { month: 10 }), { 1: 14, 2: 10, 3: 6 }), '「10/1 14」の形');
  ok(eq(parseRoomsInput('10月1日(木)\t14\n10月2日(金)\t10', 31, 1, { month: 10 }), { 1: 14, 2: 10 }), '「10月1日(木) 14」の形');
  ok(eq(parseRoomsInput('2026/10/1,14\n2026/10/2,10', 31, 1, { month: 10 }), { 1: 14, 2: 10 }), '「2026/10/1,14」の形');
  ok(eq(parseRoomsInput('9/30\t5\n10/1\t14\n10/2\t10', 31, 1, { month: 10 }), { 1: 14, 2: 10 }), '別の月の行は読まない');
  ok(eq(parseRoomsInput('日付\t残室数\n10/1\t14\n10/2\t10', 31, 1, { month: 10 }), { 1: 14, 2: 10 }), '見出しの行があっても読める');
  ok(eq(parseRoomsInput('１２　１０　８', 31), { 1: 12, 2: 10, 3: 8 }), '全角の数字も読める');
  ok(eq(roomsFromVacancy({ 1: 14, 2: 10, 3: 28, 4: 0 }, 28), { 1: 14, 2: 18, 3: 0, 4: 28 }), '予約客室数＝28−残室数', JSON.stringify(roomsFromVacancy({ 1: 14, 2: 10, 3: 28, 4: 0 }, 28)));
  ok(eq(roomsFromVacancy({ 1: 40, 2: -3 }, 28), { 1: 0, 2: 28 }), '0〜28に収める');
  ok(eq(roomsFromVacancy({ 1: 10 }, 30), { 1: 20 }), '全客室数を変えれば、その数から引く');
}

console.log('\n=== 日ごとのリクエスト ===');
{
  const rules = defaultSlotRules();
  const P = (t, o = {}) => parseDayRequests(t, { month: 10, daysInMonth: 31, rules, totalRooms: 28, ...o });
  const has = (item, kind) => item.effects.some((e) => e.kind === kind);
  const dayList = (item) => item.days.join(',');

  let r = P('13日は超多忙なので全員出勤');
  ok(r.items.length === 1 && dayList(r.items[0]) === '13' && has(r.items[0], 'full') && r.items[0].note === '超多忙', '「13日は超多忙なので全員出勤」', JSON.stringify(r.items));
  r = P('〇〇日はお祭りなので全員出勤、13日は超多忙なので全員出勤');
  ok(r.items.length === 1 && dayList(r.items[0]) === '13' && r.unread.length === 1 && r.unread[0].why.includes('日にち'), '日にちが「〇〇日」のままの指示は、読み取れないと知らせる（13日のほうは反映）', JSON.stringify(r.unread));
  r = P('20日はお祭りなので全員出勤、13日は超多忙なので全員出勤');
  ok(r.items.length === 2 && r.items[0].note === 'お祭り' && dayList(r.items[0]) === '20' && dayList(r.items[1]) === '13', '1行に2件：20日はお祭り・13日は超多忙', JSON.stringify(r.items.map((i) => i.days)));
  r = P('9、10、11日は超多忙なので全員出勤');
  ok(r.items.length === 1 && dayList(r.items[0]) === '9,10,11' && has(r.items[0], 'full'), '日にちの並び「9、10、11日」');
  r = P('16日から18日はお祭りなので全員出勤');
  ok(dayList(r.items[0]) === '16,17,18', '範囲「16日から18日」');
  r = P('16〜18日は全員出勤');
  ok(dayList(r.items[0]) === '16,17,18', '範囲「16〜18日」');
  r = P('10/13は全員出勤');
  ok(dayList(r.items[0]) === '13' && has(r.items[0], 'full'), '「10/13」の形');
  r = P('10月13日と14日はフル出勤');
  ok(dayList(r.items[0]) === '13,14' && has(r.items[0], 'full'), '「フル出勤」も全員出勤');
  r = P('１３日は全員出勤');
  ok(dayList(r.items[0]) === '13', '全角の数字');
  r = P('13日は満室で清掃4人');
  ok(has(r.items[0], 'rooms') && r.items[0].effects.find((e) => e.kind === 'rooms').value === 28 && r.items[0].effects.find((e) => e.kind === 'clean').value === 4, '「満室で清掃4人」→ 予約客室数28・清掃4名');
  r = P('2日は清掃に3〜4人');
  ok(r.items[0].effects.find((e) => e.kind === 'clean').value === 4 && dayList(r.items[0]) === '2', '「清掃に3〜4人」は上限の4名（「3〜」を日にちと取り違えない）', JSON.stringify(r.items));
  r = P('20日は焼き鳥屋は休み');
  ok(r.items[0].effects.some((e) => e.kind === 'slot' && e.ruleId === 's3' && e.value === 0), '「焼き鳥屋は休み」→ 焼き鳥屋を0名', JSON.stringify(r.items[0].effects));
  r = P('25日はホールを3人');
  ok(r.items[0].effects.some((e) => e.kind === 'slot' && e.ruleId === 's1' && e.value === 3), '「ホールを3人」→ ホール枠を3名');
  r = P('7日は休館');
  ok(has(r.items[0], 'closed'), '「休館」');
  r = P('12日は20室');
  ok(r.items[0].effects.find((e) => e.kind === 'rooms').value === 20 && dayList(r.items[0]) === '12', '「20室」を日にちと取り違えない');
  r = P('13日は全員出勤、清掃は4人');
  ok(r.items.length === 2 && dayList(r.items[1]) === '13' && has(r.items[1], 'clean'), '日にちを省いた2件目は、前の日にちを引き継ぐ', JSON.stringify(r.items.map((i) => [i.days, i.effects.map((e) => e.kind)])));
  r = P('13日は超多忙');
  ok(r.items.length === 0 && r.unread.length === 1 && r.unread[0].why.includes('全員出勤'), '「超多忙」だけでは反映せず、何をするかを書くよう知らせる（勝手に決めない）', JSON.stringify(r.unread));
  r = P('こんにちは');
  ok(r.items.length === 0 && r.unread.length === 1, 'ただの挨拶は反映しない');
  r = P('11/13は全員出勤');
  ok(r.items.length === 0 && r.unread[0].why.includes('この月'), '別の月の日にちは反映しない');
  r = P('※13日は全員出勤 これはメモです');
  ok(r.items.length === 0 && r.unread.length === 0, '※の行はメモとして読み飛ばす');
  r = P('13日は全員休み');
  ok(r.items.length === 0, '「全員休み」を全員出勤と取り違えない', JSON.stringify(r.items));
  r = P('13日は超多忙なので全員出勤。20日はお祭りなので全員出勤');
  ok(r.items.length === 2, '句点で区切った2件');
  r = P('13日は超多忙なので全員出勤\n16日から18日は満室なので全員出勤・清掃4人');
  ok(r.items.length === 2 && r.items[1].effects.length >= 3, '改行で区切った2件（2件目は全員出勤・満室・清掃4人）', JSON.stringify(r.items[1] && r.items[1].effects));
  r = P('31日は全員出勤', { daysInMonth: 30, month: 9 });
  ok(r.items.length === 0, '月の日数を超える日は反映しない');
}

console.log('\n=== 日にちの範囲（全角チルダ・月つき・月またぐ）— レビューで見つかった誤読の再発防止 ===');
{
  const D = (t, month = 10, n = 31) => extractDays(t, month, n).join(',');
  ok(D('21～23日は休み') === '21,22,23', '全角チルダ「21～23日」', D('21～23日は休み'));
  ok(D('15～17') === '15,16,17', '全角チルダ「15～17」');
  ok(D('21－23') === '21,22,23', '全角ハイフン「21－23」');
  ok(D('21−23') === '21,22,23', 'マイナス記号「21−23」');
  ok(D('21〜23') === '21,22,23' && D('21~23') === '21,22,23', '「〜」「~」は今までどおり');
  ok(D('10/9〜10/11') === '9,10,11', '「10/9〜10/11」（途中の10日が抜けない）', D('10/9〜10/11'));
  ok(D('10月9日〜11日') === '9,10,11', '「10月9日〜11日」', D('10月9日〜11日'));
  ok(D('10/21～23') === '21,22,23', '「10/21～23」', D('10/21～23'));
  ok(D('10/9から10/11まで') === '9,10,11', '「10/9から10/11まで」');
  ok(D('10/15〜11/15') === Array.from({ length: 17 }, (_, i) => 15 + i).join(','), '月をまたぐ「10/15〜11/15」は、10月なら15日〜月末', D('10/15〜11/15'));
  ok(D('10/15〜11/15', 11, 30) === Array.from({ length: 15 }, (_, i) => 1 + i).join(','), '同じ範囲を11月で読むと1日〜15日', D('10/15〜11/15', 11, 30));
  ok(D('9/28〜10/3') === '1,2,3', '「9/28〜10/3」は10月なら1〜3日');
  ok(D('9/28〜10/3', 9, 30) === '28,29,30', '同じ範囲を9月で読むと28日〜月末');
  ok(D('12/28〜1/3', 12) === '28,29,30,31' && D('12/28〜1/3', 1) === '1,2,3', '年をまたぐ「12/28〜1/3」');
  ok(D('11/1〜11/5') === '', '別の月だけの範囲は読まない');
  ok(D('19:20那覇着 16朝帰ってくる') === '16', '時刻「19:20」を日にちと取り違えない', D('19:20那覇着 16朝帰ってくる'));

  const members = testMembers();
  const sam = members.find((m) => m.name === 'サムパツ');
  const rr = (text, month = 10, n = 31) => importMessages(text, { members, month, daysInMonth: n });
  let r = rr('サムパツ 10/15から11/15まで休み');
  const daysOf = (res, m) => Object.keys(res.requests[m.id] || {}).map(Number).sort((a, b) => a - b);
  ok(daysOf(r, sam).join(',') === Array.from({ length: 17 }, (_, i) => 15 + i).join(','), '「サムパツ 10/15から11/15まで休み」→ 15〜31日が休み（1〜15日が休みになる誤読をしない）', daysOf(r, sam).join(','));
  r = rr('サムパツ 10/15〜11/15休');
  ok(daysOf(r, sam).join(',') === Array.from({ length: 17 }, (_, i) => 15 + i).join(','), '「サムパツ 10/15〜11/15休」→ 15〜31日');
  r = rr('サムパツ10/15～11/15休(19:20那覇着) 16朝帰ってくる');
  ok(daysOf(r, sam).join(',') === Array.from({ length: 17 }, (_, i) => 15 + i).join(','), '10月シートのメモ「サムパツ10/15～11/15休(19:20那覇着)…」→ 15日以降が休み（時刻の19・20を日にちにしない）', daysOf(r, sam).join(','));
  r = rr('サム10/15～11/15休(19:20那覇着) 16朝帰ってくる');
  ok(r.unassigned && r.unassigned.days.join(',') === Array.from({ length: 17 }, (_, i) => 15 + i).join(','), '略称「サム」は誰か決められないので「誰の希望休か分かりません」に出す（日にちは15〜31日と読めている）', r.unassigned && r.unassigned.days.join(','));
  const miya = members.find((m) => m.name === '宮平 絹江');
  r = rr('宮平 21～23日は休み');
  ok(daysOf(r, miya).join(',') === '21,22,23', '「宮平 21～23日は休み」', daysOf(r, miya).join(','));
  r = rr('宮平 9/21～23');
  ok(daysOf(r, miya).join(',') === '', '別の月の「9/21～23」は10月には入れない', daysOf(r, miya).join(',')) || 0;
}

console.log('\n=== 予約客室数の貼り付け：日付つきの行だけを読む・読み方の表示 ===');
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let d = parseRoomsInputDetail('10月\t残室\n10/1\t14\n10/2\t10', 31, 1, { month: 10 });
  ok(eq(d.rooms, { 1: 14, 2: 10 }) && d.mode === 'pairs', '数字入りの見出し（「10月 残室」）があっても、日付つきの行だけを読む', JSON.stringify(d));
  d = parseRoomsInputDetail('10/1\t14\n10/2\t10\n合計\t34', 31, 1, { month: 10 });
  ok(eq(d.rooms, { 1: 14, 2: 10 }), '「合計 34」の行が3日目にならない', JSON.stringify(d.rooms));
  d = parseRoomsInputDetail('14 10 8', 31);
  ok(d.mode === 'sequence' && eq(d.rooms, { 1: 14, 2: 10, 3: 8 }), '数字だけの並びは sequence と分かる');
  d = parseRoomsInputDetail('日付,曜日,予約,残室\n1,木,14,14', 31);
  ok(d.mode === 'sequence', '列が多い表は、日付つきの行と見なさない（画面で確認を出す）', JSON.stringify(d));
}

console.log('\n=== 日ごとのリクエスト：区切り・否定・月つき（レビューの指摘） ===');
{
  const rules = defaultSlotRules();
  const P = (t) => parseDayRequests(t, { month: 10, daysInMonth: 31, rules, totalRooms: 28 });
  const dl = (i) => i.days.join(',');
  let r = P('12日は全員出勤 13日は満室');
  ok(r.items.length === 2 && dl(r.items[0]) === '12' && r.items[0].effects.length === 1 && r.items[0].effects[0].kind === 'full'
    && dl(r.items[1]) === '13' && r.items[1].effects[0].kind === 'rooms' && !r.items[1].effects.some((e) => e.kind === 'full'),
    '空白だけで区切った2件を別々に読む（12日は全員出勤・13日は満室）', JSON.stringify(r.items.map((i) => [i.days, i.effects.map((e) => e.kind)])));
  r = P('25日は全員出勤ではない');
  ok(r.items.length === 0 && r.unread.length === 1 && r.unread[0].why.includes('否定'), '「全員出勤ではない」は全員出勤にしない', JSON.stringify(r.unread));
  r = P('14日は全員出勤しない');
  ok(r.items.length === 0, '「全員出勤しない」も反映しない');
  r = P('10/9〜10/11は全員出勤');
  ok(r.items.length === 1 && dl(r.items[0]) === '9,10,11', '「10/9〜10/11は全員出勤」', JSON.stringify(r.items.map((i) => i.days)));
  r = P('16～18日はお祭りなので全員出勤');
  ok(dl(r.items[0]) === '16,17,18' && r.items[0].note === 'お祭り', '「16～18日はお祭りなので全員出勤」（全角チルダ）');
  r = P('9 10 11日は超多忙なので全員出勤');
  ok(r.items.length === 1 && dl(r.items[0]) === '9,10,11', '空白で並べた日にち「9 10 11日」', JSON.stringify(r.items.map((i) => i.days)));
}

console.log('\n=== 呼び名（スー・ケー・アナ）での照合 ===');
{
  const members = testMembers().map((m) => ({ ...m }));
  const kyi = members.find((m) => m.name === 'KYI SU THAR');
  const ei = members.find((m) => m.name === 'EI KAY ZIN HAN');
  kyi.nicknames = ['スー'];
  ei.nicknames = ['ケー'];
  const r = importMessages(['スー 13日は休み', 'ケー 14日、15日休み'].join('\n'), { members, month: 10, daysInMonth: 31 });
  const daysOf = (m) => Object.keys(r.requests[m.id] || {}).map(Number).sort((a, b) => a - b);
  ok(daysOf(kyi).join(',') === '13', '「スー 13日は休み」→ KYI SU THAR さんの希望休', daysOf(kyi).join(','));
  ok(daysOf(ei).join(',') === '14,15', '「ケー 14日、15日休み」→ EI KAY ZIN HAN さんの希望休', daysOf(ei).join(','));
  ok(r.matched.length === 2, '2件とも取り込み済みに出る');

  // 呼び名が無い人（nicknames未設定）には影響しない
  const noNick = importMessages('スー 13日は休み', { members: testMembers(), month: 10, daysInMonth: 31 });
  ok(!noNick.matched.length && (!noNick.unassigned || noNick.unassigned.text.includes('スー')), '呼び名を登録していない名簿では、「スー」だけでは誰か分からない');
}

console.log(failed === 0 ? '\n全項目 PASS' : '\n' + failed + '件 FAIL');
process.exit(failed === 0 ? 0 : 1);
