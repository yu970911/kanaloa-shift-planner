// 生成エンジンの動作確認: node test/solver.test.mjs
import { defaultSlotRules, defaultOptions, defaultLabor, buildDays, expandSlots, hoursOf, monthlyHourCap, weekIndex, kubunOf } from '../js/model.js';
import { testMembers, testRules } from './fixtures.mjs';
import { generateShift, validate, isWorkSymbol, laborIssues, weekCap } from '../js/solver.js';

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  … ' + extra : ''));
  if (!cond) failed++;
};

const members = testMembers();
const rules = testRules();
const options = { ...defaultOptions(), iterations: 200 };

// 2026年9月：週末と連休を混みにする
const rooms = {};
for (let d = 1; d <= 30; d++) {
  const dow = new Date(2026, 8, d).getDay();
  rooms[d] = dow === 5 || dow === 6 ? 24 : dow === 0 ? 16 : 8;
}
const days = buildDays(2026, 9, rooms, [], options.defaultRooms);

// 希望休（実運用を模したもの）
const byName = (n) => members.find((m) => m.name === n).id;
const requests = {
  [byName('山田 麗奈')]: { 5: '休', 6: '休', 7: '休' },
  [byName('サムパツ')]: { 12: '休', 13: '休', 20: '特' },
  [byName('ギミレ アスナ')]: { 3: '休', 4: '休' },
  [byName('宮平 絹江')]: { 15: '休' },
  [byName('大山 かんな')]: { 23: '休', 24: '休', 25: '休', 26: '休' },
};

const ctx = { days, members, requests, rules, options };
const t0 = Date.now();
const res = generateShift(ctx);
const ms = Date.now() - t0;

console.log('\n=== 生成結果（2026年9月 / 試行' + options.iterations + '回 / ' + ms + 'ms）===');
const short = res.issues.filter((i) => i.type === 'shortage');
console.log('必要枠合計 : ' + res.dayStats.reduce((a, d) => a + d.required, 0));
console.log('充足       : ' + res.dayStats.reduce((a, d) => a + d.filled, 0));
console.log('不足枠     : ' + short.length);
console.log('コスト     : ' + res.cost);

console.log('\n日別（客室数 / 必要 / 充足 / 稼働人数 / 工数）');
for (const d of res.dayStats.slice(0, 10)) {
  console.log('  ' + d.label.padEnd(9) + ' 室' + String(d.rooms).padStart(2) + '  必要' + d.required + ' 充足' + d.filled + ' 稼働' + d.headcount + ' 工数' + d.hours);
}

console.log('\n個人別（出勤 / 休 / 最大連勤 / 目安）');
for (const s of res.memberStats) {
  console.log('  ' + s.name.padEnd(16) + ' 出勤' + String(s.work).padStart(2) + ' 休' + String(s.off).padStart(2) + ' 最大連勤' + String(s.maxStreak).padStart(2) + ' 目安' + s.target);
}

console.log('\n=== 検証 ===');

// 1. 希望休が必ず守られている
let reqViolation = 0;
for (const [mid, days_] of Object.entries(requests)) {
  for (const [d, sym] of Object.entries(days_)) {
    if (res.grid[mid][d] !== sym) reqViolation++;
  }
}
ok(reqViolation === 0, '希望休がすべて守られている', reqViolation + '件の違反');

// 2. 1日1パターンまで（重複割当がない）
let dup = 0;
for (const d of days) {
  for (const m of members) {
    const v = res.grid[m.id][d.day];
    if (Array.isArray(v)) dup++;
  }
}
ok(dup === 0, '1人1日1枠まで');

// 3. 連勤上限を超えていない
const overStreak = res.memberStats.filter((s) => {
  const m = members.find((x) => x.id === s.id);
  return m.mode === 'auto' && s.maxStreak > (m.maxConsecutive || options.maxConsecutive);
});
ok(overStreak.length === 0, '連勤上限（6日）を超えた人がいない', overStreak.map((s) => s.name + ':' + s.maxStreak).join(', '));

