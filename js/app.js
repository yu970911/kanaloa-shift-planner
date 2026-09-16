// 画面まわり。手順1「希望を集める」→ 手順2「組む」→ 手順3「確認して仕上げる」の3段構成。
import {
  PATTERNS, PATTERN_CODES, OFF_SYMBOLS, ROLES, ASSIGN_MODES,
  defaultMembers, defaultSlotRules, defaultOptions, expandSlots, buildDays, DOW_LABELS,
  patternSegments, DAY_START, DAY_END,
} from './model.js';
import { createRun, validate, candidatesFor, isWorkSymbol } from './solver.js';
import { importFormCsv, importMessages, guessColumns, parseCSV, parseRoomsInput, toTSV } from './importers.js';

const STORE_KEY = 'kanaloa-shift-planner-v1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/* ---------------- 状態 ---------------- */
let state = load();
let step = 1;
let view = 'sheet';
let tlDay = null;

function freshState() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2, // 翌月を既定に
    members: defaultMembers(),
    rules: defaultSlotRules(),
    options: defaultOptions(),
    months: {},
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshState();
    const s = JSON.parse(raw);
    return { ...freshState(), ...s, options: { ...defaultOptions(), ...(s.options || {}) } };
  } catch (e) {
    console.warn('保存データを読めませんでした', e);
    return freshState();
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = $('#saveState');
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      s.textContent = '保存 ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      s.textContent = 'この画面では保存できません';
    }
  }, 200);
}

const monthKey = () => `${state.year}-${String(state.month).padStart(2, '0')}`;
function mdata() {
  const k = monthKey();
  if (!state.months[k]) state.months[k] = { rooms: {}, closed: [], requests: {}, streaks: {}, noRequest: {}, grid: null };
  const m = state.months[k];
  m.rooms = m.rooms || {}; m.closed = m.closed || []; m.requests = m.requests || {};
  m.streaks = m.streaks || {}; m.noRequest = m.noRequest || {};
  return m;
}
const days = () => buildDays(state.year, state.month, mdata().rooms, mdata().closed, state.options.defaultRooms);
const activeMembers = () => state.members.filter((m) => m.active !== false);
const ctx = () => ({
  days: days(), members: activeMembers(), requests: mdata().requests, streaks: mdata().streaks,
  rules: state.rules, options: state.options,
});
const initials = (n) => String(n).replace(/[\s　]/g, '').slice(0, 2);
const isToday = (day) => {
  const t = new Date();
  return t.getFullYear() === state.year && t.getMonth() + 1 === state.month && t.getDate() === day.day;
};
const reqCount = (id) => Object.keys(mdata().requests[id] || {}).length;
const hasSubmitted = (id) => reqCount(id) > 0 || mdata().streaks[id] > 0 || !!mdata().noRequest[id];

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------------- 手順の切り替え ---------------- */
function goStep(n) {
  if (n === 3 && !mdata().grid) { toast('先にシフトを組んでください'); return; }
  step = n;
  $('#scCollect').hidden = n !== 1;
  $('#scRun').hidden = n !== 2;
  $('#scRes').hidden = n !== 3;
  $$('#stepper .step').forEach((b) => {
    const s = Number(b.dataset.s);
    b.classList.toggle('on', s === n);
    b.classList.toggle('done', s < n || (s === 1 && n === 3) || (s < 3 && !!mdata().grid && s !== n));
  });
  if (n === 1) renderCollect();
  if (n === 3) renderResult();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ================= 手順1：希望を集める ================= */
function renderCollect() {
  renderRoster();
  renderStreakWishes();
  renderSummary();
  renderRules();
  renderRoomsGrid();
  renderLaunch();
  if (!$('#advBody').hidden) { renderStaff(); renderRuleTable(); }
}

function renderRoster() {
  const host = $('#rosterBody');
  host.innerHTML = '';
  const d = days();
  const members = activeMembers();
  for (const m of members) {
    const tr = el('tr');

    const tdP = el('td');
    const p = el('div', 'person');
    p.appendChild(el('span', 'av', initials(m.name)));
    const box = el('div');
    box.appendChild(el('div', 'n', m.name));
    box.appendChild(el('div', 'm', [m.kubun, ASSIGN_MODES[m.mode]].filter(Boolean).join(' / ')));
    p.appendChild(box);
    tdP.appendChild(p);
    tr.appendChild(tdP);

    const tdR = el('td');
    for (const r of (m.roles || [])) tdR.appendChild(el('span', 'tag ' + r, r));
    tr.appendChild(tdR);

    const tdS = el('td');
    const done = hasSubmitted(m.id);
    const st = el('span', 'status ' + (done ? 'done' : 'wait'));
    st.appendChild(el('span', 'pip'));
    st.appendChild(el('span', '', done ? '提出済み' : '未提出'));
    tdS.appendChild(st);
    if (!done) {
      const b = el('button', 'btn sm', '希望なし');
      b.style.marginTop = '4px';
      b.title = 'この人は今月の希望休なし、として記録します';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); mdata().noRequest[m.id] = true; save(); renderCollect(); });
      tdS.appendChild(b);
    }
    tr.appendChild(tdS);

    const tdW = el('td');
    const strip = el('div', 'strip');
    strip.title = m.name + 'の希望休を開く';
    const reqs = mdata().requests[m.id] || {};
    for (const day of d) {
      const c = el('div', 'dc' + (day.dow === 0 ? ' sun' : day.dow === 6 ? ' sat' : ''));
      const sym = reqs[day.day];
      if (sym === '休') c.classList.add('off');
      else if (sym === '特') c.classList.add('special');
      else if (sym === '✖') c.classList.add('ng');
      c.appendChild(el('div', 'dt', String(day.day)));
      if (sym) c.appendChild(el('div', '', sym));
      strip.appendChild(c);
    }
    strip.addEventListener('click', () => openCalendar(m));
    tdW.appendChild(strip);
    const n = reqCount(m.id);
    const wish = mdata().streaks[m.id];
    tdW.appendChild(el('div', 'stripnote', [n ? `${n}日` : '希望なし', wish ? `${wish}連休の希望` : ''].filter(Boolean).join(' ／ ')));
    tr.appendChild(tdW);

    tr.addEventListener('click', () => openCalendar(m));
    host.appendChild(tr);
  }
  const submitted = members.filter((m) => hasSubmitted(m.id)).length;
  $('#collectSub').textContent = `${state.month}月 ／ ${submitted}/${members.length}名が提出`;
}

