// シフト自動生成エンジン
// 希望休は絶対条件（ハード制約）。連勤上限・出勤日数の目安はソフト制約として最適化します。
import { expandSlots, PATTERNS } from './model.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OFF_SET = ['休', '特', '✖'];
export const isWorkSymbol = (s) => !!s && !OFF_SET.includes(s);

/**
 * シフト案を生成する。
 * ctx = { days, members, requests, streaks, rules, options }
 *   requests: { [memberId]: { [day]: '休' | '特' | '✖' } }
 *   streaks:  { [memberId]: 連続で取りたい休みの日数 }  例: 「3連休が取りたい」→ 3
 * 戻り値: { grid, issues, dayStats, memberStats, cost }
 *   grid: { [memberId]: { [day]: symbol } }
 */
export function generateShift(ctx) {
  const run = createRun(ctx);
  while (run.step(Infinity));
  return run.best;
}

/**
 * 生成を小分けに走らせるための入れ物。
 * 画面を固まらせずに「今どこまで試したか」「今いくつまで良くなったか」を出せる。
 * 数字はすべて実際の探索結果で、演出用の待ち時間は入れていない。
 */
export function createRun(ctx) {
  const { days, members, requests = {}, streaks = {}, rules, options } = ctx;
  const active = members.filter((m) => m.active !== false);
  const total = Math.max(1, options.iterations || 1);
  let done = 0;
  let best = null;
  let improvedAt = 0;

  return {
    total,
    get done() { return done; },
    get best() { return best; },
    get improvedAt() { return improvedAt; },
    /** chunk 回ぶん試す。まだ続きがあれば true を返す */
    step(chunk = 25) {
      const end = Math.min(total, done + chunk);
      while (done < end) {
        const rng = mulberry32((options.seed || 1) * 7919 + done * 104729);
        const cand = buildOne(days, active, requests, streaks, rules, options, rng);
        done++;
        if (!best || cand.cost < best.cost) { best = cand; improvedAt = done; }
        if (best.cost === 0) { done = total; break; }
      }
      return done < total;
    },
  };
}

