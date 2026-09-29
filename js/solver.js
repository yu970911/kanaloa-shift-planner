// シフト自動生成エンジン
// 希望休と労働条件（労働時間の上限・法定休日・区分ごとの休日数）は絶対条件（ハード制約）。
// 必要人数・出勤日数の目安・連休の希望はソフト制約として最適化します。
import {
  expandSlots, PATTERNS, defaultLabor, kubunOf, monthlyHourCap, weekIndex, hoursOf, lunchDuty,
} from './model.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OFF_SET = ['休', '特', '✖'];
const normName = (n) => String(n || '').replace(/[\s　]/g, '');
export const isWorkSymbol = (s) => !!s && !OFF_SET.includes(s);

/** 保存データに古い設定が残っていても、足りない項目は既定値で補う */
export function laborOf(options) {
  const base = defaultLabor();
  const l = (options && options.labor) || {};
  return {
    ...base, ...l,
    offDaysByKubun: { ...base.offDaysByKubun, ...(l.offDaysByKubun || {}) },
    exemptKubun: l.exemptKubun || base.exemptKubun,
  };
}
const isExempt = (m, labor) => labor.exemptKubun.includes(kubunOf(m));

/** 暦週ごとの、月内の日数 */
function weekLengths(labor, days) {
  const len = {};
  for (const d of days) {
    const wk = weekIndex(labor, days, d.day);
    len[wk] = (len[wk] || 0) + 1;
  }
  return len;
}
/** その週の上限時間（月をまたぐ週は日数で按分） */
export const weekCap = (labor, lenInMonth) => (labor.weeklyLimit * lenInMonth) / 7;

/**
 * 会社として確保する月の休日数（区分の設定が無ければ全体の設定）。
 * 月の途中まで（前半だけ）組むときは、options.scopeRatio（月に対する割合）で日割りにする
 */
export function minOffFor(m, labor, options) {
  if (isExempt(m, labor)) return 0;
  const v = labor.offDaysByKubun[kubunOf(m)];
  const base = v === undefined || v === null || v === '' ? (options.minOffDays || 0) : Number(v);
  const r = options.scopeRatio;
  return r && r < 1 ? Math.round(base * r) : base;
}

/**
 * 期間ごとに組む（前半 1〜15日 ／ 後半 16日〜月末）ための下ごしらえ。
 * ctx.days は「月初（または前半の組んだ分）から、今回の期間の最終日まで」。
 * ctx.genFrom は今回組む最初の日。それより前の日は、すでに組んだ結果（ctx.prior）を確定として引き継ぐ。
 * ctx.monthDays を渡すと、月の目安出勤日数・最低休日数を、ここまでの日数で日割りにする。
 */
function scopeOf(ctx) {
  const { days, members, options } = ctx;
  const ratio = ctx.monthDays && days.length < ctx.monthDays ? days.length / ctx.monthDays : 1;
  const genFrom = ctx.genFrom || (days[0] && days[0].day) || 1;
  return {
    ratio, genFrom,
    members: ratio < 1
      ? members.map((m) => (m.targetDays === undefined ? m : { ...m, targetDays: Math.round(m.targetDays * ratio) }))
      : members,
    options: ratio < 1 ? { ...options, scopeRatio: ratio } : options,
  };
}

/**
 * 必要人員の枠を、日ごとに開く道具を作る。
 *  ・休業の曜日（closedDows）は枠を出さない
 *  ・leadName の人が、その枠のパターンで働く日だけ営業（その人が休みなら休業）
 *  ・poolNames の人だけが入れる（leadName の人を含む）。先頭が優先で、2人目以降は同じ順位の控え
 * grid を渡すと、実際にリードが働いている日だけ枠を出す（組んだあとの確認用）。渡さないと、休業曜日以外は全部出す。
 */
export function makeSlotter(rules, members) {
  const byName = new Map(members.filter((m) => m.active !== false).map((m) => [normName(m.name), m]));
  const info = {};
  for (const r of rules) {
    if (!r.leadName && !(r.poolNames || []).length) continue;
    const lead = r.leadName ? byName.get(normName(r.leadName)) : null;
    const pool = (r.poolNames || []).map((n) => byName.get(normName(n))).filter(Boolean);
    const only = new Set([lead, ...pool].filter(Boolean).map((m) => m.id));
    const rank = {};
    pool.forEach((m, i) => { rank[m.id] = i === 0 ? 0 : 1; });
    info[r.id] = { leadId: lead ? lead.id : null, leadMissing: !!r.leadName && !lead, only, rank };
  }
  const slotter = (d, grid) => {
    if (d.closed) return [];
    const out = [];
    for (const s of expandSlots(rules, d.rooms, d.dow, d.need, d.hol)) {
      const inf = info[s.ruleId];
      if (!inf) { out.push(s); continue; }
      if (inf.leadMissing) continue;   // リードが名簿にいない（長期休暇など）間は休業
      if (grid && inf.leadId && !(grid[inf.leadId] && grid[inf.leadId][d.day] === s.pattern)) continue;
      out.push({ ...s, leadId: inf.leadId, only: inf.only, rank: inf.rank });
    }
    return out;
  };
  /** リードが休みで休業になる日（休業の曜日は除く） */
  slotter.closures = (d, grid) => {
    if (d.closed) return [];
    const open = new Set(slotter(d, grid).map((s) => s.ruleId));
    const out = [];
    for (const r of rules) {
      const inf = info[r.id];
      if (!r.enabled || !inf || !inf.leadId) continue;
      if (Array.isArray(r.closedDows) && r.closedDows.includes(d.dow)) continue;
      if (expandSlots([r], d.rooms, d.dow, d.need, d.hol).length && !open.has(r.id)) out.push(r);
    }
    return out;
  };
  return slotter;
}