/** 希望休カレンダー */
function openCalendar(m) {
  const d = days();
  const modal = $('#modal');
  modal.innerHTML = '';
  const mh = el('div', 'mh');
  const t = el('div');
  t.appendChild(el('h2', '', m.name));
  t.appendChild(el('div', 'sub', `${state.year}年${state.month}月　クリックで 休 → 特 → ✖ → なし`));
  mh.appendChild(t);
  const x = el('button', 'btn sm x', '閉じる');
  x.addEventListener('click', closeModal);
  mh.appendChild(x);
  modal.appendChild(mh);

  const body = el('div', 'pad');
  const cal = el('div', 'cal');
  ['日', '月', '火', '水', '木', '金', '土'].forEach((w, i) => {
    cal.appendChild(el('div', 'ch' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), w));
  });
  for (let i = 0; i < d[0].dow; i++) cal.appendChild(el('div', 'cd empty'));
  const CYCLE = ['休', '特', '✖', null];
  for (const day of d) {
    const cur = (mdata().requests[m.id] || {})[day.day] || null;
    const cd = el('div', 'cd' + (cur === '休' ? ' off' : cur === '特' ? ' special' : cur === '✖' ? ' ng' : ''));
    cd.appendChild(el('div', 'dn', String(day.day)));
    cd.appendChild(el('div', 'sy', cur || ''));
    cd.addEventListener('click', () => {
      const r = mdata().requests;
      r[m.id] = r[m.id] || {};
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
      if (next === null) delete r[m.id][day.day]; else r[m.id][day.day] = next;
      save();
      openCalendar(m);
      renderRoster(); renderSummary(); renderLaunch();
    });
    cal.appendChild(cd);
  }
  body.appendChild(cal);

  const foot = el('div', 'row');
  const wish = el('label', 'inline');
  wish.appendChild(el('span', '', '連休の希望'));
  const num = el('input');
  num.type = 'number'; num.min = '0'; num.max = '14'; num.className = 'num-input';
  num.value = mdata().streaks[m.id] || '';
  num.addEventListener('change', () => {
    const v = Number(num.value);
    if (v >= 2) mdata().streaks[m.id] = v; else delete mdata().streaks[m.id];
    save(); renderRoster(); renderStreakWishes(); renderSummary();
  });
  wish.appendChild(num);
  wish.appendChild(el('span', '', '連休（0で取り消し）'));
  foot.appendChild(wish);
  const clr = el('button', 'btn sm', 'この人の希望休を全部消す');
  clr.addEventListener('click', () => {
    delete mdata().requests[m.id];
    delete mdata().streaks[m.id];
    save(); openCalendar(m); renderCollect();
  });
  foot.appendChild(clr);
  body.appendChild(foot);
  modal.appendChild(body);
  $('#mask').classList.add('show');
}
function closeModal() { $('#mask').classList.remove('show'); }
$('#mask').addEventListener('click', (e) => { if (e.target === $('#mask')) closeModal(); });

function renderStreakWishes() {
  const host = $('#streakWishes');
  host.innerHTML = '';
  const entries = Object.entries(mdata().streaks).filter(([, n]) => n >= 2);
  if (!entries.length) { host.hidden = true; return; }
  host.hidden = false;
  host.appendChild(el('div', 'rulehead', '連休の希望（日にちは組むときに決めます）'));
  const wrap = el('div', 'legend');
  for (const [mid, n] of entries) {
    const m = state.members.find((x) => x.id === mid);
    if (!m) continue;
    const chip = el('span', 'legend-item');
    chip.appendChild(el('b', 'p-H', String(n)));
    chip.appendChild(el('span', '', `${m.name}：${n}連休`));
    const b = el('button', 'btn sm', '取消');
    b.addEventListener('click', () => { delete mdata().streaks[mid]; save(); renderCollect(); });
    chip.appendChild(b);
    wrap.appendChild(chip);
  }
  host.appendChild(wrap);
}

function renderSummary() {
  const d = days();
  const members = activeMembers();
  const submitted = members.filter((m) => hasSubmitted(m.id)).length;
  const need = d.reduce((a, day) => a + (day.closed ? 0 : expandSlots(state.rules, day.rooms).length), 0);
  const wish = members.reduce((a, m) => a + reqCount(m.id), 0);
  const streak = Object.values(mdata().streaks).filter((n) => n >= 2).length;

  const pct = members.length ? submitted / members.length : 0;
  $('#ringArc').setAttribute('stroke-dashoffset', String(219.9 * (1 - pct)));
  $('#ringNum').textContent = `${submitted}/${members.length}`;
  $('#sNeed').innerHTML = `${need}<em>枠</em>`;
  $('#sWish').innerHTML = `${wish}<em>日</em>`;
  $('#sStreak').innerHTML = `${streak}<em>件</em>`;
  $('#stepSub1').textContent = `${state.year}年${state.month}月 ／ ${submitted}/${members.length}名`;
}

function renderRules() {
  const o = state.options;
  const hard = [
    '本人が出した希望休（休・特・✖）の日には入れない',
    `連勤は${o.maxConsecutive}日まで`,
    `月の休みは最低${o.minOffDays}日`,
    '対応できるパターン・担当の仕事だけを割り当てる',
    '1人1日1枠まで／休館日は全員休み',
  ];
  const soft = [
    '各枠の必要人数を満たす（予約客室数に連動）',
    '出勤日数を、一人ひとりの目安に近づける',
    '連休の希望を、予約の少ない並びに入れる',
    o.keepPattern ? '前日と同じパターンを優先して、生活リズムを崩さない' : '（前日と同じパターンの優先は切ってあります）',
  ];
  const fill = (host, list, cls) => {
    host.innerHTML = '';
    for (const r of list) {
      const row = el('div', 'rule ' + cls);
      row.appendChild(el('span', 'ic'));
      row.appendChild(el('div', '', r));
      host.appendChild(row);
    }
  };
  fill($('#ruleHard'), hard, 'hard');
  fill($('#ruleSoft'), soft, 'soft');
}

function renderLaunch() {
  const members = activeMembers();
  const submitted = members.filter((m) => hasSubmitted(m.id)).length;
  const grid = mdata().grid;
  $('#launchTitle').textContent = grid
    ? `${state.year}年${state.month}月のシフト案はできています`
    : `${state.year}年${state.month}月のシフトを組みます`;
  $('#launchNote').textContent = submitted < members.length
    ? `未提出が${members.length - submitted}名います。このまま組むこともできます（希望なしとして扱います）。`
    : '全員の希望休がそろっています。';
  $('#btnRun').textContent = grid ? '組み直す' : 'シフトを組む';
}

/* ---------------- 取り込み ---------------- */
let importMode = 'msg';
function setImportMode(mode) {
  importMode = mode;
  $$('#importMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#hintCsv').hidden = mode !== 'csv';
  $('#hintMsg').hidden = mode !== 'msg';
  $('#rowCsv').hidden = mode !== 'csv';
  $('#rowMsg').hidden = mode !== 'msg';
  $('#csvText').placeholder = mode === 'csv' ? 'ここにCSVを貼り付け' : 'ここにメッセージを貼り付け';
  $('#csvMapping').hidden = mode !== 'csv';
  $('#csvResult').innerHTML = '';
  if (mode === 'csv') renderCsvMapping();
}

function renderCsvMapping() {
  const host = $('#csvMapping');
  host.innerHTML = '';
  if (importMode !== 'csv') return;
  const text = $('#csvText').value.trim();
  if (!text) return;
  const rows = parseCSV(text);
  if (!rows.length) return;
  const headers = rows[0];
  const guess = guessColumns(headers);
  const mkSelect = (id, label, selected, multiple) => {
    const w = el('label', 'inline');
    w.appendChild(el('span', '', label));
    const s = el('select');
    s.id = id;
    if (multiple) s.multiple = true; else s.appendChild(el('option', '', '（自動）'));
    headers.forEach((h, i) => {
      const o = el('option', '', `${i + 1}. ${h || '(無題)'}`);
      o.value = i;
      if (multiple ? selected.includes(i) : selected === i) o.selected = true;
      s.appendChild(o);
    });
    w.appendChild(s);
    return w;
  };
  host.appendChild(el('span', 'hint', `${rows.length - 1}件の回答を読み込みました。`));
  host.appendChild(mkSelect('mapName', '名前の列', guess.nameCol, false));
  host.appendChild(mkSelect('mapDays', '希望休の列', guess.dayCols, true));
}

function applyRequest(memberId, daysArr, sym) {
  const rr = mdata().requests;
  rr[memberId] = rr[memberId] || {};
  for (const d of daysArr) rr[memberId][d] = sym;
  save();
  renderCollect();
}