function buildOne(days, members, requests, streaks, rules, options, rng) {
  const grid = {};
  const state = {};
  for (const m of members) {
    grid[m.id] = {};
    state[m.id] = { work: 0, streak: 0, lastPattern: null, switches: 0 };
  }

  const maxWork = days.length - (options.minOffDays || 0);

  // 1) 確定分を先に置く（希望休・固定休・休館日・常勤・手入力）
  for (const m of members) {
    for (const d of days) {
      const req = requests[m.id] ? requests[m.id][d.day] : null;
      if (req) { grid[m.id][d.day] = req; continue; }
      if (m.fixedOffDows && m.fixedOffDows.includes(d.dow)) { grid[m.id][d.day] = '休'; continue; }
      if (d.closed) { grid[m.id][d.day] = '休'; continue; }
      if (m.mode === 'always') grid[m.id][d.day] = '';        // 出勤（記号なし）
      else if (m.mode === 'manual') grid[m.id][d.day] = null;  // 自動では触らない
    }
  }
  // 1.2) 連休の希望（「3連休が取りたい」）を、なるべくヒマな並びに先に置く。
  //      日にちが決まっていない希望なので、確定分を避けつつこちらで場所を決める。
  const streakMisses = [];
  for (const m of members) {
    if (m.mode === 'manual') continue;
    const n = streaks[m.id];
    if (!n || n < 2) continue;
    if (!placeStreak(m, n, days, grid, rng)) streakMisses.push({ member: m, want: n });
  }

  // 1.5) 常勤（記号なし）の人にも休みを入れる：連勤上限と最低休日数を満たすよう、
  //      なるべく客室数の少ない日を休みに充てる
  for (const m of members) {
    if (m.mode !== 'always') continue;
    placeAlwaysOffs(m, days, grid, options, rng);
    for (const d of days) if (grid[m.id][d.day] === '') state[m.id].work++;
  }

  // 2) 自動割当
  const autoMembers = members.filter((m) => m.mode === 'auto');
  const issues = [];
  const dayStats = [];

  for (const d of days) {
    const slots = d.closed ? [] : expandSlots(rules, d.rooms);
    const assignedToday = new Set();
    const filled = [];

    // 候補が少ない枠から先に埋める（後半で詰むのを防ぐ）
    const order = slots
      .map((s) => ({ slot: s, n: autoMembers.filter((m) => eligible(m, s, d, grid, state, options, maxWork, assignedToday)).length }))
      .sort((a, b) => a.n - b.n)
      .map((x) => x.slot);

    for (const slot of order) {
      const pool = autoMembers.filter((m) => eligible(m, slot, d, grid, state, options, maxWork, assignedToday));
      if (pool.length === 0) {
        issues.push({
          type: 'shortage', day: d.day, label: slot.label, pattern: slot.pattern, roles: slot.roles, optional: slot.optional,
          message: d.label + ' ' + slot.label + '（' + slot.pattern + '）を埋められる人がいません',
        });
        continue;
      }
      const scored = pool.map((m) => ({ m, sc: score(m, slot, state[m.id], options, rng) }));
      scored.sort((a, b) => a.sc - b.sc);
      const pick = scored[0].m;
      grid[pick.id][d.day] = slot.pattern;
      assignedToday.add(pick.id);
      filled.push({ memberId: pick.id, pattern: slot.pattern, label: slot.label });
    }

    // 割り当てのつかなかった自動メンバーは休み
    for (const m of autoMembers) if (grid[m.id][d.day] === undefined) grid[m.id][d.day] = '休';

    // 連勤・出勤日数の更新
    for (const m of members) {
      const v = grid[m.id][d.day];
      const worked = isWorkSymbol(v) || (m.mode === 'always' && v === '');
      const st = state[m.id];
      if (worked) {
        if (m.mode === 'auto') {
          st.work++;
          if (st.lastPattern && st.lastPattern !== v) st.switches++;
          st.lastPattern = v;
        }
        st.streak++;
      } else {
        st.streak = 0;
        st.lastPattern = null;
      }
    }

    dayStats.push({
      day: d.day, label: d.label, rooms: d.rooms, closed: d.closed,
      required: slots.length, filled: filled.length,
      headcount: members.filter((m) => {
        const v = grid[m.id][d.day];
        return isWorkSymbol(v) || (m.mode === 'always' && v === '');
      }).length,
      hours: filled.reduce((a, f) => a + (PATTERNS[f.pattern] ? PATTERNS[f.pattern].hours : 0), 0),
    });
  }

  // 3) 評価
  const memberStats = members.map((m) => statsFor(m, days, grid));
  for (const ms of memberStats) {
    const m = members.find((x) => x.id === ms.id);
    if (m.mode !== 'auto') continue;
    const limit = m.maxConsecutive || options.maxConsecutive;
    if (ms.maxStreak > limit) {
      issues.push({ type: 'streak', memberId: m.id, message: m.name + '：' + ms.maxStreak + '連勤（上限' + limit + '）' });
    }
    if (Math.abs(ms.work - ms.target) > 3) {
      issues.push({ type: 'workload', memberId: m.id, message: m.name + '：出勤' + ms.work + '日（目安' + ms.target + '日）' });
    }
  }

  for (const miss of streakMisses) {
    issues.push({ type: 'streakWish', memberId: miss.member.id, message: miss.member.name + '：' + miss.want + '連休の希望を入れられませんでした' });
  }

  const shortage = issues.filter((i) => i.type === 'shortage' && !i.optional).length;
  const softShortage = issues.filter((i) => i.type === 'shortage' && i.optional).length;
  const imbalance = memberStats.reduce((a, s) => {
    const m = members.find((x) => x.id === s.id);
    return m.mode === 'auto' ? a + Math.abs(s.work - s.target) : a;
  }, 0);
  const switches = Object.values(state).reduce((a, s) => a + s.switches, 0);
  const cost = shortage * 1000 + softShortage * 20 + imbalance * 10 + streakMisses.length * 50
    + (options.keepPattern ? switches : 0);

  return { grid, issues, dayStats, memberStats, cost, shortage };
}

/**
 * 「N連休が取りたい」を叶える。日にちの指定が無い希望なので、
 * 予約の少ない並びを選んで N 日続けて休みにする。
 * すでに N 日連続の休みがあれば何もしない。
 * @returns {boolean} 置けたら true
 */