/**
 * 労働条件の違反を洗い出す。生成時の評価と、手直し後の検証の両方で使う。
 *  hours       … 月の労働時間が上限を超えている（1か月単位の変形労働時間制）
 *  weekHours   … 暦週の労働時間が上限を超えている（週ごとに判定する場合）
 *  legalHoliday… 7日そろった暦週に休みが1日もない（法定休日）
 *  off         … 区分ごとに決めた月の休日数に届いていない（会社のルール）
 */
export function laborIssues(members, days, grid, options) {
  const labor = laborOf(options);
  const cap = monthlyHourCap(labor, days.length);
  const labelOf = (day) => (days.find((x) => x.day === day) || { label: String(day) }).label.replace(/\(.\)$/, '');
  const out = [];
  for (const m of members) {
    if (m.active === false) continue;
    const kb = kubunOf(m);
    let hours = 0;
    let off = 0;
    const weeks = new Map();
    for (const d of days) {
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      const h = hoursOf(m, v);
      hours += h;
      if (h === 0) off++;
      const wk = weekIndex(labor, days, d.day);
      if (!weeks.has(wk)) weeks.set(wk, { hours: 0, work: 0, len: 0, from: d.day, to: d.day });
      const w = weeks.get(wk);
      w.len++; w.to = d.day; w.hours += h;
      if (h > 0) w.work++;
    }
    const need = minOffFor(m, labor, options);
    if (need > 0 && off < need) {
      out.push({ type: 'off', memberId: m.id, message: `${m.name}：休み${off}日（${kb}は${options.scopeRatio ? 'ここまでで' : '月'}${need}日以上）` });
    }
    if (isExempt(m, labor)) continue;
    if (labor.mode === 'monthly') {
      if (hours > cap + 1e-9) {
        out.push({ type: 'hours', memberId: m.id, message: `${m.name}：${options.scopeRatio ? '月の前半までの' : '月の'}労働時間 ${hours}時間（上限 ${cap.toFixed(1)}時間）` });
      }
    } else {
      for (const w of weeks.values()) {
        const wcap = weekCap(labor, w.len);
        if (w.hours > wcap + 1e-9) {
          const note = w.len < 7 ? `：月をまたぐ週なので${w.len}日分で按分` : '';
          out.push({ type: 'weekHours', memberId: m.id, message: `${m.name}：${labelOf(w.from)}〜${labelOf(w.to)}の週 ${w.hours}時間（上限 ${Math.round(wcap * 10) / 10}時間${note}）` });
        }
      }
    }
    for (const w of weeks.values()) {
      if (w.len === 7 && w.work === 7) {
        out.push({ type: 'legalHoliday', memberId: m.id, message: `${m.name}：${labelOf(w.from)}〜${labelOf(w.to)}の週に休みがありません（法定休日は毎週1日以上）` });
      }
    }
  }
  return out;
}

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
  const { days, requests = {}, streaks = {}, rules } = ctx;
  const sc = scopeOf(ctx);
  const options = sc.options;
  const prior = ctx.prior || {};
  const active = sc.members.filter((m) => m.active !== false);
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
        const cand = buildOne(days, active, requests, streaks, rules, options, rng, sc.genFrom, prior);
        done++;
        if (!best || cand.cost < best.cost) { best = cand; improvedAt = done; }
        if (best.cost === 0) { done = total; break; }
      }
      return done < total;
    },
  };
}