/** 自動で決めきれなかった分を並べる */
function renderCheckList(host, items) {
  host.appendChild(el('h3', '', `確認が必要 ${items.length}件`));
  const ul = el('ul', 'check-list');
  for (const it of items) {
    const li = el('li');
    li.appendChild(el('span', 'check-who', it.who));
    li.appendChild(el('span', 'check-why', it.why));
    const done = () => { li.classList.add('resolved'); toast('取り込みました'); };
    if (it.days.length && it.memberId) {
      const b = el('button', 'btn sm', `${it.days.map((x) => x + '日').join('・')} を取り込む`);
      b.addEventListener('click', () => { applyRequest(it.memberId, it.days, it.sym); done(); });
      li.appendChild(b);
    } else if (it.days.length) {
      const sel = el('select');
      sel.appendChild(el('option', '', '― この人に割り当てる ―'));
      for (const m of (it.candidates || activeMembers())) {
        const o = el('option', '', m.name);
        o.value = m.id;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { if (sel.value) { applyRequest(sel.value, it.days, it.sym); done(); } });
      li.appendChild(el('span', '', `${it.days.map((x) => x + '日').join('・')} →`));
      li.appendChild(sel);
    } else {
      li.appendChild(el('span', 'check-why', 'カレンダーから直接入れてください'));
    }
    if (it.text) li.appendChild(el('span', 'check-text', it.text));
    ul.appendChild(li);
  }
  host.appendChild(ul);
}

function doImportMessages() {
  const text = $('#csvText').value.trim();
  if (!text) { toast('メッセージを貼り付けてください'); return; }
  const d = days();
  const res = importMessages(text, { members: activeMembers(), month: state.month, daysInMonth: d.length });
  const checks = [
    ...res.needsCheck.map((n) => ({ who: n.member.name, why: n.reason, text: n.text, days: n.days, sym: n.sym, memberId: n.member.id })),
    ...res.ambiguous.map((a) => ({
      who: `「${a.key}」`, why: `${a.members.map((m) => m.name).join(' / ')} のどちらか分かりません`,
      text: a.text, days: a.days, sym: a.sym, candidates: a.members,
    })),
    ...(res.unassigned ? [{ who: '名前なし', why: '誰の希望休か分かりません', text: res.unassigned.text, days: res.unassigned.days, sym: res.unassigned.sym }] : []),
  ];
  const host = $('#csvResult');
  host.innerHTML = '';
  if (!res.matched.length && !checks.length) {
    host.appendChild(el('p', 'hint', '日にちを読み取れませんでした。「日下 3日 4日 休み希望」のように、名前（苗字だけでも可）と日にちが入っているか確認してください。'));
    toast('読み取れませんでした');
    return;
  }
  if ($('#csvReplace').checked) { mdata().requests = {}; mdata().streaks = {}; }
  const r = mdata().requests;
  for (const [mid, obj] of Object.entries(res.requests)) r[mid] = { ...(r[mid] || {}), ...obj };
  Object.assign(mdata().streaks, res.streaks);
  save();

  host.appendChild(el('h3', '', `取り込み ${res.matched.length}件`));
  const ul = el('ul', 'ok-list');
  for (const p of res.matched) {
    const parts = [];
    if (p.days.length > 4) parts.push(`${p.days[0]}日〜${p.days[p.days.length - 1]}日の ${p.days.length}日間`);
    else if (p.days.length) parts.push(p.days.map((x) => x + '日').join('・'));
    if (p.streak) parts.push(`${p.streak}連休の希望`);
    ul.appendChild(el('li', '', `${p.member.name}：${parts.join(' ＋ ')}（${p.sym}）`));
  }
  host.appendChild(ul);
  if (checks.length) renderCheckList(host, checks);
  renderCollect();
  toast(res.matched.length ? `希望休を${res.matched.length}件取り込みました` : `${checks.length}件は確認が必要です`);
}

function doImportCsv() {
  if (importMode === 'msg') { doImportMessages(); return; }
  const text = $('#csvText').value.trim();
  if (!text) { toast('CSVを貼り付けてください'); return; }
  const nameSel = $('#mapName');
  const daySel = $('#mapDays');
  const d = days();
  const res = importFormCsv(text, {
    members: activeMembers(), month: state.month, daysInMonth: d.length,
    nameCol: nameSel && nameSel.value !== '' ? Number(nameSel.value) : -1,
    dayCols: daySel ? [...daySel.selectedOptions].map((o) => Number(o.value)) : [],
  });
  if ($('#csvReplace').checked) { mdata().requests = {}; mdata().streaks = {}; }
  const r = mdata().requests;
  for (const [mid, obj] of Object.entries(res.requests)) r[mid] = { ...(r[mid] || {}), ...obj };
  save();
  const host = $('#csvResult');
  host.innerHTML = '';
  host.appendChild(el('h3', '', `取り込み ${res.preview.length}件`));
  const ul = el('ul', 'ok-list');
  for (const p of res.preview) ul.appendChild(el('li', '', `${p.name}：${p.days.map((x) => x + '日').join('・') || '指定なし'}（${p.sym}）`));
  host.appendChild(ul);
  if (res.unmatched.length) {
    renderCheckList(host, res.unmatched.map((u) => ({ who: `「${u.name}」`, why: '名簿に一致するスタッフがいません', text: '', days: u.days, sym: u.sym })));
  }
  renderCollect();
  toast(`希望休を${res.preview.length}件取り込みました`);
}

/* ---------------- 予約客室数 ---------------- */
function renderRoomsGrid() {
  const host = $('#roomsGrid');
  host.innerHTML = '';
  const d = days();
  for (const day of d) {
    const cell = el('div', 'room-cell' + (day.dow === 0 ? ' sun' : day.dow === 6 ? ' sat' : ''));
    const head = el('div', 'room-day');
    head.appendChild(el('span', '', String(day.day)));
    head.appendChild(el('span', 'dw', ' ' + DOW_LABELS[day.dow]));
    cell.appendChild(head);
    const inp = el('input');
    inp.type = 'number'; inp.min = '0'; inp.max = '28';
    inp.value = mdata().rooms[day.day] === undefined ? '' : mdata().rooms[day.day];
    inp.placeholder = String(state.options.defaultRooms);
    inp.addEventListener('change', () => {
      if (inp.value === '') delete mdata().rooms[day.day];
      else mdata().rooms[day.day] = Number(inp.value);
      save();
      updateRoomNeed(cell, inp.value === '' ? state.options.defaultRooms : Number(inp.value));
      renderSummary();
    });
    cell.appendChild(inp);
    const cl = el('label', 'inline');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = mdata().closed.includes(day.day);
    cb.addEventListener('change', () => {
      const c = mdata().closed;
      if (cb.checked) { if (!c.includes(day.day)) c.push(day.day); }
      else mdata().closed = c.filter((x) => x !== day.day);
      save(); renderRoomsGrid(); renderSummary();
    });
    cl.appendChild(cb);
    cl.appendChild(el('span', 'room-need', '休館'));
    cell.appendChild(cl);
    const need = el('div', 'room-need');
    cell.appendChild(need);
    updateRoomNeed(cell, day.rooms);
    host.appendChild(cell);
  }
}
function updateRoomNeed(cell, rooms) {
  const n = cell.querySelector('.room-need:last-child');
  if (n) n.textContent = '必要 ' + expandSlots(state.rules, rooms).length + '名';
}

