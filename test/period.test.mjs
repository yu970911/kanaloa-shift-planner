// 15日ごとの期間・締切・通知文・期間ごとの生成、焼き鳥屋・夜のホール・全員出勤の確認: node test/period.test.mjs
import { defaultMembers, defaultSlotRules, defaultOptions, buildDays, lunchDuty } from '../js/model.js';
import {
  periodRange, periodStart, deadlineOf, nextPeriod, shiftPeriod, deadlineStatus, deadlineMessage, buildNotice, dayText,
} from '../js/period.js';
import { generateShift, validate, laborIssues } from '../js/solver.js';

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  … ' + extra : ''));
  if (!cond) failed++;
};

console.log('=== 期間（前半 1〜15日 ／ 後半 16日〜月末） ===');
{
  const a = periodRange(2026, 10, 'first'), b = periodRange(2026, 10, 'second');
  ok(a.from === 1 && a.to === 15 && b.from === 16 && b.to === 31, '10月：前半1〜15日／後半16〜31日', `${a.span} ${b.span}`);
  ok(periodRange(2026, 9, 'second').to === 30 && periodRange(2026, 2, 'second').to === 28 && periodRange(2028, 2, 'second').to === 29, '月末は月によって変わる（30・28・29日）');
  ok(a.length === 15 && b.length === 16, '期間の日数');
  ok(b.title === '10月後半（10/16〜10/31）', '見出し', b.title);
}

console.log('\n=== 締切（開始日の2日前） ===');
{
  const f = deadlineOf(2026, 10, 'first'), s = deadlineOf(2026, 10, 'second');
  ok(f.getMonth() === 8 && f.getDate() === 29, '10月前半の締切は 9/29', `${f.getMonth() + 1}/${f.getDate()}`);
  ok(s.getMonth() === 9 && s.getDate() === 14, '10月後半の締切は 10/14', `${s.getMonth() + 1}/${s.getDate()}`);
  const y = deadlineOf(2027, 1, 'first');
  ok(y.getFullYear() === 2026 && y.getMonth() === 11 && y.getDate() === 30, '年をまたぐ：1月前半の締切は 12/30');
  ok(deadlineStatus(new Date(2026, 8, 20), f, null).state === 'ok', '余裕あり');
  ok(deadlineStatus(new Date(2026, 8, 27), f, null).state === 'soon', '3日以内は注意');
  ok(deadlineStatus(new Date(2026, 8, 29), f, null).state === 'today', '当日');
  ok(deadlineStatus(new Date(2026, 8, 30), f, null).state === 'overdue', '過ぎたら警告');
  ok(deadlineStatus(new Date(2026, 8, 30), f, '2026-09-28').state === 'done', '確定済みなら警告しない');
  const msg = deadlineMessage(periodRange(2026, 10, 'first'), f, deadlineStatus(new Date(2026, 8, 30), f, null));
  ok(msg.includes('過ぎて') && msg.includes('9/29'), '過ぎたときの文言', msg);
}

console.log('\n=== 次の期間・前後の移動 ===');
{
  const n1 = nextPeriod(new Date(2026, 8, 28));
  ok(n1.year === 2026 && n1.month === 10 && n1.which === 'first', '9/28 の次は 10月前半', JSON.stringify(n1));
  const n2 = nextPeriod(new Date(2026, 9, 3));
  ok(n2.month === 10 && n2.which === 'second', '10/3 の次は 10月後半');
  const n3 = nextPeriod(new Date(2026, 9, 16));
  ok(n3.month === 11 && n3.which === 'first', '10/16 は後半の開始日なので、次は 11月前半');
  const n4 = nextPeriod(new Date(2026, 11, 20));
  ok(n4.year === 2027 && n4.month === 1 && n4.which === 'first', '12/20 の次は 翌年1月前半');
  const p = shiftPeriod({ year: 2026, month: 10, which: 'first' }, -1);
  ok(p.year === 2026 && p.month === 9 && p.which === 'second', '10月前半の前は 9月後半');
  const q = shiftPeriod({ year: 2026, month: 12, which: 'second' }, 1);
  ok(q.year === 2027 && q.month === 1 && q.which === 'first', '12月後半の次は 翌年1月前半');
}