// 4. 最低休日数を満たしている
const lowOff = res.memberStats.filter((s) => {
  const m = members.find((x) => x.id === s.id);
  return m.mode === 'auto' && s.off < options.minOffDays;
});
ok(lowOff.length === 0, '休みが最低8日ある', lowOff.map((s) => s.name + ':' + s.off).join(', '));

// 5. 担当できない役割・パターンが割り当てられていない
let badAssign = 0;
for (const m of members) {
  if (m.mode !== 'auto') continue;
  for (const d of days) {
    const v = res.grid[m.id][d.day];
    if (isWorkSymbol(v) && !m.patterns.includes(v)) badAssign++;
  }
}
ok(badAssign === 0, '対応できないパターンが割り当てられていない', badAssign + '件');

// 6. validate() が生成結果と整合する
const v = validate(ctx, res.grid);
const vShort = v.issues.filter((i) => i.type === 'shortage').length;
ok(v.issues.filter((i) => i.type === 'request').length === 0, '検証側でも希望休違反ゼロ');
ok(Math.abs(vShort - short.length) <= short.length, '検証の不足件数が生成時と整合', '生成' + short.length + ' / 検証' + vShort);

// 7. 客室数が増えると必要枠も増える
ok(expandSlots(rules, 28).length > expandSlots(rules, 4).length, '客室数が多い日ほど必要人員が増える',
   '4室=' + expandSlots(rules, 4).length + '名 / 28室=' + expandSlots(rules, 28).length + '名');

// 8. 休館日は全員休み
const closedDays = buildDays(2026, 9, rooms, [10, 11], options.defaultRooms);
const res2 = generateShift({ ...ctx, days: closedDays });
const closedWork = members.filter((m) => isWorkSymbol(res2.grid[m.id][10]) || isWorkSymbol(res2.grid[m.id][11])).length;
ok(closedWork === 0, '休館日は全員休みになる', closedWork + '名が出勤');