/* ---------------- 詳細設定 ---------------- */
function renderStaff() {
  const host = $('#staffTable');
  host.innerHTML = '';
  const table = el('table', 'form-table');
  const head = el('tr');
  ['', '区分', '名前', '担当', '対応パターン', '割当', '目安', '連勤', '固定休', 'メモ'].forEach((h) => head.appendChild(el('th', '', h)));
  table.appendChild(head);
  for (const m of state.members) {
    const tr = el('tr');
    const act = el('td');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = m.active !== false;
    cb.addEventListener('change', () => { m.active = cb.checked; save(); renderCollect(); });
    act.appendChild(cb);
    tr.appendChild(act);
    tr.appendChild(textCell(m, 'kubun', 'text', '区分'));
    tr.appendChild(textCell(m, 'name', 'text', '名前'));

    const roles = el('td', 'chips');
    for (const r of ROLES) {
      const c = el('button', 'chip' + ((m.roles || []).includes(r) ? ' on' : ''), r);
      c.addEventListener('click', () => {
        m.roles = (m.roles || []).includes(r) ? m.roles.filter((x) => x !== r) : [...(m.roles || []), r];
        save(); renderStaff(); renderRoster();
      });
      roles.appendChild(c);
    }
    tr.appendChild(roles);

    const pats = el('td', 'chips');
    for (const p of PATTERN_CODES) {
      const c = el('button', 'chip' + ((m.patterns || []).includes(p) ? ' on' : ''), p);
      c.title = PATTERNS[p].time;
      c.addEventListener('click', () => {
        m.patterns = (m.patterns || []).includes(p) ? m.patterns.filter((x) => x !== p) : [...(m.patterns || []), p];
        save(); renderStaff();
      });
      pats.appendChild(c);
    }
    tr.appendChild(pats);

    const mode = el('td');
    const sel = el('select');
    for (const [k, label] of Object.entries(ASSIGN_MODES)) {
      const o = el('option', '', label); o.value = k;
      if (m.mode === k) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { m.mode = sel.value; save(); renderStaff(); renderRoster(); });
    mode.appendChild(sel);
    tr.appendChild(mode);

    tr.appendChild(numCell(m, 'targetDays', 0, 31));
    tr.appendChild(numCell(m, 'maxConsecutive', 1, 14));

    const dows = el('td', 'chips');
    for (let i = 0; i < 7; i++) {
      const c = el('chip' === '' ? 'span' : 'button', 'chip' + ((m.fixedOffDows || []).includes(i) ? ' on' : ''), DOW_LABELS[i]);
      c.addEventListener('click', () => {
        m.fixedOffDows = (m.fixedOffDows || []).includes(i) ? m.fixedOffDows.filter((x) => x !== i) : [...(m.fixedOffDows || []), i];
        save(); renderStaff();
      });
      dows.appendChild(c);
    }
    tr.appendChild(dows);
    tr.appendChild(textCell(m, 'note', 'text', 'メモ'));
    table.appendChild(tr);
  }
  host.appendChild(table);
}
function textCell(obj, key, type, ph) {
  const td = el('td');
  const i = el('input'); i.type = type; i.value = obj[key] || ''; i.placeholder = ph || '';
  i.addEventListener('change', () => { obj[key] = i.value; save(); renderRoster(); });
  td.appendChild(i);
  return td;
}
function numCell(obj, key, min, max) {
  const td = el('td');
  const i = el('input'); i.type = 'number'; i.className = 'num-input';
  i.min = min; i.max = max; i.value = obj[key] === undefined ? '' : obj[key];
  i.addEventListener('change', () => { obj[key] = Number(i.value); save(); });
  td.appendChild(i);
  return td;
}

function renderRuleTable() {
  const host = $('#rulesTable');
  host.innerHTML = '';
  const t = el('table', 'form-table');
  const h = el('tr');
  ['', '枠の名前', 'パターン', '対象の担当', '基本', '加算間隔(室)', '上限', '空きでOK'].forEach((x) => h.appendChild(el('th', '', x)));
  t.appendChild(h);
  for (const r of state.rules) {
    const tr = el('tr');
    const on = el('td');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = r.enabled !== false;
    cb.addEventListener('change', () => { r.enabled = cb.checked; save(); renderRuleTable(); renderSummary(); renderRoomsGrid(); });
    on.appendChild(cb); tr.appendChild(on);
    tr.appendChild(textCell(r, 'label', 'text', '枠の名前'));
    const pt = el('td');
    const sel = el('select');
    for (const p of PATTERN_CODES) {
      const o = el('option', '', `${p}　${PATTERNS[p].time}`); o.value = p;
      if (r.pattern === p) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { r.pattern = sel.value; save(); renderRuleTable(); });
    pt.appendChild(sel); tr.appendChild(pt);
    const rl = el('td', 'chips');
    for (const role of ROLES) {
      const c = el('button', 'chip' + ((r.roles || []).includes(role) ? ' on' : ''), role);
      c.addEventListener('click', () => {
        r.roles = (r.roles || []).includes(role) ? r.roles.filter((x) => x !== role) : [...(r.roles || []), role];
        save(); renderRuleTable();
      });
      rl.appendChild(c);
    }
    tr.appendChild(rl);
    tr.appendChild(numCell(r, 'base', 0, 10));
    tr.appendChild(numCell(r, 'perRooms', 0, 28));
    tr.appendChild(numCell(r, 'max', 0, 10));
    const opt = el('td');
    const ob = el('input'); ob.type = 'checkbox'; ob.checked = !!r.optional;
    ob.addEventListener('change', () => { r.optional = ob.checked; save(); });
    opt.appendChild(ob); tr.appendChild(opt);
    t.appendChild(tr);
  }
  host.appendChild(t);

  const pv = $('#rulesPreview');
  pv.innerHTML = '';
  const t2 = el('table', 'mini');
  const hr = el('tr');
  hr.appendChild(el('th', '', '予約客室数'));
  [0, 4, 8, 12, 16, 20, 24, 28].forEach((n) => hr.appendChild(el('th', '', n + '室')));
  t2.appendChild(hr);
  const rr = el('tr');
  rr.appendChild(el('th', '', '必要人数'));
  [0, 4, 8, 12, 16, 20, 24, 28].forEach((n) => rr.appendChild(el('td', '', expandSlots(state.rules, n).length + '名')));
  t2.appendChild(rr);
  pv.appendChild(t2);

  const ph = $('#patternTable');
  ph.innerHTML = '';
  const t3 = el('table', 'mini');
  const h3 = el('tr');
  ['記号', '就労時間', '実働', '休憩'].forEach((x) => h3.appendChild(el('th', '', x)));
  t3.appendChild(h3);
  for (const code of PATTERN_CODES) {
    const p = PATTERNS[code];
    const row = el('tr');
    row.appendChild(el('th', 'p-' + code, code));
    row.appendChild(el('td', '', p.time));
    row.appendChild(el('td', '', p.hours + 'h'));
    row.appendChild(el('td', '', p.rest + 'h'));
    t3.appendChild(row);
  }
  ph.appendChild(t3);
}

function bindOptions() {
  const map = [
    ['#optMaxConsecutive', 'maxConsecutive'], ['#optMinOff', 'minOffDays'],
    ['#optIterations', 'iterations'], ['#defaultRooms', 'defaultRooms'],
  ];
  for (const [sel, key] of map) {
    const e = $(sel);
    e.value = state.options[key];
    e.addEventListener('change', () => { state.options[key] = Number(e.value); save(); renderCollect(); });
  }
  const kp = $('#optKeepPattern');
  kp.checked = !!state.options.keepPattern;
  kp.addEventListener('change', () => { state.options.keepPattern = kp.checked; save(); renderRules(); });
}

/* ================= 手順2：組む ================= */
let runner = null;
let runRaf = null;