function buildOne(days, members, requests, streaks, rules, options, rng, genFrom, prior) {
  const isGen = (day) => day >= genFrom;
  const genDays = days.filter((d) => isGen(d.day));
  const slotter = makeSlotter(rules, members);
  const grid = {};
  const state = {};
  for (const m of members) {
    grid[m.id] = {};
    state[m.id] = { work: 0, streak: 0, lastPattern: null, switches: 0, hours: 0, weekHours: {} };
  }

  const labor = laborOf(options);
  const hourCap = monthlyHourCap(labor, days.length);
  // 出勤できる日数の使い方を、人ごとに少しずつずらす（試行ごとに変える）。
  // ずらさないと、人が足りないとき全員が同じ日に出勤日数を使い切って、期間の最後に全員休みになってしまう
  const delta = {};
  for (const m of members) delta[m.id] = rng() * 0.5;
  const env = { labor, hourCap, days, options, weekLen: weekLengths(labor, days), delta };

  // 1) 確定分を先に置く（希望休・固定休・休館日・常勤・手入力）
  for (const m of members) {
    for (const d of days) {
      // 前半など、すでに組んだ日はそのまま引き継ぐ
      if (!isGen(d.day)) {
        const pv = prior[m.id] ? prior[m.id][d.day] : undefined;
        if (pv !== undefined) { grid[m.id][d.day] = pv; continue; }
      }
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
    // 1割ほどの試行では入れずに組み、人員不足と比べて良い方を採る（不足1枠 ＞ 連休1件 の重み）
    if (rng() < 0.12 || !placeStreak(m, n, days, grid, rng, genFrom)) streakMisses.push({ member: m, want: n });
  }

  // 1.5) 常勤（記号なし）の人にも休みを入れる：連勤上限と最低休日数を満たすよう、
  //      なるべく客室数の少ない日を休みに充てる
  for (const m of members) {
    if (m.mode !== 'always') continue;
    placeAlwaysOffs(m, days, grid, options, rng, labor, genFrom);
    for (const d of days) if (grid[m.id][d.day] === '') state[m.id].work++;
  }

  // 1.7) 全員出勤の日が続くときは、その手前で休みを取っておく（連勤が上限を超えないように）。
  //      1日に休みが重ならないよう、人ごとにずらして置く
  planOffsBeforeFull(members, days, grid, options, rng, genFrom);

  // ここまでで決まった日（希望休・固定休・連休の希望など）は、あとの手直しでも動かさない
  const locked = {};
  for (const m of members) locked[m.id] = new Set(days.filter((d) => !isGen(d.day) || grid[m.id][d.day] !== undefined).map((d) => d.day));

  // 2) 自動割当
  const autoMembers = members.filter((m) => m.mode === 'auto');
  const autoById = new Map(autoMembers.map((m) => [m.id, m]));
  const issues = [];
  const dayStats = [];

  // 連勤・出勤日数の更新（すでに組んだ日は、ここで状態に反映するだけ）
  const advance = (d) => {
    for (const m of members) {
      const v = grid[m.id][d.day];
      const worked = isWorkSymbol(v) || (m.mode === 'always' && v === '');
      const st = state[m.id];
      if (worked) {
        if (m.mode === 'auto') {
          const h = hoursOf(m, v);
          const wk = weekIndex(labor, days, d.day);
          st.hours += h;
          st.weekHours[wk] = (st.weekHours[wk] || 0) + h;
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
  };
  for (const d of days) if (!isGen(d.day)) advance(d);

  for (const d of genDays) {
    const all = slotter(d);
    const slots = [];
    const assignedToday = new Set();
    const filled = [];
    let required = 0;

    // リードのいる枠（焼き鳥屋など）：リードが入れる日だけ営業。入れない日は、その枠ぜんぶ休業
    const leadOpen = new Map();
    for (const s of all) {
      if (!s.leadId) { slots.push(s); required++; continue; }
      if (!leadOpen.has(s.ruleId)) {
        const lead = autoById.get(s.leadId);
        const ok = !!lead && eligible(lead, s, d, grid, state, env, assignedToday);
        leadOpen.set(s.ruleId, ok);
        if (ok) {
          grid[lead.id][d.day] = s.pattern;
          assignedToday.add(lead.id);
          locked[lead.id].add(d.day);   // 手直しでも動かさない（動かすと休業になってしまう）
          filled.push({ memberId: lead.id, pattern: s.pattern, label: s.label });
          required++;
        }
        continue;
      }
      if (leadOpen.get(s.ruleId)) { slots.push(s); required++; }
    }

    // 必須の枠を先に、その中でも候補が少ない枠から埋める（後半で詰むのを防ぐ）。
    // 「空きでOK」の枠を先に埋めると、必須の枠に入れる人をそこで使ってしまう
    const order = slots
      .map((s) => ({ slot: s, n: autoMembers.filter((m) => eligible(m, s, d, grid, state, env, assignedToday)).length }))
      .sort((a, b) => (!!a.slot.optional - !!b.slot.optional) || (a.n - b.n))
      .map((x) => x.slot);

    for (const slot of order) {
      const pool = autoMembers.filter((m) => eligible(m, slot, d, grid, state, env, assignedToday));
      if (pool.length === 0) {
        issues.push(shortageIssue(d, slot));
        continue;
      }
      const scored = pool.map((m) => ({ m, sc: score(m, slot, state[m.id], options, rng) }));
      scored.sort((a, b) => a.sc - b.sc);
      const pick = scored[0].m;
      grid[pick.id][d.day] = slot.pattern;
      assignedToday.add(pick.id);
      filled.push({ memberId: pick.id, pattern: slot.pattern, label: slot.label });
    }

    // 全員出勤の日：枠が埋まったあとも、入れる人はみんな入れる（希望休・連勤・労働時間の条件は守る）
    let extraHours = 0;
    if (d.full) {
      for (const m of autoMembers) {
        if (grid[m.id][d.day] !== undefined) continue;
        const pat = pickExtraPattern(m, slots, filled, d);
        if (!pat || !eligible(m, { pattern: pat }, d, grid, state, env, assignedToday, true)) continue;
        grid[m.id][d.day] = pat;
        assignedToday.add(m.id);
        extraHours += PATTERNS[pat] ? PATTERNS[pat].hours : 0;
      }
    }

    // 割り当てのつかなかった自動メンバーは休み
    for (const m of autoMembers) if (grid[m.id][d.day] === undefined) grid[m.id][d.day] = '休';

    advance(d);

    dayStats.push({
      day: d.day, label: d.label, rooms: d.rooms, closed: d.closed,
      required, filled: filled.length,
      headcount: members.filter((m) => {
        const v = grid[m.id][d.day];
        return isWorkSymbol(v) || (m.mode === 'always' && v === '');
      }).length,
      hours: filled.reduce((a, f) => a + (PATTERNS[f.pattern] ? PATTERNS[f.pattern].hours : 0), 0) + extraHours,
    });
  }

  // 2.5) 手直し：1日ずつ順に埋めるだけだと、同じ枠に入れる人たちの休みが同じ日に重なって
  //      その日だけ空くことがある。入れ替えで埋め直し、不足と日ごとの集計を数え直す
  if (repairShortages(days, genDays, members, autoMembers, grid, locked, slotter, options)) {
    issues.length = 0;   // ここまでの issues は不足だけ
    dayStats.length = 0;
    for (const d of genDays) {
      const c = coverDay(d, slotter, members, grid);
      for (const slot of c.missing) issues.push(shortageIssue(d, slot));
      dayStats.push(c.stats);
    }
  }

  // 3) 評価
  const memberStats = members.map((m) => statsFor(m, days, grid, genFrom));
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

  const labor2 = laborIssues(members, days, grid, options);
  issues.push(...labor2);

  const closures = closureIssues(genDays, slotter, grid);
  issues.push(...closures);
  const fullMiss = fullDayIssues(genDays, members, grid);
  issues.push(...fullMiss);

  for (const miss of streakMisses) {
    issues.push({ type: 'streakWish', memberId: miss.member.id, message: miss.member.name + '：' + miss.want + '連休の希望を入れられませんでした' });
  }

  const shortage = issues.filter((i) => i.type === 'shortage' && !i.optional).length;
  // 不足が同じ日に固まるほど悪い（1日に4名足りないより、4日に1名ずつのほうがまし）
  const shortByDay = {};
  for (const i of issues) if (i.type === 'shortage' && !i.optional) shortByDay[i.day] = (shortByDay[i.day] || 0) + 1;
  const shortSq = Object.values(shortByDay).reduce((a, n) => a + n * n, 0);
  const softShortage = issues.filter((i) => i.type === 'shortage' && i.optional).length;
  const imbalance = memberStats.reduce((a, s) => {
    const m = members.find((x) => x.id === s.id);
    return m.mode === 'auto' ? a + Math.abs(s.work - s.target) : a;
  }, 0);
  const switches = Object.values(state).reduce((a, s) => a + s.switches, 0);
  const cost = shortage * 1000 + shortSq * 100 + labor2.length * 1000 + softShortage * 20 + imbalance * 10 + streakMisses.length * 50 + closures.length * 30 + fullMiss.length * 200
    + (options.keepPattern ? switches : 0);

  return { grid, issues, dayStats, memberStats, cost, shortage };
}

/** 担当の仕事が合っていて、その枠に入れる人か（枠が人を限っている場合は、その中の人だけ） */
const roleOk = (m, slot) => (!slot.only || slot.only.has(m.id))
  && slot.roles.some((r) => (m.roles || []).includes(r) || (m.roles || []).includes('全般'));

/**
 * 清掃の人数を指定した日（need.clean）に、実際に昼に清掃をしている人が足りているか。
 * 清掃をするのは、B の人、H・D で「ランチの時間は清掃」の人（宮平さん・日下さんは厨房なので数えない）。
 * 焼き鳥屋が休業の日は、D の人がいないので、指定の人数に届かないことがある。
 */
function cleanLackIssues(days, members, grid) {
  const out = [];
  for (const d of days) {
    const want = d.need && d.need.clean !== undefined && d.need.clean !== '' && d.need.clean !== null ? Number(d.need.clean) : null;
    if (want === null || !Number.isFinite(want) || d.closed) continue;
    const actual = members.filter((m) => {
      if (m.active === false) return false;
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      if (v === 'B') return true;
      if (v === 'H' || v === 'D') { const ld = lunchDuty(m, v); return !!ld && ld.duty === '清掃'; }
      return false;
    }).length;
    if (actual < want) out.push({ type: 'cleanLack', day: d.day, message: `${d.label} は清掃${want}名の指定ですが、今は${actual}名です` });
  }
  return out;
}

/** 全員出勤の日に、休みになっている人（役員・手入力のみの人は除く） */
function fullDayIssues(days, members, grid) {
  const out = [];
  for (const d of days) {
    if (!d.full || d.closed) continue;
    const off = members.filter((m) => {
      if (m.active === false || m.mode === 'manual' || isExempt(m, laborOf({}))) return false;
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      const worked = isWorkSymbol(v) || (m.mode === 'always' && v === '');
      return !worked;
    });
    if (off.length) out.push({ type: 'fullDay', day: d.day, message: `${d.label} は全員出勤の日ですが、${off.map((m) => m.name).join('・')}が休みです` });
  }
  return out;
}

/** 全員出勤の日に、枠の外で入れるときのパターン：まだ足りない枠があればそれ、なければその日の枠に合うもの、なければ基本の勤務 */
function pickExtraPattern(m, slots, filled, d) {
  const list = (m.patterns || []).filter((p) => PATTERNS[p]);
  if (!list.length) return null;
  const want = (p) => Math.max(0, slots.filter((s) => s.pattern === p && roleOk(m, s)).length - filled.filter((f) => f.pattern === p).length);
  const inDay = (p) => slots.some((s) => s.pattern === p);
  const ranked = list.map((p, i) => ({ p, i, w: want(p), day: inDay(p) })).sort((a, b) => (b.w - a.w) || (b.day - a.day) || (a.i - b.i));
  return ranked[0].p;
}

/**
 * 全員出勤の日が続く前に、休みを取っておく。
 * 全員出勤の日が L 日続くなら、その手前の（連勤の上限 − L + 1）日のうちに1日は休みが要る。
 * すでに休みの日があれば何もしない。無ければ、その窓のなかで休みが重なっていない日を選んで休みにする。
 */
function planOffsBeforeFull(members, days, grid, options, rng, genFrom) {
  const blocks = [];
  for (const d of days) {
    if (!d.full) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.to === d.day - 1) last.to = d.day; else blocks.push({ from: d.day, to: d.day });
  }
  if (!blocks.length) return;
  const isOff = (v) => v === '休' || v === '特' || v === '✖';
  for (const b of blocks) {
    const L = b.to - b.from + 1;
    for (const m of members) {
      if (m.mode !== 'auto') continue;
      const limit = Math.min(m.maxConsecutive || options.maxConsecutive || 6, 6);
      const span = limit - L + 1;
      if (span <= 0) continue;
      const win = days.filter((d) => d.day >= b.from - span && d.day < b.from && !d.full);
      if (!win.length || win.some((d) => isOff(grid[m.id][d.day]) || d.closed)) continue;
      const free = win.filter((d) => grid[m.id][d.day] === undefined && d.day >= genFrom);
      if (!free.length) continue;
      const load = (d) => members.filter((x) => x.mode === 'auto' && isOff(grid[x.id][d.day])).length;
      free.sort((a, c) => (load(a) - load(c)) || ((a.rooms || 0) - (c.rooms || 0)) || (rng() - 0.5));
      grid[m.id][free[0].day] = '休';
    }
  }
}

/** リードが休みで休業になる日（休業の曜日は除く）を、お知らせとして並べる */
function closureIssues(days, slotter, grid) {
  const out = [];
  for (const d of days) {
    for (const r of slotter.closures(d, grid)) {
      out.push({ type: 'closure', day: d.day, ruleId: r.id, message: `${d.label} ${r.label}は休業（${r.leadName}が休みのため）` });
    }
  }
  return out;
}

function shortageIssue(d, slot) {
  return {
    type: 'shortage', day: d.day, label: slot.label, pattern: slot.pattern, roles: slot.roles, only: slot.only, optional: slot.optional,
    message: d.label + ' ' + slot.label + '（' + slot.pattern + '）を埋められる人がいません',
  };
}

/**
 * その日の枠が、今の割り当てでどこまで埋まっているか。
 * 同じパターンで担当違いの枠（例：夕方Dの厨房とホール）があるので、人と枠の組み合わせを最大にして数える。
 * 必須の枠を先に組むので、「空きでOK」の枠のために必須の枠が空くことはない。
 */
function coverDay(d, slotter, members, grid) {
  const slots = slotter(d, grid);
  const order = slots.map((_, i) => i).sort((a, b) => !!slots[a].optional - !!slots[b].optional);
  const valOf = (m) => (grid[m.id] ? grid[m.id][d.day] : undefined);
  const workers = members.filter((m) => isWorkSymbol(valOf(m)));
  const owner = new Map();   // 人 → 入っている枠
  const take = (si, seen) => {
    for (const m of workers) {
      if (seen.has(m.id) || valOf(m) !== slots[si].pattern || !roleOk(m, slots[si])) continue;
      seen.add(m.id);
      if (!owner.has(m.id) || take(owner.get(m.id), seen)) { owner.set(m.id, si); return true; }
    }
    return false;
  };
  const missing = [];
  for (const si of order) if (!take(si, new Set())) missing.push(slots[si]);
  const hours = [...owner.values()].reduce((a, si) => a + (PATTERNS[slots[si].pattern] ? PATTERNS[slots[si].pattern].hours : 0), 0);
  const headcount = members.filter((m) => isWorkSymbol(valOf(m)) || (m.mode === 'always' && valOf(m) === '')).length;
  return {
    missing,
    stats: { day: d.day, label: d.label, rooms: d.rooms, closed: d.closed, required: slots.length, filled: owner.size, headcount, hours },
  };
}

/**
 * 埋まらなかった必須の枠を、入れ替えで埋める。
 * その日「休み」になっている人を入れて、代わりにその人の別の日の出勤を休みにする（出勤日数は変わらない）。
 * 休みに回す日は、抜けても必須の枠が欠けない日だけ（「空きでOK」の枠が空くのは可）。
 * 希望休・固定休・連休の希望など先に決めた日は動かさず、連勤・法定休日・労働時間・休日数の条件も崩さない。
 * @returns {boolean} 1か所でも直したら true
 */
function repairShortages(days, genDays, members, autoMembers, grid, locked, slotter, options) {
  const cover = new Map(genDays.map((d) => [d.day, coverDay(d, slotter, members, grid)]));
  const lack = (c) => c.missing.filter((x) => !x.optional).length;
  if (![...cover.values()].some((c) => lack(c) > 0)) return false;

  // 「この人がこの日に抜けたら、その日はどうなるか」は何度も使うので覚えておく（日の中身が変わったら捨てる）
  const without = new Map();
  const coverWithout = (m, e) => {
    const key = m.id + ':' + e.day;
    if (!without.has(key)) {
      const prev = grid[m.id][e.day];
      grid[m.id][e.day] = '休';
      without.set(key, coverDay(e, slotter, members, grid));
      grid[m.id][e.day] = prev;
    }
    return without.get(key);
  };
  const forget = (day) => { for (const k of [...without.keys()]) if (k.endsWith(':' + day)) without.delete(k); };
  const memberOk = (m) => {
    const limit = Math.min(m.maxConsecutive || options.maxConsecutive || 6, 6);   // 7連勤は法定休日に反する
    return statsFor(m, days, grid).maxStreak <= limit && laborIssues([m], days, grid, options).length === 0;
  };

  const fill = (d, slot) => {
    const before = lack(cover.get(d.day));
    const cands = autoMembers.filter((m) => grid[m.id][d.day] === '休' && !locked[m.id].has(d.day)
      && (m.patterns || []).includes(slot.pattern) && roleOk(m, slot));
    for (const m of cands) {
      // 近い日から試す（同じ週の中で入れ替えると、週の労働時間や休みの形が崩れにくい）
      const others = genDays
        .filter((e) => e.day !== d.day && !e.full && isWorkSymbol(grid[m.id][e.day]) && !locked[m.id].has(e.day))
        .sort((a, b) => Math.abs(a.day - d.day) - Math.abs(b.day - d.day));
      for (const e of others) {
        const ce = coverWithout(m, e);
        if (lack(ce) > lack(cover.get(e.day))) continue;          // 抜けると必須の枠が欠ける日は使わない
        const prevE = grid[m.id][e.day];
        grid[m.id][e.day] = '休';
        grid[m.id][d.day] = slot.pattern;
        const cd = coverDay(d, slotter, members, grid);
        if (lack(cd) < before && memberOk(m)) {
          cover.set(d.day, cd);
          cover.set(e.day, ce);
          forget(d.day); forget(e.day);
          return true;
        }
        grid[m.id][d.day] = '休';
        grid[m.id][e.day] = prevE;
      }
    }
    return false;
  };

  let changed = false;
  for (let pass = 0; pass < 3; pass++) {
    let progress = false;
    for (const d of genDays) {
      for (const slot of cover.get(d.day).missing.filter((x) => !x.optional)) {
        if (fill(d, slot)) progress = changed = true;
      }
    }
    if (!progress) break;
  }
  return changed;
}

/**
 * 「N連休が取りたい」を叶える。日にちの指定が無い希望なので、
 * 予約の少ない並びを選んで N 日続けて休みにする。
 * すでに N 日連続の休みがあれば何もしない。
 * @returns {boolean} 置けたら true
 */
function placeStreak(m, n, days, grid, rng, genFrom = -Infinity) {
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
    if (win.some((d) => d.day < genFrom)) continue;   // すでに組んだ日は動かさない
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
function placeAlwaysOffs(m, days, grid, options, rng, labor, genFrom = -Infinity) {
  const limit = m.maxConsecutive || options.maxConsecutive || 6;
  const isOff = (day) => grid[m.id][day] !== '';
  const busyness = (d) => (d.rooms || 0) + (d.full ? 1000 : 0) + rng() * 0.5; // 同じ客室数なら散らす（全員出勤の日は最後）
  const exempt = isExempt(m, labor);
  const perDay = m.dailyHours || 8;

  // ⓪ 週ごとに判定する場合：1週間に働ける日数を超えないよう、ヒマな日を休みにする
  if (!exempt && labor.mode !== 'monthly') {
    const byWeek = new Map();
    for (const d of days) {
      const wk = weekIndex(labor, days, d.day);
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk).push(d);
    }
    for (const list of byWeek.values()) {
      const perWeek = Math.floor((weekCap(labor, list.length) + 1e-9) / perDay);
      const working = list.filter((d) => !isOff(d.day));
      const movable = working.filter((d) => d.day >= genFrom).sort((a, b) => busyness(a) - busyness(b));
      for (let excess = working.length - perWeek; excess > 0 && movable.length; excess--) grid[m.id][movable.shift().day] = '休';
    }
  }

  // ① 連勤上限を超える区間に休みを差し込む
  let streak = [];
  for (const d of days) {
    if (isOff(d.day)) { streak = []; continue; }
    streak.push(d);
    if (streak.length > limit) {
      const target = streak.slice(1).filter((x) => x.day >= genFrom).sort((a, b) => busyness(a) - busyness(b))[0];
      if (!target) { streak = []; continue; }   // すでに組んだ日だけの連勤は直せない
      grid[m.id][target.day] = '休';
      streak = streak.slice(streak.indexOf(target) + 1);
    }
  }

  // ② 休日数が足りなければ、ヒマな日から追加（休みが連続しないよう配慮）
  // 月の上限時間から見て、働ける日数（変形労働時間制で判定する場合）
  const hourDays = !exempt && labor.mode === 'monthly'
    ? Math.floor(monthlyHourCap(labor, days.length) / perDay)
    : days.length;
  const offNeeded = Math.max(
    minOffFor(m, labor, options),
    days.length - (m.targetDays || days.length),
    days.length - hourDays,
  );
  const countOff = () => days.filter((d) => isOff(d.day)).length;
  const pool = days.filter((d) => !isOff(d.day) && d.day >= genFrom).sort((a, b) => busyness(a) - busyness(b));
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

/** genFrom 以降は「今回の期間ぶん」（pWork・pOff・pHours）。ほかは、ここまで通しての数字 */
function statsFor(m, days, grid, genFrom = days[0] ? days[0].day : 1) {
  let work = 0, maxStreak = 0, cur = 0, hours = 0, pWork = 0, pOff = 0, pHours = 0;
  for (const d of days) {
    const v = grid[m.id] ? grid[m.id][d.day] : undefined;
    const worked = isWorkSymbol(v) || (m.mode === 'always' && v === '');
    const h = hoursOf(m, v);
    hours += h;
    if (d.day >= genFrom) { pHours += h; if (worked) pWork++; else pOff++; }
    if (worked) { work++; cur++; if (cur > maxStreak) maxStreak = cur; }
    else cur = 0;
  }
  return { id: m.id, name: m.name, work, off: days.length - work, maxStreak, target: m.targetDays, hours, pWork, pOff, pHours };
}

// extra … 全員出勤の日に、枠の外で追加で入れるとき（対応パターン・担当・出勤日数の目安は問わない）
function eligible(m, slot, d, grid, state, env, assignedToday, extra = false) {
  const { labor, hourCap, days, options, weekLen } = env;
  if (assignedToday.has(m.id)) return false;
  const cur = grid[m.id][d.day];
  if (cur !== undefined && cur !== null) return false;   // 希望休・固定休などで確定済み
  if (!extra) {
    if (!m.patterns || !m.patterns.includes(slot.pattern)) return false;
    if (!roleOk(m, slot)) return false;
  }
  const st = state[m.id];
  if (st.streak >= Math.min(m.maxConsecutive || options.maxConsecutive, 6)) return false;  // 7連勤は法定休日に反する
  const maxWork = days.length - minOffFor(m, labor, options);
  const cap = extra ? maxWork : Math.min(maxWork, (m.targetDays === undefined ? 99 : m.targetDays) + 2);
  if (st.work >= cap) return false;
  if (!extra) {
    // 入れる回数の上限：日数の上限と、労働時間の上限（8時間勤務で何回入れるか）の小さいほう
    let budget = maxWork;
    if (!isExempt(m, labor) && labor.mode === 'monthly') budget = Math.min(budget, Math.floor((hourCap + 1e-9) / 8));
    const pos = d.day - days[0].day + 1;
    if (st.work >= Math.ceil((budget * pos) / days.length + (env.delta[m.id] || 0))) return false;
  }

  if (!isExempt(m, labor)) {
    const h = PATTERNS[slot.pattern] ? PATTERNS[slot.pattern].hours : 0;
    if (labor.mode === 'monthly') {
      if (st.hours + h > hourCap + 1e-9) return false;
    } else {
      const wk = weekIndex(labor, days, d.day);
      if ((st.weekHours[wk] || 0) + h > weekCap(labor, weekLen[wk]) + 1e-9) return false;
    }
  }
  return true;
}

function score(m, slot, st, options, rng) {
  let s = (st.work / Math.max(1, m.targetDays || 1)) * 100; // 出勤の少ない人を優先
  if (options.keepPattern && st.lastPattern === slot.pattern) s -= 15; // 前日と同じパターンなら安定
  s += st.streak * 6;   // 連勤が続いている人は後回し
  if (slot.rank) s += (slot.rank[m.id] || 0) * 60;   // 優先の人を先に（アスナ → KYI SU・EI KAY ZIN HAN）
  s += rng() * 10;      // 同点をばらす
  return s;
}

/** 手修正後も含めた検証。UI から呼んで常に最新の警告を出す。 */
export function validate(ctx, grid) {
  const { days, requests = {}, streaks = {}, rules } = ctx;
  const sc = scopeOf(ctx);
  const { options, genFrom } = sc;
  const active = sc.members.filter((m) => m.active !== false);
  const slotter = makeSlotter(rules, active);
  const genDays = days.filter((d) => d.day >= genFrom);
  const issues = [];
  const dayStats = [];

  for (const d of genDays) {
    const slots = slotter(d, grid);
    const need = {};
    for (const s of slots) {
      if (!need[s.ruleId]) need[s.ruleId] = { label: s.label, pattern: s.pattern, roles: s.roles, only: s.only, optional: s.optional, count: 0, have: 0 };
      need[s.ruleId].count++;
    }
    for (const m of active) {
      const v = grid[m.id] ? grid[m.id][d.day] : undefined;
      if (!isWorkSymbol(v)) continue;
      for (const k of Object.keys(need)) {
        const n = need[k];
        if (n.pattern === v && n.have < n.count && roleOk(m, n)) { n.have++; break; }
      }
    }
    let required = 0, filled = 0;
    for (const k of Object.keys(need)) {
      required += need[k].count;
      filled += need[k].have;
      if (need[k].have < need[k].count) {
        issues.push({
          type: 'shortage', day: d.day, label: need[k].label, pattern: need[k].pattern, roles: need[k].roles, only: need[k].only, optional: need[k].optional,
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
  issues.push(...closureIssues(genDays, slotter, grid));
  issues.push(...fullDayIssues(genDays, active, grid));
  issues.push(...cleanLackIssues(genDays, active, grid));

  const memberStats = active.map((m) => {
    const st = statsFor(m, days, grid, genFrom);
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

    // 連休の希望（「3連休が取りたい」）が叶っているか
    const want = streaks[m.id];
    if (want >= 2 && m.mode !== 'manual' && longestOffRun(m, days, grid) < want) {
      issues.push({ type: 'streakWish', memberId: m.id, message: m.name + '：' + want + '連休の希望が入っていません（今は最長' + longestOffRun(m, days, grid) + '日）' });
    }
    return st;
  });

  issues.push(...laborIssues(active, days, grid, options));
  return { issues, dayStats, memberStats };
}

/** 不足枠を埋められる候補者（ソフト制約は無視して、希望休だけは守る） */
export function candidatesFor(ctx, grid, day, pattern, roles, only) {
  const { members } = ctx;
  return members.filter((m) => {
    if (m.active === false || m.mode === 'manual') return false;
    const v = grid[m.id] ? grid[m.id][day] : undefined;
    if (isWorkSymbol(v)) return false;                       // その日すでに勤務
    if (v === '特' || v === '✖') return false;               // 希望休は動かさない
    if (ctx.requests && ctx.requests[m.id] && ctx.requests[m.id][day]) return false;
    if (!(m.patterns || []).includes(pattern)) return false;
    return roleOk(m, { roles, only });
  });
}