function placeStreak(m, n, days, grid, rng) {
  const isOff = (day) => {
    const v = grid[m.id][day];
    return v === '休' || v === '特' || v === '✖';
  };
  // すでに条件を満たしていれば触らない
  let run = 0;
  for (const d of days) {
    run = isOff(d.day) ? run + 1 : 0;
    if (run >= n) return true;
  }

  // 置ける窓を探す。希望休（特・✖）が入っている窓は避ける
  const windows = [];
  for (let i = 0; i + n <= days.length; i++) {
    const win = days.slice(i, i + n);
    if (win.some((d) => { const v = grid[m.id][d.day]; return v === '特' || v === '✖'; })) continue;
    // 予約客室数の合計が小さい並びを優先。乱数で散らして試行ごとに違う場所も試す
    const busy = win.reduce((a, d) => a + (d.rooms || 0), 0) + rng() * 8;
    windows.push({ i, busy });
  }
  if (!windows.length) return false;
  windows.sort((a, b) => a.busy - b.busy);
  for (const d of days.slice(windows[0].i, windows[0].i + n)) grid[m.id][d.day] = '休';
  return true;
}

/**
 * 常勤（記号なし）メンバーの休みを配置する。
 * ① 連勤が上限を超えないよう、区間内で一番ヒマな日を休みにする
 * ② 目安の出勤日数・最低休日数に届くまで、ヒマな日から休みを足す
 */
function placeAlwaysOffs(m, days, grid, options, rng) {
  const limit = m.maxConsecutive || options.maxConsecutive || 6;
  const isOff = (day) => grid[m.id][day] !== '';
  const busyness = (d) => (d.rooms || 0) + rng() * 0.5; // 同じ客室数なら散らす

  // ① 連勤上限を超える区間に休みを差し込む
  let streak = [];
  for (const d of days) {
    if (isOff(d.day)) { streak = []; continue; }
    streak.push(d);
    if (streak.length > limit) {
      const target = streak.slice(1).sort((a, b) => busyness(a) - busyness(b))[0];
      grid[m.id][target.day] = '休';
      streak = streak.slice(streak.indexOf(target) + 1);
    }
  }

  // ② 休日数が足りなければ、ヒマな日から追加（休みが連続しないよう配慮）
  const offNeeded = Math.max(options.minOffDays || 0, days.length - (m.targetDays || days.length));
  const countOff = () => days.filter((d) => isOff(d.day)).length;
  const pool = days.filter((d) => !isOff(d.day)).sort((a, b) => busyness(a) - busyness(b));
  for (const d of pool) {
    if (countOff() >= offNeeded) break;
    const prevOff = isOff(d.day - 1);
    const nextOff = isOff(d.day + 1);
    if (prevOff || nextOff) continue;
    grid[m.id][d.day] = '休';
  }
  for (const d of pool) {
    if (countOff() >= offNeeded) break;
    if (!isOff(d.day)) grid[m.id][d.day] = '休';
  }
}