function startRun(newSeed) {
  if (newSeed) state.options.seed = Math.floor(Math.random() * 1e6) + 1;
  goStep(2);
  const c = ctx();
  runner = createRun(c);
  const log = $('#runLog');
  log.innerHTML = '';
  $('#runPulse').hidden = false;
  $('#runTitle').textContent = '配置を探しています';
  $('#btnRunStop').hidden = false;
  const t0 = performance.now();
  let lastCost = Infinity;

  const paint = () => {
    const b = runner.best;
    const pct = runner.done / runner.total;
    $('#progBar').style.width = (pct * 100).toFixed(1) + '%';
    $('#progLeft').textContent = `${runner.done} / ${runner.total} 回`;
    $('#progRight').textContent = `${Math.round(performance.now() - t0)} ms`;
    $('#mTried').textContent = runner.done.toLocaleString('ja-JP');
    if (!b) return;
    const short = b.issues.filter((i) => i.type === 'shortage' && !i.optional).length;
    const need = b.dayStats.reduce((a, x) => a + x.required, 0);
    const got = b.dayStats.reduce((a, x) => a + x.filled, 0);
    $('#mShort').textContent = short + '枠';
    $('#mFill').textContent = need ? Math.round((got / need) * 100) + '%' : '—';
    $('#mHours').textContent = b.dayStats.reduce((a, x) => a + x.hours, 0) + 'h';
    $('#mCost').textContent = b.cost.toLocaleString('ja-JP');
    if (b.cost < lastCost) {
      lastCost = b.cost;
      const row = el('div', 'lrow');
      row.appendChild(el('span', 'it', String(runner.improvedAt).padStart(4, ' ') + '回目'));
      row.appendChild(el('span', 'msg good', `評価値 ${b.cost}`));
      row.appendChild(el('span', 'msg', `不足${short}枠／充足${need ? Math.round((got / need) * 100) : 0}%`));
      log.insertBefore(row, log.firstChild);
    }
  };

  // requestAnimationFrame はタブが裏に回ると止まるので、タイマーで回す。
  // こうしておくと、画面を見ていない間も探索は最後まで進む。
  const loop = () => {
    const more = runner.step(25);
    paint();
    if (more) { runRaf = setTimeout(loop, 0); return; }
    finishRun(performance.now() - t0);
  };
  $('#runSub').textContent = `${c.days.length}日 × ${c.members.length}名の割り当てを、条件を変えながら試します`;
  renderRunChecks();
  paint();
  runRaf = setTimeout(loop, 0);
}

function finishRun(ms) {
  clearTimeout(runRaf);
  runRaf = null;
  $('#runPulse').hidden = true;
  $('#btnRunStop').hidden = true;
  const best = runner.best;
  if (!best) { goStep(1); return; }
  mdata().grid = best.grid;
  save();
  $('#runTitle').textContent = '組み終わりました';
  $('#runSub').textContent = `${runner.done}回ためして、一番良い配置を選びました（${Math.round(ms)}ms）`;
  setTimeout(() => { if (step === 2) goStep(3); }, 450);
}

function renderRunChecks() {
  const o = state.options;
  const host = $('#runChecks');
  host.innerHTML = '';
  const list = [
    '希望休を守る', `連勤${o.maxConsecutive}日まで`, `休み最低${o.minOffDays}日`,
    '担当・対応パターン', '必要人数', '連休の希望', '休館日',
  ];
  const wrap = el('div', 'legend');
  for (const x of list) {
    const c = el('span', 'legend-item');
    c.appendChild(el('b', 'p-H', '✓'));
    c.appendChild(el('span', '', x));
    wrap.appendChild(c);
  }
  host.appendChild(wrap);
}

/* ================= 手順3：確認して仕上げる ================= */
function renderResult() {
  const grid = mdata().grid;
  if (!grid) return;
  const c = ctx();
  const v = validate(c, grid);
  $('#resTitle').textContent = `${state.year}年${state.month}月のシフト案`;
  renderKpis(v);
  renderLegend();
  renderSheet(v);
  renderNotes(v, grid);
  renderPersum(v);
  renderDaystrip(v);
  renderTimeline();
  $('#sheetView').hidden = view !== 'sheet';
  $('#tlView').hidden = view !== 'tl';
  $('#stepSub3').textContent = `不足${v.issues.filter((i) => i.type === 'shortage' && !i.optional).length}枠`;
}

function renderKpis(v) {
  const short = v.issues.filter((i) => i.type === 'shortage' && !i.optional);
  const soft = v.issues.filter((i) => i.type === 'shortage' && i.optional);
  const other = v.issues.filter((i) => i.type !== 'shortage');
  const need = v.dayStats.reduce((a, x) => a + x.required, 0);
  const got = v.dayStats.reduce((a, x) => a + x.filled, 0);
  const hours = v.dayStats.reduce((a, x) => a + x.hours, 0);

  const h = $('#headline');
  h.className = 'headline ' + (short.length ? 'bad' : 'good');
  h.textContent = short.length
    ? `人が足りない枠が ${short.length}件 あります。下の「申し送り」から、誰を入れるか選んでください。`
    : 'このままシフト表として使えます。人が足りない枠はありません。';

  const host = $('#kpis');
  host.innerHTML = '';
  const card = (k, val, note, cls) => {
    const c = el('div', 'kpi ' + (cls || ''));
    c.appendChild(el('div', 'k', k));
    c.appendChild(el('div', 'v', String(val)));
    c.appendChild(el('div', 'n', note));
    return c;
  };
  host.appendChild(card('人が足りない枠', short.length, short.length ? '要対応' : '問題なし', short.length ? 'bad' : 'ok'));
  host.appendChild(card('枠の充足率', (need ? Math.round((got / need) * 100) : 0) + '%', `${got} / ${need}枠`));
  host.appendChild(card('空きでOKの枠', soft.length, '無くても回る枠'));
  host.appendChild(card('その他の注意', other.length, '連勤・休日数など'));
  host.appendChild(card('月の総工数', hours + 'h', '全員の実働の合計'));
  host.appendChild(card('のべ出勤', v.memberStats.reduce((a, s) => a + s.work, 0) + '日', '全員の出勤日の合計'));
}

function renderLegend() {
  const host = $('#legend');
  host.innerHTML = '';
  $('#legendPad').hidden = !$('#showLegend').checked;
  for (const code of PATTERN_CODES) {
    const p = PATTERNS[code];
    const s = el('span', 'legend-item');
    s.appendChild(el('b', 'p-' + code, code));
    s.appendChild(el('span', '', p.time));
    s.appendChild(el('span', 'legend-h', `実働${p.hours}h`));
    host.appendChild(s);
  }
  for (const [sym, info] of Object.entries(OFF_SYMBOLS)) {
    const s = el('span', 'legend-item');
    s.appendChild(el('b', '', sym));
    s.appendChild(el('span', '', info.label));
    host.appendChild(s);
  }
  const s = el('span', 'legend-item');
  s.appendChild(el('b', '', '空欄'));
  s.appendChild(el('span', '', '常勤者の出勤日'));
  host.appendChild(s);
}

function cellTitle(m, day, val) {
  const date = `${state.month}月${day.day}日(${DOW_LABELS[day.dow]})`;
  let what;
  if (PATTERNS[val]) what = `${val}　${PATTERNS[val].time}（実働${PATTERNS[val].hours}h）`;
  else if (OFF_SYMBOLS[val]) what = `${val}　${OFF_SYMBOLS[val].label}`;
  else if (m.mode === 'always') what = '出勤（常勤・記号なし）';
  else if (m.mode === 'manual') what = '手入力（自動では触りません）';
  else what = '未割当';
  return `${m.name}　${date}\n${what}\nクリックで変更／ドラッグで同じ日の人と入れ替え`;
}