// 2026年10月の名簿・ルール（実際の既定値）。自動割当は7名（宮平・日下・薄田・EI・KYI・ギミレ・サムパツ）
const members = defaultMembers().filter((m) => m.active !== false);
const rules = defaultSlotRules();
const options = { ...defaultOptions(), iterations: 200 };
const byName = (n) => members.find((m) => m.name === n);
const MIYA = '宮平 絹江', DOWN = '日下 堅人';
const FULL1 = [9, 10, 11], FULL2 = [16, 17, 18];
const NEEDS = { 2: { clean: 4 } };
const all = buildDays(2026, 10, {}, [], options.defaultRooms, NEEDS, [...FULL1, ...FULL2]);
const d1 = all.filter((d) => d.day <= 15);
const d2 = all.filter((d) => d.day >= 16);
const ctx1 = (extra = {}) => ({ days: d1, genFrom: 1, monthDays: 31, members, requests: {}, streaks: {}, rules, options, ...extra });
const ctx2 = (prior, extra = {}) => ({ days: all, genFrom: 16, monthDays: 31, prior, members, requests: {}, streaks: {}, rules, options, ...extra });
const dWorkers = (grid, d) => members.filter((m) => grid[m.id][d.day] === 'D').map((m) => m.name);
const who = (grid, day, sym) => members.filter((m) => grid[m.id][day] === sym).map((m) => m.name);
const isWork = (v) => !!v && v !== '休' && v !== '特' && v !== '✖';

const first = generateShift(ctx1());
const second = generateShift(ctx2(first.grid));

console.log('\n=== 焼き鳥屋のルール（D・水曜と土曜が休み） ===');
{
  const r = first;
  ok(d1.filter((d) => d.dow === 3 || d.dow === 6).every((d) => d.full || dWorkers(r.grid, d).length === 0), '水曜・土曜は焼き鳥屋（D）に誰も入らない（全員出勤の日を除く）');
  const open = d1.filter((d) => dWorkers(r.grid, d).length > 0 && d.dow !== 3 && d.dow !== 6);
  ok(open.length > 0 && open.every((d) => dWorkers(r.grid, d).length === 2), '営業する日は D が2名', open.map((d) => d.day + ':' + dWorkers(r.grid, d).length).join(' '));
  ok(open.every((d) => dWorkers(r.grid, d).includes(DOWN)), '営業する日は必ず日下さんが入る');
  const shut = d1.filter((d) => d.dow !== 3 && d.dow !== 6 && dWorkers(r.grid, d).length === 0);
  ok(shut.every((d) => r.grid[byName(DOWN).id][d.day] !== 'D'), '日下さんが休みの日は焼き鳥屋も休業', shut.map((d) => d.label).join('・') || '（休業日なし）');
  ok(r.issues.filter((i) => i.type === 'closure').length === shut.length, '休業になる日はお知らせに出る');
  ok(r.issues.filter((i) => i.type === 'shortage' && !i.optional).length === 0, '実際の名簿（自動割当7名）で、必須の枠は前半とも埋まる', r.issues.filter((i) => i.type === 'shortage' && !i.optional).map((i) => i.message).join(' / '));
  const others = new Set(d1.flatMap((d) => dWorkers(r.grid, d)).filter((n) => n !== DOWN));
  ok([...others].every((n) => ['ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'].includes(n)), '日下さん以外は アスナ・KYI SU・EI KAY ZIN HAN だけ', [...others].join('・'));
  const vv = validate(ctx1(), r.grid);
  ok(vv.issues.filter((i) => i.type === 'shortage' && !i.optional).length === 0, '組んだあとの確認でも、営業日の不足はない');
}
{
  // アスナさんが休みの日は、KYI SU・EI KAY ZIN HAN が入る
  const asuna = byName('ギミレ アスナ');
  const req = { [asuna.id]: { 1: '休', 2: '休', 4: '休', 5: '休' } };
  const r = generateShift(ctx1({ requests: req }));
  const days = [1, 2, 4, 5].map((day) => d1.find((d) => d.day === day)).filter((d) => dWorkers(r.grid, d).includes(DOWN));
  ok(days.length > 0 && days.every((d) => {
    const w = dWorkers(r.grid, d);
    return w.length === 2 && (w.includes('KYI SU THAR') || w.includes('EI KAY ZIN HAN')) && !w.includes('ギミレ アスナ');
  }), 'アスナさんが休みの日は KYI SU か EI KAY ZIN HAN が入る', days.map((d) => d.day + ':' + dWorkers(r.grid, d).join('+')).join(' '));
  const out = members.filter((m) => !['日下 堅人', 'ギミレ アスナ', 'KYI SU THAR', 'EI KAY ZIN HAN'].includes(m.name));
  ok(d1.every((d) => out.every((m) => r.grid[m.id][d.day] !== 'D')), '焼き鳥屋には サムパツさんなど、決めた人以外は入らない');
}
{
  // 日下さんが希望休の日は休業（ほかの人だけでは営業しない）
  const kusaka = byName(DOWN);
  const r = generateShift(ctx1({ requests: { [kusaka.id]: { 5: '休', 6: '休' } } }));
  ok([5, 6].every((day) => dWorkers(r.grid, d1.find((d) => d.day === day)).length === 0), '日下さんが希望休の日は、焼き鳥屋は休業');
}