/** 続けて休めている日数の最長 */
function longestOffRun(m, days, grid) {
  let run = 0, max = 0;
  for (const d of days) {
    const v = grid[m.id] ? grid[m.id][d.day] : undefined;
    const off = v === '休' || v === '特' || v === '✖';
    run = off ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
}

function statsFor(m, days, grid) {
  let work = 0, maxStreak = 0, cur = 0;
  for (const d of days) {
    const v = grid[m.id] ? grid[m.id][d.day] : undefined;
    const worked = isWorkSymbol(v) || (m.mode === 'always' && v === '');
    if (worked) { work++; cur++; if (cur > maxStreak) maxStreak = cur; }
    else cur = 0;
  }
  return { id: m.id, name: m.name, work, off: days.length - work, maxStreak, target: m.targetDays };
}

function eligible(m, slot, d, grid, state, options, maxWork, assignedToday) {
  if (assignedToday.has(m.id)) return false;
  const cur = grid[m.id][d.day];
  if (cur !== undefined && cur !== null) return false;   // 希望休・固定休などで確定済み
  if (!m.patterns || !m.patterns.includes(slot.pattern)) return false;
  if (!slot.roles.some((r) => (m.roles || []).includes(r) || (m.roles || []).includes('全般'))) return false;
  const st = state[m.id];
  if (st.streak >= (m.maxConsecutive || options.maxConsecutive)) return false;
  const cap = Math.min(maxWork, (m.targetDays === undefined ? 99 : m.targetDays) + 2);
  if (st.work >= cap) return false;
  return true;
}

function score(m, slot, st, options, rng) {
  let s = (st.work / Math.max(1, m.targetDays || 1)) * 100; // 出勤の少ない人を優先
  if (options.keepPattern && st.lastPattern === slot.pattern) s -= 15; // 前日と同じパターンなら安定
  s += st.streak * 6;   // 連勤が続いている人は後回し
  s += rng() * 10;      // 同点をばらす
  return s;
}

/** 手修正後も含めた検証。UI から呼んで常に最新の警告を出す。 */
export function validate(ctx, grid) {
  const { days, members, requests = {}, streaks = {}, rules, options } = ctx;
  const active = members.filter((m) => m.active !== false);
  const issues = [];
  const dayStats = [];

  for (const d of days) {
    const slots = d.closed ? [] : expandSlots(rules, d.rooms);
    const need = {};
    for (const s of slots) {
      if (!need[s.ruleId]) need[s.ruleId] = { label: s.label, pattern: s.pattern, roles: s.roles, optional: s.optional, count: 0, have: 0 };
      need[s.ruleId].count++;
    }
    for (const m of active) {
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      if (!isWorkSymbol(v)) continue;
      for (const k of Object.keys(need)) {
        const n = need[k];
        const roleOk = n.roles.some((r) => (m.roles || []).includes(r) || (m.roles || []).includes('全般'));
        if (n.pattern === v && n.have < n.count && roleOk) { n.have++; break; }
      }
    }
    let required = 0, filled = 0;
    for (const k of Object.keys(need)) {
      required += need[k].count;
      filled += need[k].have;
      if (need[k].have < need[k].count) {
        issues.push({
          type: 'shortage', day: d.day, label: need[k].label, pattern: need[k].pattern, roles: need[k].roles, optional: need[k].optional,
          message: d.label + ' ' + need[k].label + '（' + need[k].pattern + '）が ' + (need[k].count - need[k].have) + '名 不足',
        });
      }
    }
    const headcount = active.filter((m) => {
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      return isWorkSymbol(v) || (m.mode === 'always' && v === '');
    }).length;
    const hours = active.reduce((a, m) => {
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      return a + (PATTERNS[v] ? PATTERNS[v].hours : 0);
    }, 0);
    dayStats.push({ day: d.day, label: d.label, rooms: d.rooms, closed: d.closed, required, filled, headcount, hours });
  }

  const memberStats = active.map((m) => {
    const st = statsFor(m, days, grid);
    for (const d of days) {
      const req = requests[m.id] ? requests[m.id][d.day] : null;
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      if (req && v !== req && isWorkSymbol(v)) {
        issues.push({ type: 'request', memberId: m.id, day: d.day, message: m.name + '：' + d.label + ' は希望休（' + req + '）ですが「' + v + '」が入っています' });
      }
    }
    const limit = m.maxConsecutive || options.maxConsecutive;
    if (st.maxStreak > limit) issues.push({ type: 'streak', memberId: m.id, message: m.name + '：' + st.maxStreak + '連勤（上限' + limit + '）' });
    if (m.mode === 'auto' && Math.abs(st.work - st.target) > 3) {
      issues.push({ type: 'workload', memberId: m.id, message: m.name + '：出勤' + st.work + '日（目安' + st.target + '日）' });
    }
    if (m.mode !== 'manual' && st.off < (options.minOffDays || 0)) {
      issues.push({ type: 'off', memberId: m.id, message: m.name + '：休み' + st.off + '日（最低' + options.minOffDays + '日）' });
    }
    // 連休の希望（「3連休が取りたい」）が叶っているか
    const want = streaks[m.id];
    if (want >= 2 && m.mode !== 'manual' && longestOffRun(m, days, grid) < want) {
      issues.push({ type: 'streakWish', memberId: m.id, message: m.name + '：' + want + '連休の希望が入っていません（今は最長' + longestOffRun(m, days, grid) + '日）' });
    }
    return st;
  });

  return { issues, dayStats, memberStats };
}

/** 不足枠を埋められる候補者（ソフト制約は無視して、希望休だけは守る） */
export function candidatesFor(ctx, grid, day, pattern, roles) {
  const { members } = ctx;
  return members.filter((m) => {
    if (m.active === false || m.mode === 'manual') return false;
    const v = grid[m.id] ? grid[m.id][day] : undefined;
    if (isWorkSymbol(v)) return false;                       // その日すでに勤務
    if (v === '特' || v === '✖') return false;               // 希望休は動かさない
    if (ctx.requests && ctx.requests[m.id] && ctx.requests[m.id][day]) return false;
    if (!(m.patterns || []).includes(pattern)) return false;
    return roles.some((r) => (m.roles || []).includes(r) || (m.roles || []).includes('全般'));
  });
}