function renderSheet(v) {
  const d = days();
  const grid = mdata().grid;
  const host = $('#shiftGrid');
  host.innerHTML = '';
  const showTimes = $('#showTimes').checked;
  document.body.classList.toggle('big', $('#bigText').checked);

  const table = el('table', 'sheet');
  const thead = el('thead');
  const r1 = el('tr');
  ['区分', '名前', '担当', '出勤'].forEach((h, i) => r1.appendChild(el('th', 'stick c' + (i + 1), h)));
  d.forEach((day, col) => {
    const th = el('th', 'day' + (day.dow === 0 ? ' sun' : day.dow === 6 ? ' sat' : '') + (day.closed ? ' closed' : '') + (isToday(day) ? ' today' : ''));
    th.dataset.col = col;
    th.appendChild(el('div', 'dnum', String(day.day)));
    th.appendChild(el('div', 'dow', DOW_LABELS[day.dow]));
    th.appendChild(el('div', 'rooms', day.closed ? '休館' : day.rooms + '室'));
    th.title = `${state.month}月${day.day}日(${DOW_LABELS[day.dow]})　${day.closed ? '休館日' : '予約 ' + day.rooms + '室'}`;
    r1.appendChild(th);
  });
  thead.appendChild(r1);
  table.appendChild(thead);

  const tbody = el('tbody');
  let prevGroup = null;
  for (const m of activeMembers()) {
    const tr = el('tr');
    const group = (m.roles || [])[0] || '';
    if (prevGroup !== null && group !== prevGroup) tr.classList.add('group-top');
    prevGroup = group;
    tr.appendChild(el('td', 'stick c1', m.kubun || ''));
    tr.appendChild(el('td', 'stick c2', m.name));
    const roles = el('td', 'stick c3');
    for (const r of (m.roles || [])) roles.appendChild(el('span', 'tag ' + r, r));
    tr.appendChild(roles);
    const st = v.memberStats.find((s) => s.id === m.id);
    tr.appendChild(el('td', 'stick c4', m.mode === 'manual' ? '—' : String(st ? st.work : 0)));

    d.forEach((day, col) => {
      const val = grid[m.id] ? grid[m.id][day.day] : '';
      const td = el('td', 'cell');
      td.dataset.member = m.id;
      td.dataset.day = day.day;
      td.dataset.col = col;
      const shown = val === null || val === undefined ? '' : val;
      td.textContent = showTimes && PATTERNS[shown] ? PATTERNS[shown].time.split('〜')[0] : shown;
      td.title = cellTitle(m, day, shown);
      if (isToday(day)) td.classList.add('today');
      if (isWorkSymbol(val)) td.classList.add('work', 'p-' + val);
      else if (val === '休') td.classList.add('off');
      else if (val === '特') td.classList.add('special');
      else if (val === '✖') td.classList.add('ng');
      if (m.mode === 'always' && val === '') td.classList.add('always-work');
      if ((mdata().requests[m.id] || {})[day.day]) td.classList.add('requested');
      if (day.dow === 0) td.classList.add('sun');
      if (day.dow === 6) td.classList.add('sat');
      if (m.mode !== 'manual' && !day.closed) {
        td.draggable = true;
        td.addEventListener('dragstart', onDragStart);
        td.addEventListener('dragover', onDragOver);
        td.addEventListener('dragleave', () => td.classList.remove('over', 'no'));
        td.addEventListener('drop', onDrop);
        td.addEventListener('dragend', onDragEnd);
      }
      td.addEventListener('click', (ev) => openCellPopup(ev, m, day));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  const foot = el('tbody', 'foot');
  const mk = (label, fn) => {
    const tr = el('tr');
    const th = el('td', 'stick c1 label', label);
    th.colSpan = 4;
    tr.appendChild(th);
    d.forEach((day, col) => {
      const ds = v.dayStats.find((x) => x.day === day.day);
      const td = el('td', 'num');
      td.dataset.col = col;
      const [text, bad] = fn(ds);
      td.textContent = text;
      if (bad) td.classList.add('warn');
      tr.appendChild(td);
    });
    return tr;
  };
  foot.appendChild(mk('必要人数', (ds) => [String(ds.required), false]));
  foot.appendChild(mk('入っている人数', (ds) => [String(ds.filled), ds.filled < ds.required]));
  foot.appendChild(mk('出勤する人（全体）', (ds) => [String(ds.headcount), false]));
  foot.appendChild(mk('その日の総工数(h)', (ds) => [String(ds.hours), false]));
  table.appendChild(tbody);
  table.appendChild(foot);
  attachCrosshair(table);
  host.appendChild(table);
}

function attachCrosshair(table) {
  let last = null;
  const clear = () => {
    if (last === null) return;
    table.querySelectorAll(`[data-col="${last}"]`).forEach((n) => n.classList.remove('col-hi'));
    last = null;
  };
  table.addEventListener('mouseover', (ev) => {
    const cell = ev.target.closest && ev.target.closest('[data-col]');
    if (!cell) { clear(); return; }
    if (cell.dataset.col === last) return;
    clear();
    last = cell.dataset.col;
    table.querySelectorAll(`[data-col="${last}"]`).forEach((n) => n.classList.add('col-hi'));
  });
  table.addEventListener('mouseleave', clear);
}

/* ---- ドラッグで入れ替え（同じ日の2人のあいだだけ） ---- */
let dragFrom = null;
function cellValue(memberId, day) {
  const g = mdata().grid;
  const v = g[memberId] ? g[memberId][day] : '';
  return v === null || v === undefined ? '' : v;
}
/** その人がその日にその値を持てるか */
function canHold(m, day, val) {
  if (m.mode === 'manual') return false;
  const req = (mdata().requests[m.id] || {})[day];
  if (isWorkSymbol(val)) {
    if (req) return false;                                   // 希望休の日に仕事は入れない
    if (!(m.patterns || []).includes(val)) return false;     // 対応できないパターン
    const d = days().find((x) => x.day === day);
    if (d && d.closed) return false;
    return true;
  }
  return true;                                               // 休み・空欄はいつでも可
}
function onDragStart(e) {
  const td = e.currentTarget;
  dragFrom = { member: td.dataset.member, day: Number(td.dataset.day), col: td.dataset.col };
  td.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'swap');
}
function onDragOver(e) {
  if (!dragFrom) return;
  const td = e.currentTarget;
  const ok = td.dataset.col === dragFrom.col && td.dataset.member !== dragFrom.member && swapOk(td);
  td.classList.toggle('over', ok);
  td.classList.toggle('no', !ok);
  if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
}
function swapOk(td) {
  const day = Number(td.dataset.day);
  const a = state.members.find((m) => m.id === dragFrom.member);
  const b = state.members.find((m) => m.id === td.dataset.member);
  if (!a || !b) return false;
  return canHold(a, day, cellValue(b.id, day)) && canHold(b, day, cellValue(a.id, day));
}
function onDrop(e) {
  e.preventDefault();
  const td = e.currentTarget;
  td.classList.remove('over', 'no');
  if (!dragFrom || td.dataset.col !== dragFrom.col || !swapOk(td)) return;
  const day = Number(td.dataset.day);
  const g = mdata().grid;
  const a = dragFrom.member, b = td.dataset.member;
  const va = cellValue(a, day), vb = cellValue(b, day);
  g[a] = g[a] || {}; g[b] = g[b] || {};
  g[a][day] = vb; g[b][day] = va;
  save();
  const an = state.members.find((m) => m.id === a).name;
  const bn = state.members.find((m) => m.id === b).name;
  toast(`${state.month}/${day}　${an} ⇄ ${bn} を入れ替えました`);
  dragFrom = null;
  renderResult();
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  $$('.cell.over,.cell.no').forEach((n) => n.classList.remove('over', 'no'));
  dragFrom = null;
}

/* ---- セルを直接変える ---- */
function openCellPopup(ev, member, day) {
  if (dragFrom) return;
  const pop = $('#cellPopup');
  pop.innerHTML = '';
  pop.classList.remove('hidden');
  pop.appendChild(el('div', 'pop-head', `${member.name}　${state.month}/${day.day}(${DOW_LABELS[day.dow]})`));
  const cur = cellValue(member.id, day.day);
  const opts = el('div', 'pop-opts');
  const add = (val, label, foreign) => {
    const b = el('button', 'pop-opt' + (val === cur ? ' current' : '') + (foreign ? ' foreign' : ''), label);
    b.addEventListener('click', () => {
      const g = mdata().grid;
      g[member.id] = g[member.id] || {};
      g[member.id][day.day] = val;
      save();
      pop.classList.add('hidden');
      renderResult();
    });
    opts.appendChild(b);
  };
  for (const code of PATTERN_CODES) {
    add(code, `${code}　${PATTERNS[code].time}`, !(member.patterns || []).includes(code));
  }
  for (const [sym, info] of Object.entries(OFF_SYMBOLS)) add(sym, `${sym}　${info.label}`);
  if (member.mode === 'always') add('', '空欄（出勤）');
  pop.appendChild(opts);
  const r = ev.currentTarget.getBoundingClientRect();
  pop.style.top = Math.min(window.innerHeight - 330, r.bottom + window.scrollY + 4) + 'px';
  pop.style.left = Math.min(window.innerWidth - 280, r.left + window.scrollX) + 'px';
}
document.addEventListener('click', (e) => {
  const pop = $('#cellPopup');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.classList.contains('cell')) pop.classList.add('hidden');
});

/* ---- 申し送り ---- */
function renderNotes(v, grid) {
  const host = $('#notes');
  host.innerHTML = '';
  const groups = [
    ['shortage', 'bad', '人が足りない枠', (i) => !i.optional],
    ['shortage', 'warn', '空きでOKの枠（対応できる人が休み）', (i) => i.optional],
    ['request', 'bad', '希望休との食い違い', () => true],
    ['streak', 'warn', '連勤が上限を超えている', () => true],
    ['streakWish', 'warn', '連休の希望が入っていない', () => true],
    ['off', 'warn', '休日数が足りない', () => true],
    ['workload', 'warn', '出勤日数のかたより', () => true],
  ];
  let any = false;
  for (const [type, cls, title, filter] of groups) {
    const list = v.issues.filter((i) => i.type === type && filter(i));
    if (!list.length) continue;
    any = true;
    host.appendChild(el('div', 'rulehead', `${title}（${list.length}件）`));
    for (const i of list) {
      const n = el('div', 'note ' + cls);
      n.appendChild(el('span', 'ic'));
      const bd = el('div', 'bd');
      bd.appendChild(el('div', 't', i.message));
      if (type === 'shortage') {
        const cands = candidatesFor({ ...ctx() }, grid, i.day, i.pattern, i.roles);
        if (cands.length) {
          const sel = el('select');
          sel.appendChild(el('option', '', '― この人を入れる ―'));
          for (const c of cands) {
            const o = el('option', '', c.name); o.value = c.id;
            sel.appendChild(o);
          }
          sel.addEventListener('change', () => {
            if (!sel.value) return;
            const g = mdata().grid;
            g[sel.value] = g[sel.value] || {};
            g[sel.value][i.day] = i.pattern;
            save();
            renderResult();
            toast('割り当てました');
          });
          bd.appendChild(sel);
        } else {
          bd.appendChild(el('div', 'd', 'この日に空いている対応者がいません。希望休を調整するか、必要人数のルールを見直してください。'));
        }
      }
      n.appendChild(bd);
      host.appendChild(n);
    }
  }
  if (!any) host.appendChild(el('p', 'hint', '直したほうがよい点はありません。'));
}

function renderPersum(v) {
  const host = $('#persum');
  host.innerHTML = '';
  const d = days();
  for (const m of activeMembers()) {
    const st = v.memberStats.find((s) => s.id === m.id);
    if (!st) continue;
    const row = el('div', 'psum');
    row.appendChild(el('div', 'nm', m.name));
    const bar = el('div', 'bar');
    const i = el('i');
    const target = m.targetDays || d.length;
    i.style.width = Math.min(100, (st.work / Math.max(1, target)) * 100) + '%';
    if (st.work > target + 2) i.classList.add('over');
    bar.appendChild(i);
    row.appendChild(bar);
    row.appendChild(el('div', 'nums', m.mode === 'manual' ? '手入力' : `出${st.work} 休${st.off} 連${st.maxStreak}`));
    host.appendChild(row);
  }
}

/* ---- 日別タイムライン ---- */
function hourSlots() {
  const out = [];
  for (let h = DAY_START; h < DAY_END; h++) out.push(h);
  return out;
}
function coversHour(code, h) {
  return patternSegments(code).some((s) => s.from <= h && h < s.to);
}

function renderDaystrip(v) {
  const host = $('#daystrip');
  host.innerHTML = '';
  const d = days();
  if (tlDay === null || !d.some((x) => x.day === tlDay)) {
    const bad = v.dayStats.find((x) => x.filled < x.required);
    tlDay = bad ? bad.day : d[0].day;
  }
  for (const day of d) {
    const ds = v.dayStats.find((x) => x.day === day.day);
    const b = el('button', 'dbtn' + (day.day === tlDay ? ' on' : '') + (ds && ds.filled < ds.required ? ' short' : ''));
    b.appendChild(el('div', 'n', String(day.day)));
    b.appendChild(el('div', 'w', DOW_LABELS[day.dow]));
    b.appendChild(el('div', 'r', day.closed ? '休館' : day.rooms + '室'));
    b.addEventListener('click', () => { tlDay = day.day; renderDaystrip(v); renderTimeline(); });
    host.appendChild(b);
  }
}

function renderTimeline() {
  const host = $('#timeline');
  host.innerHTML = '';
  const d = days();
  const day = d.find((x) => x.day === tlDay);
  if (!day) return;
  const grid = mdata().grid;
  const hours = hourSlots();

  $('#tlTitle').textContent = `${state.month}月${day.day}日（${DOW_LABELS[day.dow]}）`;
  $('#tlSub').textContent = day.closed ? '休館日' : `予約 ${day.rooms}室 ／ 必要 ${expandSlots(state.rules, day.rooms).length}名`;

  // その日に必要な枠（時間帯ごとの必要人数を出すため）
  const slots = day.closed ? [] : expandSlots(state.rules, day.rooms);
  const needAt = hours.map((h) => slots.filter((s) => coversHour(s.pattern, h)).length);

  const working = activeMembers()
    .map((m) => ({ m, val: grid[m.id] ? grid[m.id][day.day] : '' }))
    .filter((x) => isWorkSymbol(x.val) || (x.m.mode === 'always' && x.val === ''));

  const table = el('table', 'tl');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', 'who', 'スタッフ'));
  for (const h of hours) hr.appendChild(el('th', '', h + '時'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  if (!working.length) {
    const tr = el('tr');
    const td = el('td', 'who', '出勤者なし');
    td.colSpan = hours.length + 1;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const { m, val } of working) {
    const tr = el('tr');
    const who = el('td', 'who');
    who.appendChild(el('div', 'n', m.name));
    who.appendChild(el('div', 'p', PATTERNS[val] ? `${val} ${PATTERNS[val].time}` : (m.mode === 'always' ? '常勤（記号なし）' : val)));
    tr.appendChild(who);
    const role = (m.roles || [])[0] || '全般';
    for (const h of hours) {
      const td = el('td', 'h');
      const on = PATTERNS[val] ? coversHour(val, h) : (m.mode === 'always' && h >= 9 && h < 18);
      if (on) td.classList.add('on', 'k' + role);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const cnt = el('tr', 'count');
  const cw = el('td', 'who', '館内の人数（必要）');
  cnt.appendChild(cw);
  hours.forEach((h, idx) => {
    const n = working.filter(({ m, val }) => (PATTERNS[val] ? coversHour(val, h) : (m.mode === 'always' && h >= 9 && h < 18))).length;
    const need = needAt[idx];
    const td = el('td', '', need ? `${n}／${need}` : String(n));
    if (need && n < need) td.classList.add('low');
    cnt.appendChild(td);
  });
  tbody.appendChild(cnt);
  table.appendChild(tbody);
  host.appendChild(table);
}

/* ---------------- 書き出し ---------------- */
function copyTSV() {
  const grid = mdata().grid;
  if (!grid) { toast('先にシフトを組んでください'); return; }
  const tsv = toTSV(activeMembers(), days(), grid, { header: false });
  navigator.clipboard.writeText(tsv).then(
    () => toast('コピーしました。スプレッドシートの「区分」列の1行目に貼り付けてください'),
    () => {
      const ta = el('textarea');
      ta.value = tsv;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      toast('コピーしました');
    },
  );
}

async function downloadCSV() {
  const grid = mdata().grid;
  if (!grid) { toast('先にシフトを組んでください'); return; }
  const tsv = toTSV(activeMembers(), days(), grid, { header: true });
  const csv = tsv.split('\n').map((line) => line.split('\t').map((c) => (/[",]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');
  const body = '﻿' + csv;
  const filename = `シフト案_${state.year}年${state.month}月.csv`;
  const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: body }); toast('CSVを保存しました'); }
    catch (e) { if (!e || e.code !== 'declined') toast('CSVを保存できませんでした'); }
    return;
  }
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 起動 ---------------- */
function shiftMonth(delta) {
  let y = state.year, m = state.month + delta;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  state.year = y; state.month = m;
  tlDay = null;
  save();
  syncMonthInputs();
  goStep(1);
}
function syncMonthInputs() {
  $('#year').value = state.year;
  $('#month').value = state.month;
}

$$('#stepper .step').forEach((b) => b.addEventListener('click', () => {
  const n = Number(b.dataset.s);
  if (n === 2) { if (mdata().grid) goStep(3); else startRun(false); return; }
  goStep(n);
}));
$('#btnRun').addEventListener('click', () => startRun(false));
$('#btnRedo').addEventListener('click', () => startRun(true));
$('#btnBack1').addEventListener('click', () => goStep(1));
$('#btnRunStop').addEventListener('click', () => { if (runRaf) finishRun(0); });
$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
$('#year').addEventListener('change', (e) => { state.year = Number(e.target.value); tlDay = null; save(); goStep(1); });
$('#month').addEventListener('change', (e) => { state.month = Number(e.target.value); tlDay = null; save(); goStep(1); });
$('#btnCopy').addEventListener('click', copyTSV);
$('#btnCsv').addEventListener('click', downloadCSV);
$('#showTimes').addEventListener('change', renderResult);
$('#bigText').addEventListener('change', renderResult);
$('#showLegend').addEventListener('change', renderLegend);
$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.v;
  $$('#viewSeg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#sheetView').hidden = view !== 'sheet';
  $('#tlView').hidden = view !== 'tl';
}));
$$('#importMode button').forEach((b) => b.addEventListener('click', () => setImportMode(b.dataset.mode)));
$('#importCsv').addEventListener('click', doImportCsv);
$('#csvText').addEventListener('input', renderCsvMapping);
$('#csvFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { $('#csvText').value = r.result; renderCsvMapping(); };
  r.readAsText(f, 'utf-8');
});
$('#pasteSample').addEventListener('click', () => {
  const names = activeMembers().slice(1, 5).map((m) => m.name);
  $('#csvText').value = [
    'タイムスタンプ,お名前,希望休の日,備考',
    `2026/08/20 9:01,${names[0] || '山田 麗奈'},"3, 4, 12",`,
    `2026/08/20 9:12,${names[1] || '山下 創士朗'},"8日 9日 20日",`,
    `2026/08/20 10:02,${names[2] || '駒澤 晴信'},"15〜17",有給希望`,
    `2026/08/20 10:30,${names[3] || '薄田 裕花'},"${state.month}/5, ${state.month}/6",`,
  ].join('\n');
  renderCsvMapping();
});
$('#pasteMsgSample').addEventListener('click', () => {
  const names = activeMembers().slice(1, 5).map((m) => m.name);
  $('#csvText').value = [
    `09:12\t${names[0] || '宮平 絹江'}\t一度3連休が取りたいです`,
    `09:20\t${names[1] || '日下 堅人'}\t6日 12日は休み`,
    `10:02\t${names[2] || '山田 麗奈'}\t15〜17 有給で取らせてください`,
    `10:30\t${names[3] || '山下 創士朗'}\t${state.month}/5と${state.month}/6、どうしても来られません`,
  ].join('\n');
});
$('#btnClearReq').addEventListener('click', () => {
  if (!confirm(`${state.year}年${state.month}月の希望休をすべて消します。よろしいですか？`)) return;
  mdata().requests = {}; mdata().streaks = {}; mdata().noRequest = {};
  save(); renderCollect();
});
$('#applyRoomsPaste').addEventListener('click', () => {
  const parsed = parseRoomsInput($('#roomsPaste').value, days().length);
  const n = Object.keys(parsed).length;
  if (!n) { toast('数値を読み取れませんでした'); return; }
  mdata().rooms = { ...mdata().rooms, ...parsed };
  save(); renderRoomsGrid(); renderSummary();
  toast(`${n}日分の客室数を取り込みました`);
});
$('#btnToggleAdv').addEventListener('click', () => {
  const b = $('#advBody');
  b.hidden = !b.hidden;
  $('#btnToggleAdv').textContent = b.hidden ? '開く' : '閉じる';
  if (!b.hidden) { renderStaff(); renderRuleTable(); }
});
$('#addMember').addEventListener('click', () => {
  state.members.push({
    id: crypto.randomUUID(), name: '新しいスタッフ', kubun: '', roles: [], patterns: [],
    mode: 'auto', targetDays: 20, maxConsecutive: state.options.maxConsecutive, fixedOffDows: [], active: true, note: '',
  });
  save(); renderStaff(); renderRoster();
});
$('#resetMembers').addEventListener('click', () => {
  if (!confirm('スタッフ一覧を初期値に戻します。よろしいですか？')) return;
  state.members = defaultMembers(); save(); renderCollect(); renderStaff();
});
$('#addRule').addEventListener('click', () => {
  state.rules.push({ id: 'r' + Date.now(), label: '新しい枠', pattern: 'H', roles: [], base: 1, perRooms: 0, max: 2, enabled: true, optional: false });
  save(); renderRuleTable();
});
$('#resetRules').addEventListener('click', () => {
  if (!confirm('必要人員のルールを初期値に戻します。よろしいですか？')) return;
  state.rules = defaultSlotRules(); save(); renderRuleTable(); renderCollect();
});

syncMonthInputs();
bindOptions();
setImportMode('msg');
goStep(mdata().grid ? 3 : 1);