console.log('\n=== 昼夜のH（宮平さんの厨房・清掃とホール）とB（送迎・フロント） ===');
{
  const r = first;
  const hall = (day) => who(r.grid, day, 'H').filter((n) => n !== MIYA);
  const norm = d1.filter((d) => !d.full && d.day !== 2);
  ok(norm.filter((d) => d.dow >= 1 && d.dow <= 5 && !d.hol).every((d) => hall(d.day).length === 1), '平日の清掃・ホール（H）は1名', norm.map((d) => hall(d.day).length).join(''));
  ok(norm.filter((d) => d.dow === 0 || d.dow === 6 || d.hol).every((d) => hall(d.day).length === 2), '土・日・祝は2名', norm.filter((d) => d.dow === 0 || d.dow === 6 || d.hol).map((d) => `${d.label}:${hall(d.day).length}`).join(' '));
  ok(hall(2).length === 2, '10/2 は清掃4名（B1・アスナさん1・H2）にするので、Hは2名', String(hall(2).length));
  const hWorkers = new Set(), bWorkers = new Set();
  for (const d of d1.filter((x) => !x.full)) { for (const n of hall(d.day)) hWorkers.add(n); for (const n of who(r.grid, d.day, 'B')) bWorkers.add(n); }   // 全員出勤の日は、余った人がどのパターンにも入る
  ok(![...hWorkers].some((n) => n === DOWN), 'Hのホール・清掃に日下さん（厨房）は入らない（全員出勤の日を除く）', [...hWorkers].join('・'));
  ok([...bWorkers].every((n) => ['サムパツ', 'KYI SU THAR', 'EI KAY ZIN HAN', '薄田 裕花'].includes(n)), 'Bに入るのは サムパツ・KYI SU・EI KAY ZIN HAN・薄田だけ（ギミレ・宮平・日下は入らない。全員出勤の日を除く）', [...bWorkers].join('・'));
  ok(d1.filter((d) => !d.full).every((d) => who(r.grid, d.day, 'B').length >= 1), '毎日、朝8時のBが1名以上いる（送迎・フロント）');
  const miya = byName(MIYA);
  const miyaH = d1.filter((d) => r.grid[miya.id][d.day] === 'H').length;
  const miyaOther = d1.filter((d) => isWork(r.grid[miya.id][d.day]) && r.grid[miya.id][d.day] !== 'H').length;
  ok(miyaH >= 8 && miyaOther === 0, '宮平さんはHで入る（9月後半のシートと同じ）', `H${miyaH}日 / ほか${miyaOther}日`);
  const shima = byName('島村 友子');
  ok(d1.every((d) => r.grid[shima.id][d.day] === null), '島村さんは不在のため空白（手入力のみ・自動では触らない）');
  ok(r.dayStats.every((x) => x.filled <= x.required), '島村さんは枠の人数に数えない（充足が必要人数を超えない）');
}