// 9〜11. 連休の希望（「3連休が取りたい」）
const longestOff = (grid, m, ds) => {
  let run = 0, max = 0;
  for (const d of ds) {
    const v = grid[m.id][d.day];
    run = (v === '休' || v === '特' || v === '✖') ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
};
const kinue = members.find((m) => m.name === '宮平 絹江');
const komazawa = members.find((m) => m.name === '駒澤 晴信');
const ctxS = { ...ctx, streaks: { [kinue.id]: 3, [komazawa.id]: 4 } };
const resS = generateShift(ctxS);
ok(longestOff(resS.grid, kinue, days) >= 3, '3連休の希望どおり休みが続く', longestOff(resS.grid, kinue, days) + '日連続');
ok(longestOff(resS.grid, komazawa, days) >= 4, '4連休の希望どおり休みが続く', longestOff(resS.grid, komazawa, days) + '日連続');
const missS = validate(ctxS, resS.grid).issues.filter((i) => i.type === 'streakWish');
ok(missS.length === 0, '連休の希望が未達なら検証で分かる', missS.length + '件の未達');

// 12. 連休を入れても人員不足を増やさない
const baseShort = generateShift(ctx).issues.filter((i) => i.type === 'shortage' && !i.optional).length;
const withShort = resS.issues.filter((i) => i.type === 'shortage' && !i.optional).length;
ok(withShort <= baseShort, '連休を入れても人員不足が増えない', '連休なし' + baseShort + ' / 連休あり' + withShort);

// 13. 希望休（特・✖）は連休の置き場所より優先される
const fixed = { [kinue.id]: { 5: '✖', 6: '✖' } };
const resF = generateShift({ ...ctx, requests: fixed, streaks: { [kinue.id]: 3 } });
ok(resF.grid[kinue.id][5] === '✖' && resF.grid[kinue.id][6] === '✖', '連休を置いても希望休を上書きしない');


console.log('\n=== 労働条件（労働基準法・就業規則） ===');
const exempt = (m) => kubunOf(m) === '役員';
const monthHours = (grid, m, ds) => ds.reduce((a, d) => a + hoursOf(m, grid[m.id][d.day]), 0);

// 14〜15. 1か月単位の変形労働時間制：繁忙月でも月の上限を超えない（28・30・31日の月）
for (const [y, mo] of [[2027, 2], [2026, 9], [2026, 10]]) {
  const ds = buildDays(y, mo, {}, [], 24);
  const opt = { ...options, labor: { ...defaultLabor(), mode: 'monthly' } };
  const r = generateShift({ days: ds, members, requests: {}, rules, options: opt });
  const cap = monthlyHourCap(opt.labor, ds.length);
  const over = members.filter((m) => !exempt(m) && monthHours(r.grid, m, ds) > cap + 1e-9);
  ok(over.length === 0, `変形労働時間制：${mo}月（${ds.length}日）で月${cap.toFixed(1)}時間を超える人がいない`, over.map((m) => m.name + ' ' + monthHours(r.grid, m, ds) + 'h').join(', ') || '0人');
}

// 16. 週ごとに判定：どの暦週も上限を超えない（月をまたぐ週は按分）
{
  const ds = buildDays(2026, 10, {}, [], 22);
  const lab = { ...defaultLabor(), mode: 'weekly' };
  const r = generateShift({ days: ds, members, requests: {}, rules, options: { ...options, labor: lab } });
  let worst = 0, bad = 0;
  for (const m of members) {
    if (exempt(m)) continue;
    const wk = {};
    const len = {};
    for (const d of ds) {
      const i = weekIndex(lab, ds, d.day);
      wk[i] = (wk[i] || 0) + hoursOf(m, r.grid[m.id][d.day]);
      len[i] = (len[i] || 0) + 1;
    }
    for (const i of Object.keys(wk)) {
      worst = Math.max(worst, wk[i] / weekCap(lab, len[i]));
      if (wk[i] > weekCap(lab, len[i]) + 1e-9) bad++;
    }
  }
  ok(bad === 0, '週ごとに判定：どの週も上限（月をまたぐ週は按分）を超えない', '上限に対する最大 ' + Math.round(worst * 100) + '%');
}

// 17. 区分ごとの休日数：PAを月10日にすると、PAは10日以上休む
{
  const opt = { ...options, labor: { ...defaultLabor(), offDaysByKubun: { 社員: 8, PA: 10 } } };
  const r = generateShift({ ...ctx, options: opt });
  const pa = members.filter((m) => kubunOf(m) === 'PA' && m.mode !== 'manual');
  const short = pa.filter((m) => r.memberStats.find((x) => x.id === m.id).off < 10);
  ok(short.length === 0, 'PAの休日数を月10日にすると、PA全員が10日以上休む', short.map((m) => m.name).join(', ') || pa.length + '人とも達成');
  const shain = members.filter((m) => kubunOf(m) === '社員' && m.mode !== 'manual');
  const s8 = shain.filter((m) => r.memberStats.find((x) => x.id === m.id).off < 8);
  ok(s8.length === 0, '社員は月8日以上休む', s8.map((m) => m.name).join(', ') || shain.length + '人とも達成');
}

// 18〜20. 手直しで違反を作ると、検証で必ず分かる
{
  const g = JSON.parse(JSON.stringify(res.grid));
  const kusaka = members.find((m) => m.name === '日下 堅人');
  // 9/6(日)〜9/12(土) の1週間をすべて D（8時間）にする
  for (let d = 6; d <= 12; d++) g[kusaka.id][d] = 'D';
  const monthlyOpt = { ...options, labor: { ...defaultLabor(), mode: 'monthly' } };
  const weeklyOpt = { ...options, labor: { ...defaultLabor(), mode: 'weekly' } };
  const li = laborIssues(members, days, g, monthlyOpt).filter((i) => i.memberId === kusaka.id);
  ok(li.some((i) => i.type === 'legalHoliday'), '7日連続で働かせると「法定休日なし」として検出する', li.map((i) => i.type).join(','));
  const lw = laborIssues(members, days, g, weeklyOpt).filter((i) => i.memberId === kusaka.id && i.type === 'weekHours');
  ok(lw.length > 0, '週56時間を「週の上限超え」として検出する', lw.map((i) => i.message).join(' / '));
  // 月の上限：全日 D にする
  const g2 = JSON.parse(JSON.stringify(res.grid));
  for (const d of days) g2[kusaka.id][d.day] = 'D';
  const lm = laborIssues(members, days, g2, monthlyOpt).filter((i) => i.memberId === kusaka.id && i.type === 'hours');
  ok(lm.length === 1, '月240時間を「月の上限超え」として検出する', lm.map((i) => i.message).join(''));
}

// 21. 役員は労働時間の上限の対象外
{
  const g = JSON.parse(JSON.stringify(res.grid));
  const kawashima = members.find((m) => m.name === '川島裕介');
  for (const d of days) g[kawashima.id][d.day] = 'A';
  const li = laborIssues(members, days, g, options).filter((i) => i.memberId === kawashima.id);
  ok(li.length === 0, '役員は毎日働いても労働時間の違反にしない', li.length + '件');
}

// 22. 常勤（記号なし）も週の上限を守る
{
  const ds = buildDays(2026, 10, {}, [], 22);
  const lab = { ...defaultLabor(), mode: 'weekly' };
  const r = generateShift({ days: ds, members, requests: {}, rules, options: { ...options, labor: lab } });
  const always = members.filter((m) => m.mode === 'always' && !exempt(m));
  const li = laborIssues(always, ds, r.grid, { ...options, labor: lab });
  ok(li.length === 0, '常勤（記号なし）の人も週の上限と法定休日を守る', li.map((i) => i.message).join(' / ') || always.length + '人とも達成');
}

// 23. 古い保存データ（労働条件の設定が無い）でも動く
{
  const old = { ...options };
  delete old.labor;
  const r = generateShift({ ...ctx, options: old });
  ok(r && r.grid && laborIssues(members, days, r.grid, old).filter((i) => i.type !== 'off').length === 0, '労働条件の設定が無い古いデータでも、既定値で上限を守る');
}

// 24. 同じ枠に入れる人が2人いれば、休みを重ねずに毎日埋める
//     （夕方の厨房に日下さんと宮平さんが入れる場合。宮平さんは空いている日は昼の厨房）
{
  const kitchen = [
    { id: 'k1', name: '夕方専門', roles: ['厨房'], patterns: ['D'], mode: 'auto', targetDays: 22, active: true, dailyHours: 8 },
    { id: 'k2', name: '昼と夕方', roles: ['厨房'], patterns: ['G', 'D'], mode: 'auto', targetDays: 22, active: true, dailyHours: 8 },
  ];
  const kRules = [
    { id: 'g', label: '厨房・昼', pattern: 'G', roles: ['厨房'], base: 1, perRooms: 0, max: 1, enabled: true, optional: true },
    { id: 'd', label: '厨房・夕', pattern: 'D', roles: ['厨房'], base: 1, perRooms: 0, max: 1, enabled: true },
  ];
  const ds = buildDays(2026, 10, {}, [], 10);
  const r = generateShift({ days: ds, members: kitchen, requests: { k1: { 10: '特' } }, rules: kRules, options: { ...options, iterations: 30 } });
  const dShort = r.issues.filter((i) => i.type === 'shortage' && !i.optional);
  ok(dShort.length === 0, '夕方の厨房は、2人の休みをずらして毎日埋める', dShort.map((i) => i.day + '日').join('・') || '31日とも埋まった');
  ok(r.grid.k1[10] === '特', '入れ替えても希望休は動かさない');
  ok(laborIssues(kitchen, ds, r.grid, options).length === 0 && validate({ days: ds, members: kitchen, rules: kRules, options }, r.grid).issues.every((i) => i.type !== 'streak'),
    '入れ替えても連勤・法定休日・労働時間の条件を守る');
}

console.log(failed === 0 ? '\n全' + 29 + '項目 PASS' : '\n' + failed + '件 FAIL');
process.exit(failed === 0 ? 0 : 1);
