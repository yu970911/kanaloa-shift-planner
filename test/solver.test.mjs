// 生成エンジンの動作確認: node test/solver.test.mjs
import { defaultMembers, defaultSlotRules, defaultOptions, buildDays, expandSlots } from '../js/model.js';
import { generateShift, validate, isWorkSymbol } from '../js/solver.js';

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  … ' + extra : ''));
  if (!cond) failed++;
};

const members = defaultMembers();
const rules = defaultSlotRules();
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

console.log(failed === 0 ? '\n全' + 13 + '項目 PASS' : '\n' + failed + '件 FAIL');
process.exit(failed === 0 ? 0 : 1);