console.log('\n=== 全員出勤の日（10/9・10・11、10/16・17・18） ===');
{
  const staff = members.filter((m) => m.mode === 'auto' || m.mode === 'always');
  const missing = (r, day) => staff.filter((m) => !(isWork(r.grid[m.id][day]) || (m.mode === 'always' && r.grid[m.id][day] === ''))).map((m) => m.name);
  for (const day of FULL1) ok(missing(first, day).length === 0, `10/${day} は全員出勤`, missing(first, day).join('・') || `出勤${staff.length}名`);
  for (const day of FULL2) ok(missing(second, day).length === 0, `10/${day} は全員出勤`, missing(second, day).join('・') || `出勤${staff.length}名`);
  ok(first.issues.filter((i) => i.type === 'fullDay').length === 0 && second.issues.filter((i) => i.type === 'fullDay').length === 0, '全員出勤の日の違反はない');
  // 焼き鳥屋が休みの土曜・日曜は、日下さん・アスナさんもDではなく別のパターンで出勤する
  const kusa = byName(DOWN), asuna = byName('ギミレ アスナ');
  ok(first.grid[kusa.id][10] !== 'D' && isWork(first.grid[kusa.id][10]) && first.grid[asuna.id][10] !== 'D' && isWork(first.grid[asuna.id][10]),
    '10/10（土・焼き鳥屋は休み）の全員出勤：日下さん・アスナさんもDではなく別のパターンで出勤', `${first.grid[kusa.id][10]} / ${first.grid[asuna.id][10]}`);
  // 希望休の人は、全員出勤の日でも休みのまま（違反として知らせる）
  const miya = byName(MIYA);
  const r2 = generateShift(ctx1({ requests: { [miya.id]: { 10: '休' } } }));
  ok(r2.grid[miya.id][10] === '休', '全員出勤の日でも、希望休は守る');
  ok(r2.issues.some((i) => i.type === 'fullDay' && i.day === 10 && i.message.includes('宮平')), '守れないときは申し送りに出る');
}

console.log('\n=== 期間ごとの生成（前半 → 後半） ===');
{
  let changed = 0;
  for (const m of members) for (const d of d1) if (second.grid[m.id][d.day] !== first.grid[m.id][d.day]) changed++;
  ok(changed === 0, '後半を組んでも、前半の結果は1マスも変わらない');
  ok(second.dayStats.length === 16 && second.dayStats[0].day === 16, '後半の日別集計は16〜31日の16日分');
  ok(members.every((m) => d1.every((d) => second.grid[m.id][d.day] !== undefined || m.mode === 'manual')), '後半の結果にも前半の値が入っている');
  const v = validate(ctx2(first.grid), second.grid);
  const hard = v.issues.filter((i) => !(i.type === 'shortage' && i.optional) && i.type !== 'closure');
  ok(hard.length === 0, '後半まで組んだ月全体で、必須の枠・連勤・休日数・労働時間・法定休日の問題がない', hard.map((i) => i.message).join(' / '));
  ok(v.dayStats.length === 16, '確認の集計も今回の期間（16日分）だけ');
  const st = v.memberStats.find((s) => s.id === byName(DOWN).id);
  ok(st.off >= 8 && st.pWork + st.pOff === 16, '日下さん：月の休みは8日以上、今回の期間ぶんも数えている', `月 出${st.work}/休${st.off}、今回 出${st.pWork}/休${st.pOff}`);
  ok(laborIssues(members, all, second.grid, options).filter((i) => i.type !== 'off').length === 0, '月の労働時間の上限を超えない（前半＋後半の合計）');
  ok(v.memberStats.filter((s) => byName(s.name).mode === 'auto').every((s) => s.maxStreak <= 6), '連勤は6日まで', v.memberStats.map((s) => s.maxStreak).join(','));

  // 連勤の引き継ぎ：前半の最後の6日を連続出勤にした人は、後半の最初の日は休む
  const prior = JSON.parse(JSON.stringify(first.grid));
  const target = byName('薄田 裕花');
  for (let d = 10; d <= 15; d++) prior[target.id][d] = 'B';
  const r2 = generateShift(ctx2(prior, { requests: {} }));
  ok(r2.grid[target.id][16] === '休', '前半の最後が6連勤なら、後半の初日は休みにする（連勤の引き継ぎ）', String(r2.grid[target.id][16]));
}
{
  // 前半だけ：休日数・出勤の目安は日割り。前半だけで月分の休みを取りすぎない
  const auto = members.filter((m) => m.mode === 'auto');
  const offs = auto.map((m) => d1.filter((d) => !isWork(first.grid[m.id][d.day])).length);
  ok(offs.every((n) => n >= 4 && n <= 9), '前半15日の休みは、月8日を日割りにした4日以上（焼き鳥屋の休みの日を含めて9日まで）', offs.join(','));
}

console.log('\n=== 清掃人数の指定が満たされているかの確認 ===');
{
  const kusa = byName(DOWN);
  // 10/2 は清掃4名の指定。日下さんが休みだと焼き鳥屋が休業になり、D のアスナさんも入らないので、指定に届かない
  const req = { [kusa.id]: { 2: '休' } };
  const r = generateShift(ctx1({ requests: req }));
  const v = validate(ctx1({ requests: req }), r.grid);
  const lack = v.issues.filter((i) => i.type === 'cleanLack' && i.day === 2);
  const actual = who(r.grid, 2, 'B').length + who(r.grid, 2, 'H').filter((n) => n !== MIYA).length + dWorkers(r.grid, d1[1]).filter((n) => n !== DOWN).length;
  ok(actual >= 4 || lack.length === 1, '清掃4名の指定に届かないときは、申し送り（cleanLack）に出る', `実際${actual}名 / 申し送り${lack.length}件`);
  const ok2 = validate(ctx1(), first.grid).issues.filter((i) => i.type === 'cleanLack');
  ok(ok2.length === 0, '日下さんが入る普通の組み方では、10/2の清掃4名は満たされている', ok2.map((i) => i.message).join(' / '));
}

console.log('\n=== 通知文 ===');
{
  const period = periodRange(2026, 10, 'first');
  const n = buildNotice({ period, members, days: d1, grid: first.grid });
  ok(n.common.includes('10月前半（10/1〜10/15）') && n.common.includes('シフト'), '全体向けの文面に期間が入る');
  const kusaka = n.perPerson.find((p) => p.name === DOWN);
  ok(kusaka && kusaka.text.split('\n').filter((l) => /^\d+\/\d+\(/.test(l)).length === 15, '個人向けは15日分の行が並ぶ');
  ok(kusaka.text.includes('D　11:00〜14:00 / 17:00〜22:00（11:00〜14:00は厨房）') && kusaka.text.includes('休み'), '勤務は時間つき、休みは「休み」と出る');
  ok(kusaka.work + kusaka.off === 15, '出勤日数と休み日数の合計が期間の日数と合う', `出${kusaka.work}/休${kusaka.off}`);
  ok(!n.perPerson.some((p) => p.name === '島村 友子'), '不在で空白の島村さんには送らない');
  ok(!n.perPerson.some((p) => p.name === '川島裕介'), '役員の川島さんには勤務の通知を作らない（毎日いる扱いのため）');
  ok(dayText({ name: '常勤の人', mode: 'always', workFrom: 11, dailyHours: 4 }, '') === '出勤　11:00〜15:00', '記号なしの常勤は、出勤時間を出す');
  ok(dayText({ mode: 'auto' }, undefined) === '未定', 'まだ組んでいない日は「未定」');
  ok(!n.perPerson.some((p) => p.name === '石橋 大樹'), '在籍を外した人には送らない');
}

console.log('\n=== ランチの時間の仕事（宮平・日下は厨房、ほかは清掃） ===');
{
  const miya = byName(MIYA), kusa = byName(DOWN), asuna = byName('ギミレ アスナ');
  ok(lunchDuty(miya, 'H').duty === '厨房' && lunchDuty(kusa, 'D').duty === '厨房', '宮平さん・日下さんは、ランチの時間は厨房');
  ok(lunchDuty(asuna, 'H').duty === '清掃' && lunchDuty(asuna, 'D').duty === '清掃' && lunchDuty(byName('KYI SU THAR'), 'H').duty === '清掃', 'ほかの人は、ランチの時間は清掃');
  ok(lunchDuty(asuna, 'B') === null && lunchDuty(asuna, 'F') === null, 'ランチの時間帯が無いパターン（B・Fなど）には付けない');
  ok(dayText(asuna, 'D') === 'D　11:00〜14:00 / 17:00〜22:00（11:00〜14:00は清掃）', '通知文：アスナさんのDは、昼は清掃と出る', dayText(asuna, 'D'));
  ok(dayText(kusa, 'D').includes('11:00〜14:00は厨房'), '通知文：日下さんのDは、昼は厨房と出る');
  ok(dayText(miya, 'H') === 'H　10:30〜13:30 / 16:30〜21:30（10:30〜13:30は厨房）' && dayText(asuna, 'H').includes('10:30〜13:30は清掃'), '通知文：Hも同じ', dayText(miya, 'H'));
}

console.log(failed === 0 ? '\n全項目 PASS' : '\n' + failed + '件 FAIL');
process.exit(failed === 0 ? 0 : 1);
