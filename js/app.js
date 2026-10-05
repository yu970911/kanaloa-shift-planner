// 画面まわり。手順1「希望を集める」→ 手順2「組む」→ 手順3「確認して仕上げる」の3段構成。
import {
  PATTERNS, PATTERN_CODES, OFF_SYMBOLS, ROLES, ASSIGN_MODES,
  defaultMembers, defaultSlotRules, defaultOptions, expandSlots, buildDays, DOW_LABELS, ROSTER_REV, migrateRoster,
  RULES_REV, migrateRules,
  patternSegments, DAY_START, DAY_END, defaultLabor, kubunOf, KUBUN_LIST, monthlyHourCap, weekIndex, hoursOf, alwaysWindow, lunchDuty, cleanerCount,
} from './model.js';
import { createRun, validate, candidatesFor, isWorkSymbol, laborOf, weekCap, makeSlotter } from './solver.js';
import { importFormCsv, importMessages, guessColumns, parseCSV, parseRoomsInput, parseRoomsInputDetail, roomsFromVacancy, parseDayRequests, toTSV } from './importers.js';
import { renderShiftImage } from './image.js';
import { periodRange, deadlineOf, deadlineStatus, deadlineMessage, nextPeriod, buildNotice, fmtDate } from './period.js';
import { loadSync, saveSync, isValidSheetUrl, isSyncReady, callSheet, buildSheetTable, stateForSheet, encodeSetup, decodeSetup } from './sheets.js';
import * as account from './account.js';

const STORE_KEY = 'kanaloa-shift-planner-v1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/* ---------------- 状態 ---------------- */
let state = load();
let step = 1;
let view = null;        // 画面幅を見て決める（'person' | 'sheet' | 'tl'）
let viewChosen = false; // 利用者が自分で選んだら、幅が変わっても勝手に切り替えない
let personId = null;
let tlDay = null;

function freshState() {
  const np = nextPeriod(new Date());   // 開始日がまだ先の、いちばん近い期間を既定に
  return {
    year: np.year,
    month: np.month,
    period: np.which,                  // 'first' 前半 1〜15日 ／ 'second' 後半 16日〜月末
    members: defaultMembers(),
    rosterRev: ROSTER_REV,
    rules: defaultSlotRules(),
    rulesRev: RULES_REV,
    options: defaultOptions(),
    months: {},
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshState();
    return mergeState(migrateRules(migrateRoster(JSON.parse(raw))));
  } catch (e) {
    console.warn('保存データを読めませんでした', e);
    return freshState();
  }
}
/** 保存データ（ブラウザ・ファイル・スプレッドシート）を、今の形に合わせて読み込む */
function mergeState(s) {
  const merged = { ...freshState(), ...s, options: { ...defaultOptions(), ...(s.options || {}) } };
  if (s.period !== 'first' && s.period !== 'second') merged.period = 'first';   // 期間ごとに組む前のデータ
  return merged;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = $('#saveState');
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      s.textContent = 'このブラウザに保存 ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      s.textContent = 'この画面では保存できません';
    }
  }, 200);
  scheduleCloudSave();
}

const monthKey = () => `${state.year}-${String(state.month).padStart(2, '0')}`;
function mdata() {
  const k = monthKey();
  if (!state.months[k]) state.months[k] = { rooms: {}, closed: [], requests: {}, streaks: {}, noRequest: {}, grid: null, done: {}, needs: {}, full: [], notes: {} };
  const m = state.months[k];
  m.rooms = m.rooms || {}; m.closed = m.closed || []; m.requests = m.requests || {};
  m.streaks = m.streaks || {}; m.noRequest = m.noRequest || {}; m.done = m.done || {}; m.needs = m.needs || {}; m.full = m.full || []; m.notes = m.notes || {};
  return m;
}
/** いま見ている期間（前半 1〜15日 ／ 後半 16日〜月末） */
const period = () => periodRange(state.year, state.month, state.period);
/** その月の全部の日 */
const monthDays = () => buildDays(state.year, state.month, mdata().rooms, mdata().closed, state.options.defaultRooms, mdata().needs, mdata().full, mdata().notes);
/** いま見ている期間の日（画面に出す日） */
const days = () => { const p = period(); return monthDays().filter((d) => d.day >= p.from && d.day <= p.to); };
const activeMembers = () => state.members.filter((m) => m.active !== false);

/** その期間のシフトが、もう組まれているか */
function periodMade(which) {
  const g = mdata().grid;
  if (!g) return false;
  const p = periodRange(state.year, state.month, which);
  return activeMembers().some((m) => g[m.id] && Object.keys(g[m.id]).some((k) => Number(k) >= p.from && Number(k) <= p.to && g[m.id][k] !== undefined));
}
const hasGrid = () => periodMade(state.period);

/**
 * 組むときの範囲。後半は、前半が組まれていれば月初から（連勤・労働時間・休日数を前半から引き継ぐ）。
 * 今回組むのは genFrom（期間の初日）から。それより前は、組んだ結果をそのまま確定として使う。
 */
const scopeDays = () => {
  const p = period();
  const from = p.which === 'second' && periodMade('first') ? 1 : p.from;
  return monthDays().filter((d) => d.day >= from && d.day <= p.to);
};
const ctx = () => ({
  days: scopeDays(), genFrom: period().from, monthDays: period().monthDays, prior: mdata().grid || {},
  members: activeMembers(), requests: mdata().requests, streaks: mdata().streaks,
  rules: state.rules, options: state.options,
});
const initials = (n) => String(n).replace(/[\s　]/g, '').slice(0, 2);
const isToday = (day) => {
  const t = new Date();
  return t.getFullYear() === state.year && t.getMonth() + 1 === state.month && t.getDate() === day.day;
};
const reqCount = (id) => Object.keys(mdata().requests[id] || {}).length;
/** 希望休の提出を求める人（自動割当の人と、役員以外の常勤）。役員や、手入力のみの人（不在の人など）は含めない */
const requestMembers = () => activeMembers().filter((m) => m.mode === 'auto' || (m.mode === 'always' && kubunOf(m) !== '役員'));
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
  if (n === 3 && !hasGrid()) { toast('先にシフトを組んでください'); return; }
  step = n;
  $('#scCollect').hidden = n !== 1;
  $('#scRun').hidden = n !== 2;
  $('#scRes').hidden = n !== 3;
  $$('#stepper .step').forEach((b) => {
    const s = Number(b.dataset.s);
    b.classList.toggle('on', s === n);
    b.classList.toggle('done', s < n || (s === 1 && n === 3) || (s < 3 && hasGrid() && s !== n));
  });
  if (n === 1) renderCollect();
  if (n === 3) renderResult();
  renderDeadline();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ================= 手順1：希望を集める ================= */
function renderCollect() {
  renderRoster();
  renderStreakWishes();
  renderSummary();
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
      else if (isWorkSymbol(sym)) c.classList.add('pin');   // 出勤の希望（早番など）
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
  const rm = requestMembers();
  const submitted = rm.filter((m) => hasSubmitted(m.id)).length;
  $('#collectSub').textContent = `${period().title} ／ ${submitted}/${rm.length}名が提出`;
}

/** 希望休カレンダー */
function openCalendar(m) {
  const d = days();
  const modal = $('#modal');
  modal.innerHTML = '';
  const mh = el('div', 'mh');
  const t = el('div');
  t.appendChild(el('h2', '', m.name));
  t.appendChild(el('div', 'sub', `${state.year}年${period().title}　クリックで 休 → 特 → ✖ → なし（記号は出勤の希望）`));
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
    const cd = el('div', 'cd' + (cur === '休' ? ' off' : cur === '特' ? ' special' : cur === '✖' ? ' ng' : isWorkSymbol(cur) ? ' pin' : ''));
    if (isWorkSymbol(cur)) cd.title = '出勤の希望（' + cur + (PATTERNS[cur] ? '　' + PATTERNS[cur].time : '') + '）';
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

/* ---------------- ログイン・クラウド保存・履歴 ---------------- */
// currentAccount … ログイン中のメールアドレス（未ログインなら null）。ページを開くたびに /api/auth/me で確認する
let currentAccount = null;

function renderAccountButton() {
  const b = $('#btnAccount');
  b.textContent = currentAccount ? currentAccount : 'ログイン';
  b.title = currentAccount
    ? `${currentAccount} でログイン中。クリックでクラウド保存・履歴・ログアウト`
    : 'ログインすると、クラウドに保存して他のパソコンと共有したり、過去に組んだシフトの履歴を見たり、元に戻したりできます';
}

async function initAccount() {
  try { const u = await account.me(); currentAccount = u ? u.email : null; }
  catch (e) { currentAccount = null; }
  renderAccountButton();
  if (currentAccount) syncOnLogin();
}

/* ---- 自動クラウド保存 ----
   入力して数秒たつと、ログイン中なら自動でクラウドの「今のデータ」を更新する。
   履歴は入力のたびには増やさず、30分に1回だけ残す（「クラウドに保存」ボタンは毎回残す）。
   別のパソコンが先に保存していたら、気づかず上書きしないよう確認を出す。 */
const CLOUD_META_KEY = 'kanaloa.cloudMeta'; // { email, savedAt（最後に同期した時刻）, histAt（最後に履歴を残した時刻） }
const CLOUD_DELAY_MS = 4000;
const CLOUD_HISTORY_EVERY_MS = 30 * 60 * 1000;
let cloudTimer = null;
let cloudBusy = false;
let cloudDirty = false;
let suppressCloud = false;

function cloudMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(CLOUD_META_KEY) || 'null');
    if (m && m.email === currentAccount) return m;
  } catch (e) { /* 読めなければ未同期として扱う */ }
  return { email: currentAccount, savedAt: null, histAt: 0 };
}
function setCloudMeta(patch) {
  try { localStorage.setItem(CLOUD_META_KEY, JSON.stringify({ ...cloudMeta(), ...patch, email: currentAccount })); } catch (e) { /* 保存できなくても動作は続ける */ }
}
function setCloudStatus(text) {
  const s = $('#cloudState');
  if (s) s.textContent = text;
}
const clockText = () => new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const cloudLabel = () => `${state.year}年${period().title}`;

function scheduleCloudSave(delay = CLOUD_DELAY_MS) {
  if (!currentAccount || suppressCloud) return;
  cloudDirty = true;
  setCloudStatus('クラウドに未保存…');
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => flushCloud(), delay);
}

/** クラウドに保存する。成功したら true */
async function flushCloud({ manual = false, force = false } = {}) {
  if (!currentAccount) return false;
  if (cloudBusy) { cloudDirty = true; return false; }
  clearTimeout(cloudTimer);
  cloudBusy = true;
  cloudDirty = false;
  let ok = false;
  let retry = false;
  const meta = cloudMeta();
  const now = Date.now();
  const wantHistory = manual || now - (meta.histAt || 0) > CLOUD_HISTORY_EVERY_MS;
  try {
    setCloudStatus('クラウドに保存中…');
    const r = await account.saveCloud(state, cloudLabel(), { history: wantHistory, baseSavedAt: meta.savedAt, force });
    setCloudMeta({ savedAt: r.savedAt, ...(wantHistory ? { histAt: now } : {}) });
    setCloudStatus('クラウドに保存 ' + clockText());
    ok = true;
  } catch (e) {
    if (e.code === 'conflict') {
      cloudBusy = false;
      await resolveConflict();
      return false;
    }
    if (e.code === 'not_logged_in') {
      currentAccount = null;
      renderAccountButton();
      setCloudStatus('ログインが切れました。クラウドには保存されていません');
    } else {
      setCloudStatus('クラウドに保存できません。あとでもう一度試します');
      retry = true;
    }
  } finally {
    cloudBusy = false;
  }
  if (retry) { cloudDirty = true; cloudTimer = setTimeout(() => flushCloud(), 30000); }
  else if (cloudDirty) scheduleCloudSave();
  return ok;
}

/** 別のパソコンで、より新しい内容が保存されているとき：どちらを残すか聞く */
async function resolveConflict() {
  const load = confirm(
    '別のパソコンで、より新しい内容がクラウドに保存されています。\n\n'
    + '［OK］クラウドの内容を読み込む（このブラウザの今の内容は、履歴に残してから置き換えます）\n'
    + '［キャンセル］このブラウザの内容でクラウドを上書きする（クラウド側の内容も、履歴に残します）',
  );
  try {
    if (load) {
      await account.saveCloud(state, '（読み込み前のこのブラウザの内容）', { historyOnly: true });
      const res = await account.loadCloud();
      if (res.state) { applyCloudState(res.state, res.savedAt); toast('クラウドの内容を読み込みました'); }
    } else {
      await flushCloud({ force: true });
    }
  } catch (e) {
    setCloudStatus('クラウドと同期できませんでした');
    toast(e.message, 5000);
  }
}

/** クラウドから読み込んだ内容を画面に反映する（その反映自体は、クラウドへ再保存しない） */
function applyCloudState(loaded, savedAt) {
  suppressCloud = true;
  try { applyLoadedState(loaded); } finally { suppressCloud = false; }
  if (savedAt) setCloudMeta({ savedAt });
  setCloudStatus('クラウドと同期済み ' + clockText());
}

/** ログイン直後・ページを開いた直後：クラウドとこのブラウザの内容をすり合わせる */
async function syncOnLogin() {
  try {
    const res = await account.loadCloud();
    const meta = cloudMeta();
    if (!res.state) { flushCloud(); return; } // クラウドが空：このブラウザの内容を最初の保存にする
    if (meta.savedAt && res.savedAt && res.savedAt <= meta.savedAt) { scheduleCloudSave(1000); return; } // すでに最新
    await resolveConflict();
  } catch (e) {
    setCloudStatus('クラウドと同期できませんでした');
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && cloudDirty) flushCloud();
});

function openAccountModal() {
  if (currentAccount) openAccountPanel(); else openLoginForm();
}

/** 未ログイン：ログイン／新規登録フォーム */
function openLoginForm(prefillEmail) {
  const modal = $('#modal');
  modal.innerHTML = '';
  let mode = 'login'; // 'login' | 'signup'

  const mh = el('div', 'mh');
  const t = el('div');
  const h2 = el('h2', '', 'ログイン');
  t.appendChild(h2);
  t.appendChild(el('div', 'sub', 'クラウドに保存すると、他のパソコンとデータを共有したり、過去のシフト案を見返したりできます。今のブラウザ保存はこれまでどおり続きます。'));
  mh.appendChild(t);
  const x = el('button', 'btn sm x', '閉じる');
  x.addEventListener('click', closeModal);
  mh.appendChild(x);
  modal.appendChild(mh);

  const body = el('div', 'pad');
  const err = el('div', 'note bad', '');
  err.hidden = true;
  err.style.marginBottom = '10px';

  const emailInp = el('input'); emailInp.type = 'email'; emailInp.placeholder = 'メールアドレス'; emailInp.autocomplete = 'username';
  emailInp.value = prefillEmail || '';
  const pwInp = el('input'); pwInp.type = 'password'; pwInp.placeholder = 'パスワード（8文字以上）'; pwInp.autocomplete = 'current-password';
  const form = el('div', 'row');
  form.style.flexDirection = 'column';
  form.style.alignItems = 'stretch';
  form.style.gap = '8px';
  [emailInp, pwInp].forEach((i) => { i.style.width = '100%'; i.style.boxSizing = 'border-box'; });
  form.appendChild(emailInp);
  form.appendChild(pwInp);

  const submitBtn = el('button', 'btn primary', 'ログイン');
  const switchLine = el('p', 'hint');
  const switchBtn = el('button', 'btn sm', '新しく登録する');
  switchLine.appendChild(document.createTextNode('アカウントが無い場合は　'));
  switchLine.appendChild(switchBtn);

  const setMode = (m) => {
    mode = m;
    h2.textContent = m === 'login' ? 'ログイン' : '新しく登録';
    submitBtn.textContent = m === 'login' ? 'ログイン' : '登録する';
    pwInp.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    switchLine.replaceChildren(
      document.createTextNode(m === 'login' ? 'アカウントが無い場合は　' : 'すでにアカウントがある場合は　'),
    );
    switchBtn.textContent = m === 'login' ? '新しく登録する' : 'ログインする';
    switchLine.appendChild(switchBtn);
  };
  switchBtn.addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));

  submitBtn.addEventListener('click', async () => {
    err.hidden = true;
    const email = emailInp.value.trim();
    const pw = pwInp.value;
    if (!email || !pw) { err.hidden = false; err.textContent = 'メールアドレスとパスワードを入れてください'; return; }
    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'login' ? 'ログイン中…' : '登録中…';
    try {
      const u = mode === 'login' ? await account.login(email, pw) : await account.signup(email, pw);
      currentAccount = u.email;
      renderAccountButton();
      closeModal();
      toast(mode === 'login' ? 'ログインしました' : '登録してログインしました');
      syncOnLogin();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'login' ? 'ログイン' : '登録する';
    }
  });
  [emailInp, pwInp].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitBtn.click(); }));

  body.appendChild(err);
  body.appendChild(form);
  const row = el('div', 'row');
  row.appendChild(submitBtn);
  body.appendChild(row);
  body.appendChild(switchLine);
  modal.appendChild(body);
  $('#mask').classList.add('show');
  setTimeout(() => emailInp.focus(), 0);
}

/** ログイン中：クラウド保存・読み込み・履歴（元に戻す） */
function openAccountPanel() {
  const modal = $('#modal');
  modal.innerHTML = '';
  const mh = el('div', 'mh');
  const t = el('div');
  t.appendChild(el('h2', '', currentAccount));
  t.appendChild(el('div', 'sub', '入力した内容は自動でクラウドに保存され、このメールアドレスでログインしたどのパソコンからでも読み書きできます'));
  mh.appendChild(t);
  const x = el('button', 'btn sm x', '閉じる');
  x.addEventListener('click', closeModal);
  mh.appendChild(x);
  modal.appendChild(mh);

  const body = el('div', 'pad');
  const row = el('div', 'row');
  const saveBtn = el('button', 'btn primary', 'クラウドに保存');
  saveBtn.title = '今このブラウザにある内容（希望休・予約客室数・名簿・組んだシフト）を、クラウドに保存します';
  const loadBtn = el('button', 'btn', 'クラウドから読み込む');
  loadBtn.title = 'クラウドに保存されている最新の内容を読み込みます（今このブラウザにある内容は上書きされます）';
  const logoutBtn = el('button', 'btn sm', 'ログアウト');
  row.appendChild(saveBtn); row.appendChild(loadBtn); row.appendChild(logoutBtn);
  body.appendChild(row);

  const status = el('p', 'hint', '');
  body.appendChild(status);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    try {
      const ok = await flushCloud({ manual: true });
      if (ok) {
        status.textContent = `保存しました（${new Date().toLocaleString('ja-JP')}）`;
        toast('クラウドに保存しました');
        renderHistoryList();
      } else {
        status.textContent = 'クラウドに保存できませんでした。画面右上の表示を確認してください';
      }
    } catch (e) {
      status.textContent = e.message;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'クラウドに保存';
    }
  });
  loadBtn.addEventListener('click', async () => {
    if (!confirm('クラウドの最新の内容を読み込みます。\n今このブラウザにある内容は上書きされます。よろしいですか？')) return;
    loadBtn.disabled = true; loadBtn.textContent = '読み込み中…';
    try {
      const res = await account.loadCloud();
      if (!res.state) { status.textContent = 'クラウドにはまだ保存されていません'; return; }
      applyCloudState(res.state, res.savedAt);
      status.textContent = '読み込みました';
      toast('クラウドの内容を読み込みました');
    } catch (e) {
      status.textContent = e.message;
    } finally {
      loadBtn.disabled = false; loadBtn.textContent = 'クラウドから読み込む';
    }
  });
  logoutBtn.addEventListener('click', async () => {
    try { await account.logout(); } catch (e) { /* ログアウトはエラーでも見た目上は抜ける */ }
    currentAccount = null;
    clearTimeout(cloudTimer);
    cloudDirty = false;
    setCloudStatus('');
    renderAccountButton();
    closeModal();
    toast('ログアウトしました');
  });

  body.appendChild(el('h3', '', '履歴（過去にAIで作ったシフト案）'));
  body.appendChild(el('p', 'hint', '入力すると数秒後に自動でクラウドへ保存され、履歴は30分に1回と「クラウドに保存」を押したときに残ります。選ぶと、その時点の内容に戻せます（今の内容も履歴に残るので、間違えても戻せます）。'));
  const list = el('div');
  list.id = 'historyList';
  body.appendChild(list);

  modal.appendChild(body);
  $('#mask').classList.add('show');
  renderHistoryList();
}

async function renderHistoryList() {
  const host = $('#historyList');
  if (!host) return;
  host.innerHTML = '読み込み中…';
  try {
    const { items } = await account.listHistory();
    host.innerHTML = '';
    if (!items.length) { host.appendChild(el('p', 'hint', 'まだありません。')); return; }
    const ul = el('ul', 'check-list');
    for (const it of items) {
      const li = el('li');
      const when = new Date(it.savedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const what = it.year && it.month ? `${it.year}年${it.month}月${it.period === 'second' ? '後半' : '前半'}` : '';
      li.appendChild(el('span', 'check-who', when));
      li.appendChild(el('span', 'check-why', [what, it.label].filter(Boolean).join(' ／ ')));
      const b = el('button', 'btn sm', 'この内容に戻す');
      b.addEventListener('click', async () => {
        if (!confirm(`${when} の内容に戻します。今の内容は履歴に残ります。よろしいですか？`)) return;
        b.disabled = true; b.textContent = '戻しています…';
        try {
          const res = await account.restoreHistory(it.id);
          applyCloudState(res.state, res.savedAt);
          toast('その時点の内容に戻しました');
          closeModal();
        } catch (e) {
          toast(e.message, 5000);
        } finally {
          b.disabled = false; b.textContent = 'この内容に戻す';
        }
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('p', 'hint', e.message));
  }
}

/** クラウド／履歴から読み込んだ保存データを、今の画面に反映する（ファイルから戻す、と同じ流れ） */
function applyLoadedState(loaded) {
  if (!loaded || !Array.isArray(loaded.members) || typeof loaded.months !== 'object') {
    toast('データの形が正しくありません', 5000);
    return;
  }
  const fixed = migrateRules(migrateRoster(loaded));
  state = mergeState(fixed);
  save();
  syncMonthInputs();
  tlDay = null;
  goStep(hasGrid() ? 3 : 1);
}

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
  const members = requestMembers();
  const submitted = members.filter((m) => hasSubmitted(m.id)).length;
  const need = d.reduce((a, day) => a + (day.closed ? 0 : expandSlots(state.rules, day.rooms, day.dow, day.need, day.hol).length), 0);
  const wish = members.reduce((a, m) => a + reqCount(m.id), 0);
  const streak = Object.values(mdata().streaks).filter((n) => n >= 2).length;

  $('#sSubmit').textContent = `${submitted}/${members.length}名`;
  $('#sNeed').textContent = `${need}枠`;
  $('#sWish').textContent = `${wish}日`;
  $('#sStreak').textContent = `${streak}件`;
  $('#stepSub1').textContent = `${state.year}年${period().title} ／ ${submitted}/${members.length}名`;
}


function renderLaunch() {
  const members = requestMembers();
  const submitted = members.filter((m) => hasSubmitted(m.id)).length;
  const made = hasGrid();
  const p = period();
  $('#launchTitle').textContent = made
    ? `${state.year}年${p.title}のシフト案はできています`
    : `${state.year}年${p.title}のシフトを組みます`;
  const notes = [];
  if (submitted < members.length) notes.push(`未提出が${members.length - submitted}名います。このまま組むこともできます（希望なしとして扱います）。`);
  else notes.push('全員の希望休がそろっています。');
  if (p.which === 'second' && !periodMade('first')) notes.push('前半がまだ組まれていません。前半を先に組むと、連勤や労働時間が引き継がれます。');
  if (p.which === 'first' && periodMade('second')) notes.push('後半は前半の結果を引き継いで組んでいます。前半を組み直したら、後半も組み直してください。');
  $('#launchNote').textContent = notes.join(' ');
  $('#btnRun').textContent = made ? '組み直す' : `${p.name}のシフトを組む`;
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
  const res = importMessages(text, { members: activeMembers(), month: state.month, daysInMonth: period().monthDays });
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
    const what = p.wish ? `${p.wish} ${p.sym}${PATTERNS[p.sym] ? '　' + PATTERNS[p.sym].time : ''}` : p.sym;
    ul.appendChild(el('li', '', `${p.member.name}：${parts.join(' ＋ ')}（${what}）`));
  }
  host.appendChild(ul);
  if (res.notes && res.notes.length) {
    host.appendChild(el('h3', '', `連絡事項 ${res.notes.length}件`));
    const nl = el('ul', 'check-list');
    for (const n of res.notes) {
      const li = el('li');
      li.appendChild(el('span', 'check-who', n.member.name));
      li.appendChild(el('span', 'check-why', '日にちとしては取り込んでいません'));
      li.appendChild(el('span', 'check-text', n.text));
      nl.appendChild(li);
    }
    host.appendChild(nl);
  }
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
  const res = importFormCsv(text, {
    members: activeMembers(), month: state.month, daysInMonth: period().monthDays,
    nameCol: nameSel && nameSel.value !== '' ? Number(nameSel.value) : -1,
    dayCols: daySel ? [...daySel.selectedOptions].map((o) => Number(o.value)) : [],
  });
  if ($('#csvReplace').checked) { mdata().requests = {}; mdata().streaks = {}; }
  const r = mdata().requests;
  for (const [mid, obj] of Object.entries(res.requests)) r[mid] = { ...(r[mid] || {}), ...obj };
  Object.assign(mdata().streaks, res.streaks || {});
  save();
  const host = $('#csvResult');
  host.innerHTML = '';
  host.appendChild(el('h3', '', `取り込み ${res.preview.length}件`));
  const ul = el('ul', 'ok-list');
  for (const p of res.preview) {
    const parts = [];
    if (p.days.length > 4) parts.push(`${p.days[0]}日〜${p.days[p.days.length - 1]}日の ${p.days.length}日間`);
    else if (p.days.length) parts.push(p.days.map((x) => x + '日').join('・'));
    if (p.special && p.special.length) parts.push(`うち有給 ${p.special.map((x) => x + '日').join('・')}`);
    if (p.streak) parts.push(`${p.streak}連休の希望`);
    ul.appendChild(el('li', '', `${p.name}：${parts.join(' ／ ') || '指定なし'}（${p.sym}）`));
  }
  host.appendChild(ul);
  if (res.unmatched.length) {
    renderCheckList(host, res.unmatched.map((u) => ({ who: `「${u.name}」`, why: '名簿に一致するスタッフがいません', text: '', days: u.days, sym: u.sym })));
  }
  if (res.notes && res.notes.length) {
    host.appendChild(el('h3', '', `連絡事項 ${res.notes.length}件`));
    const nl = el('ul', 'check-list');
    for (const n of res.notes) {
      const li = el('li');
      li.appendChild(el('span', 'check-who', n.member.name));
      li.appendChild(el('span', 'check-why', n.ranges.length ? n.ranges.map((x) => x.why).join('／') + ' として取り込みました' : '内容を確認してください'));
      li.appendChild(el('span', 'check-text', n.text));
      if (n.ranges.length) li.classList.add('resolved');
      nl.appendChild(li);
    }
    host.appendChild(nl);
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
    head.appendChild(el('span', 'dw', ' ' + DOW_LABELS[day.dow] + (day.hol ? '・祝' : '')));
    cell.appendChild(head);
    if (day.note) { const nt = el('div', 'room-note', day.note); nt.title = day.note; cell.appendChild(nt); }
    const inp = el('input');
    inp.type = 'number'; inp.min = '0'; inp.max = String(state.options.totalRooms || 28);
    inp.value = mdata().rooms[day.day] === undefined ? '' : mdata().rooms[day.day];
    inp.placeholder = String(state.options.defaultRooms);
    inp.addEventListener('change', () => {
      if (inp.value === '') delete mdata().rooms[day.day];
      else mdata().rooms[day.day] = Number(inp.value);
      save();
      updateRoomNeed(cell, inp.value === '' ? state.options.defaultRooms : Number(inp.value), day.dow, mdata().needs[day.day], day.hol);
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
    cl.appendChild(el('span', 'room-lab', '休館'));
    cell.appendChild(cl);

    // この日だけ、清掃の合計人数を指定する（昼に清掃をする人：B・H・Dのアスナさんなど。空欄なら客室数から自動）
    if (cleaningRule()) {
      const nl = el('label', 'inline');
      nl.appendChild(el('span', 'room-lab', '清掃'));
      const ni = el('input');
      ni.type = 'number'; ni.min = '0'; ni.max = '8'; ni.className = 'num-input';
      ni.style.width = '46px';
      const cur = (mdata().needs[day.day] || {}).clean;
      ni.value = cur === undefined ? '' : cur;
      ni.placeholder = String(cleanerCount(state.rules, day.rooms, day.dow, null, day.hol));
      ni.title = 'この日だけ、昼に清掃をする人の合計を指定します（B・H・Dのアスナさんなど。空欄なら客室数から自動）';
      ni.addEventListener('change', () => {
        const nd = mdata().needs;
        if (ni.value === '') { if (nd[day.day]) { delete nd[day.day].clean; if (!Object.keys(nd[day.day]).length) delete nd[day.day]; } }
        else { nd[day.day] = { ...(nd[day.day] || {}), clean: Number(ni.value) }; }
        save(); renderRoomsGrid(); renderSummary();
      });
      nl.appendChild(ni);
      nl.appendChild(el('span', 'room-lab', '名'));
      cell.appendChild(nl);
    }
    // 超多忙の日：全員出勤にする
    const fl = el('label', 'inline');
    const fb = el('input'); fb.type = 'checkbox'; fb.checked = mdata().full.includes(day.day);
    fb.addEventListener('change', () => {
      const f = mdata().full;
      if (fb.checked) { if (!f.includes(day.day)) f.push(day.day); }
      else mdata().full = f.filter((x) => x !== day.day);
      save(); renderRoomsGrid(); renderSummary();
    });
    fl.appendChild(fb);
    fl.appendChild(el('span', 'room-lab', '全員出勤'));
    cell.appendChild(fl);
    if (fb.checked) cell.classList.add('full');
    const need = el('div', 'room-need');
    cell.appendChild(need);
    updateRoomNeed(cell, day.rooms, day.dow, day.need, day.hol);
    host.appendChild(cell);
  }
}
/** 「朝食・清掃」の枠（この日だけの人数指定の対象） */
/** 清掃を増やす枠（この日だけ清掃の人数を指定するときに足す先） */
const cleaningRule = () => state.rules.find((r) => r.enabled !== false && r.cleanFill);

function updateRoomNeed(cell, rooms, dow, need, hol) {
  const n = cell.querySelector('div.room-need');
  if (n) n.textContent = '必要 ' + expandSlots(state.rules, rooms, dow, need, hol).length + '名';
}

/* ---------------- 詳細設定 ---------------- */
function renderStaff() {
  const host = $('#staffTable');
  host.innerHTML = '';
  const table = el('table', 'form-table');
  const head = el('tr');
  ['', '区分', '名前', '呼び名', '担当', '対応パターン', '割当', '目安', '連勤', '記号なしの勤務', '固定休', 'メモ'].forEach((h) => head.appendChild(el('th', '', h)));
  table.appendChild(head);
  for (const m of state.members) {
    const tr = el('tr');
    const act = el('td');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = m.active !== false;
    cb.addEventListener('change', () => { m.active = cb.checked; save(); renderCollect(); });
    act.appendChild(cb);
    tr.appendChild(act);
    const kb = el('td');
    const ks = el('select');
    for (const k of KUBUN_LIST) {
      const o = el('option', '', k); o.value = k === '社員' ? '' : k;
      if (kubunOf(m) === k) o.selected = true;
      ks.appendChild(o);
    }
    ks.addEventListener('change', () => { m.kubun = ks.value; save(); renderRoster(); });
    kb.appendChild(ks);
    tr.appendChild(kb);
    tr.appendChild(textCell(m, 'name', 'text', '名前'));
    tr.appendChild(nicknamesCell(m));

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
    tr.appendChild(numCell(m, 'maxConsecutive', 1, 6));
    tr.appendChild(alwaysCell(m));

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
/** 記号なしで出勤する人の「何時から・何時間」。パターンの人はパターンの時間で数えるので入力しない */
function alwaysCell(m) {
  const td = el('td', 'always-cell');
  if (m.mode !== 'always') {
    td.appendChild(el('span', 'hint', '—'));
    td.title = '常勤（記号なし）の人だけ使います。パターンの人はパターンの実働時間で数えます';
    return td;
  }
  const num = (key, min, max, fallback) => {
    const i = el('input'); i.type = 'number'; i.className = 'num-input';
    i.min = min; i.max = max; i.value = m[key] ?? fallback;
    i.addEventListener('change', () => { m[key] = Number(i.value); save(); renderStaff(); });
    return i;
  };
  td.append(num('workFrom', DAY_START, DAY_END - 1, 9), el('span', '', '時から'), num('dailyHours', 1, 12, 8), el('span', '', '時間'));
  td.appendChild(el('div', 'room-need', alwaysWindow(m).label));
  td.title = '記号なしで出勤する日の時間。労働時間の上限チェックと、1日の人の動きの表示に使います';
  return td;
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
/** 呼び名（「スー」「ケー」など）。カンマ・読点区切りで複数入れられる。LINE・メッセージの取り込みで、この名前でも照合する */
function nicknamesCell(m) {
  const td = el('td');
  const i = el('input'); i.type = 'text'; i.placeholder = '例：スー、ケー';
  i.value = (m.nicknames || []).join('、');
  i.title = '取り込みの名前照合に使う呼び名（カンマ・読点区切りで複数）';
  i.addEventListener('change', () => {
    m.nicknames = i.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    save();
  });
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

    // 焼き鳥屋のような枠の詳細：休業の曜日／この人が休みなら休業／入れる人
    const sub = el('tr', 'rule-sub');
    const std = el('td');
    std.colSpan = 8;
    const row1 = el('div', 'rs-row');
    row1.appendChild(el('b', '', '休業する曜日'));
    DOW_LABELS.forEach((w, i) => {
      const c = el('button', 'chip' + ((r.closedDows || []).includes(i) ? ' on' : ''), w);
      c.addEventListener('click', () => {
        const cur = r.closedDows || [];
        r.closedDows = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort();
        save(); renderRuleTable(); renderCollect();
      });
      row1.appendChild(c);
    });
    std.appendChild(row1);

    const row2 = el('div', 'rs-row');
    row2.appendChild(el('b', '', '中心の人'));
    const ls = el('select');
    const none = el('option', '', '（決めない）'); none.value = '';
    ls.appendChild(none);
    const names = state.members.map((m) => m.name);
    for (const n of new Set([...(r.leadName ? [r.leadName] : []), ...names])) {
      const o = el('option', '', n); o.value = n;
      if (n === r.leadName) o.selected = true;
      ls.appendChild(o);
    }
    ls.addEventListener('change', () => { r.leadName = ls.value; if (!ls.value) delete r.leadName; save(); renderRuleTable(); });
    row2.appendChild(ls);
    row2.appendChild(el('span', '', r.leadName ? `${r.leadName}が入る日だけ営業（休みの日は休業）` : ''));
    std.appendChild(row2);

    const row3 = el('div', 'rs-row');
    row3.appendChild(el('b', '', '入れる人（優先順）'));
    const pool = r.poolNames || [];
    for (const n of names) {
      if (n === r.leadName) continue;
      const idx = pool.indexOf(n);
      const c = el('button', 'chip' + (idx >= 0 ? ' on' : ''), idx >= 0 ? `${idx + 1} ${n}` : n);
      c.addEventListener('click', () => {
        r.poolNames = idx >= 0 ? pool.filter((x) => x !== n) : [...pool, n];
        if (!r.poolNames.length) delete r.poolNames;
        save(); renderRuleTable();
      });
      row3.appendChild(c);
    }
    row3.appendChild(el('span', '', pool.length ? '押した順が優先順。2番目以降は同じ順位の控え' : '指定なし（担当が合う人なら誰でも）'));
    std.appendChild(row3);

    const row4 = el('div', 'rs-row');
    row4.appendChild(el('b', '', '休日（土・日・祝）の人数'));
    const hi = el('input'); hi.type = 'number'; hi.min = '0'; hi.max = '10'; hi.className = 'num-input';
    hi.value = r.holidayCount === undefined || r.holidayCount === null ? '' : r.holidayCount;
    hi.placeholder = '同じ';
    hi.addEventListener('change', () => {
      if (hi.value === '') delete r.holidayCount; else r.holidayCount = Number(hi.value);
      save(); renderRoomsGrid(); renderSummary();
    });
    row4.appendChild(hi);
    row4.appendChild(el('span', '', '空欄なら平日と同じ（客室数から自動）'));
    std.appendChild(row4);

    const row5 = el('div', 'rs-row');
    row5.appendChild(el('b', '', '清掃'));
    const cc = el('input'); cc.type = 'checkbox'; cc.checked = !!r.cleaner;
    cc.addEventListener('change', () => { r.cleaner = cc.checked; save(); renderRoomsGrid(); });
    const cl1 = el('label', 'inline'); cl1.appendChild(cc); cl1.appendChild(el('span', '', 'この枠の人は昼に清掃をする（清掃の人数に数える）'));
    row5.appendChild(cl1);
    const cf = el('input'); cf.type = 'checkbox'; cf.checked = !!r.cleanFill;
    cf.addEventListener('change', () => {
      if (cf.checked) for (const x of state.rules) delete x.cleanFill;   // 清掃を増やす枠は1つだけ
      if (cf.checked) r.cleanFill = true; else delete r.cleanFill;
      save(); renderRuleTable(); renderRoomsGrid();
    });
    const cl2 = el('label', 'inline'); cl2.appendChild(cf); cl2.appendChild(el('span', '', '清掃を増やす日は、この枠を増やす'));
    row5.appendChild(cl2);
    std.appendChild(row5);
    sub.appendChild(std);
    t.appendChild(sub);
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
  [0, 4, 8, 12, 16, 20, 24, 28].forEach((n) => rr.appendChild(el('td', '', expandSlots(state.rules, n, 1).length + '名')));
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

function bindLabor() {
  state.options.labor = laborOf(state.options);
  const lab = state.options.labor;
  const changed = () => { save(); renderLaborHint(); renderCollect(); };

  $$('#laborMode button').forEach((b) => b.addEventListener('click', () => {
    lab.mode = b.dataset.mode;
    changed();
  }));
  const wk = $('#laborWeekly');
  wk.value = lab.weeklyLimit;
  wk.addEventListener('change', () => { lab.weeklyLimit = Math.max(1, Number(wk.value) || 40); changed(); });

  const ws = $('#laborWeekStart');
  DOW_LABELS.forEach((w, i) => {
    const o = el('option', '', w + '曜日'); o.value = i;
    if (Number(lab.weekStart) === i) o.selected = true;
    ws.appendChild(o);
  });
  ws.addEventListener('change', () => { lab.weekStart = Number(ws.value); changed(); });

  for (const [id, kb] of [['#laborOffShain', '社員'], ['#laborOffPA', 'PA']]) {
    const e = $(id);
    e.value = lab.offDaysByKubun[kb];
    e.addEventListener('change', () => { lab.offDaysByKubun[kb] = Math.max(0, Number(e.value) || 0); changed(); });
  }
  renderLaborHint();
}

function renderLaborHint() {
  const lab = laborOf(state.options);
  $$('#laborMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === lab.mode));
  $('#laborWeekStartRow').hidden = lab.mode === 'monthly';
  const n = period().monthDays;
  $('#laborModeHint').textContent = lab.mode === 'monthly'
    ? `月の合計で判定します。${state.month}月（${n}日）の上限は ${lab.weeklyLimit}時間×${n}日÷7＝${monthlyHourCap(lab, n).toFixed(1)}時間。週${lab.weeklyLimit}時間を超える週があっても構いません。就業規則か労使協定でこの制度を定めている場合に選んでください（ホテルでは一般的です）。`
    : `暦週ごとに${lab.weeklyLimit}時間までで判定します。変形労働時間制を定めていない場合はこちらです。月の合計で判定するより厳しいため、人が足りない枠が出やすくなります。`;
}

function bindOptions() {
  const map = [
    ['#optMaxConsecutive', 'maxConsecutive'],
    ['#optIterations', 'iterations'], ['#defaultRooms', 'defaultRooms'], ['#totalRooms', 'totalRooms'],
  ];
  for (const [sel, key] of map) {
    const e = $(sel);
    e.value = state.options[key];
    e.addEventListener('change', () => { state.options[key] = Number(e.value); save(); renderCollect(); });
  }
  const kp = $('#optKeepPattern');
  kp.checked = !!state.options.keepPattern;
  kp.addEventListener('change', () => { state.options.keepPattern = kp.checked; save(); });
  // 7連勤は法定休日に反するので、上限は6日
  const mc = $('#optMaxConsecutive');
  mc.addEventListener('change', () => {
    if (Number(mc.value) > 6) { mc.value = 6; state.options.maxConsecutive = 6; save(); toast('7連勤は法定休日に反するため、6日にしました'); }
  });
  bindLabor();
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
  $('#runSub').textContent = `${period().title}の${days().length}日 × ${c.members.length}名の割り当てを、条件を変えながら試します`;
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
  // 今回の期間の分だけを書き込む（もう一方の期間の結果は触らない）
  const g = mdata().grid || {};
  for (const m of activeMembers()) {
    g[m.id] = g[m.id] || {};
    for (const d of days()) g[m.id][d.day] = best.grid[m.id][d.day];
  }
  mdata().grid = g;
  delete mdata().done[state.period];        // 組み直したので、確定は取り消し
  if (state.period === 'first' && periodMade('second')) {
    delete mdata().done.second;
    toast('前半を組み直したので、後半も組み直してください（前半の結果を引き継いでいるため）', 6000);
  }
  save();
  $('#runTitle').textContent = '組み終わりました';
  $('#runSub').textContent = `${runner.done}回ためして、一番良い配置を選びました（${Math.round(ms)}ms）`;
  setTimeout(() => { if (step === 2) goStep(3); }, 450);
}

function renderRunChecks() {
  const o = state.options;
  const host = $('#runChecks');
  host.innerHTML = '';
  const lab = laborOf(o);
  const list = [
    '希望休を守る',
    lab.mode === 'monthly'
      ? (scopeDays().length < period().monthDays ? `月の上限を日割りで${monthlyHourCap(lab, scopeDays().length).toFixed(1)}時間まで` : `月${monthlyHourCap(lab, scopeDays().length).toFixed(1)}時間まで`)
      : `週${lab.weeklyLimit}時間まで`,
    '法定休日（毎週1日）', `社員は月の休み${lab.offDaysByKubun.社員}日以上`, `連勤${Math.min(o.maxConsecutive, 6)}日まで`,
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
  if (!grid || !hasGrid()) return;
  const c = ctx();
  const v = validate(c, grid);
  $('#resTitle').textContent = `${state.year}年${period().title}のシフト案`;
  renderKpis(v);
  renderLegend();
  renderSheet(v);
  renderNotes(v, grid);
  renderPersum(v);
  renderDaystrip(v);
  renderTimeline();
  renderPersonView(v);
  showView();
  $('#stepSub3').textContent = `不足${v.issues.filter((i) => i.type === 'shortage' && !i.optional).length}枠`;
  renderShareStatus();
  renderNotify(v);
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
  host.appendChild(card('この期間の総工数', hours + 'h', '全員の実働の合計'));
  host.appendChild(card('のべ出勤', v.memberStats.reduce((a, s) => a + s.pWork, 0) + '日', '全員の出勤日の合計'));
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
    th.appendChild(el('div', 'dow', DOW_LABELS[day.dow] + (day.hol ? '祝' : '')));
    th.appendChild(el('div', 'rooms', day.closed ? '休館' : day.full ? '全員' : day.rooms + '室'));
    th.title = `${state.month}月${day.day}日(${DOW_LABELS[day.dow]}${day.hol ? '・祝日' : ''})　${day.closed ? '休館日' : '予約 ' + day.rooms + '室'}${day.full ? '　全員出勤の日' : ''}${day.note ? '　' + day.note : ''}`;
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
    tr.appendChild(el('td', 'stick c4', m.mode === 'manual' ? '—' : String(st ? st.pWork : 0)));

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
  touchedGrid();
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
      touchedGrid();
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
    ['fullDay', 'bad', '全員出勤の日に休みの人', () => true],
    ['cleanLack', 'warn', '清掃の人数が指定より少ない日', () => true],
    ['closure', 'warn', '焼き鳥屋が休業になる日（日下さんが休み）', () => true],
    ['streak', 'warn', '連勤が上限を超えている', () => true],
    ['streakWish', 'warn', '連休の希望が入っていない', () => true],
    ['hours', 'bad', '月の労働時間が上限を超えている', () => true],
    ['weekHours', 'bad', '週の労働時間が上限を超えている', () => true],
    ['legalHoliday', 'bad', '法定休日（毎週1日）がない', () => true],
    ['off', 'bad', '月の休日数が足りない', () => true],
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
        const cands = candidatesFor({ ...ctx() }, grid, i.day, i.pattern, i.roles, i.only);
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
            touchedGrid();
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
    // 目安の出勤日数は月の数字なので、この期間の日数で日割りにする
    const target = Math.round((m.targetDays || period().monthDays) * d.length / period().monthDays);
    i.style.width = Math.min(100, (st.pWork / Math.max(1, target)) * 100) + '%';
    if (st.pWork > target + 2) i.classList.add('over');
    bar.appendChild(i);
    row.appendChild(bar);
    row.appendChild(el('div', 'nums', m.mode === 'manual' ? '手入力' : `出${st.pWork} 休${st.pOff} 連${st.maxStreak}`));
    const lab = laborOf(state.options);
    const exempt = lab.exemptKubun.includes(kubunOf(m));
    const cap = monthlyHourCap(lab, scopeDays().length);
    const hrs = el('div', 'hrs', exempt ? `${st.hours}h（対象外）` : `${st.hours}h／${Math.round(cap)}h`);
    if (!exempt && st.hours > cap + 1e-9) hrs.classList.add('over');
    hrs.title = exempt ? '役員は労働時間の上限の対象外です' : `${scopeDays().length < period().monthDays ? 'ここまでの' : '月の'}労働時間 ${st.hours}時間（${lab.mode === 'monthly' ? '上限' : '参考：月換算の上限'} ${cap.toFixed(1)}時間）`;
    row.appendChild(hrs);
    host.appendChild(row);
  }
}

/* ---- 個人別（スマホでも読める縦並び） ---- */
/** 画面が狭いときは「個人別」を既定にする（スマホで表を横に送らなくて済む） */
const preferredView = () => (window.matchMedia('(max-width: 720px)').matches ? 'person' : 'sheet');

/** 画面の幅が変わったら、利用者が自分で選ぶまでは見やすい方に合わせる */
function autoView() {
  if (viewChosen) return;
  const want = preferredView();
  if (want === view) return;
  view = want;
  showView();
}
window.addEventListener('resize', autoView);

function showView() {
  if (!view) view = preferredView();
  $('#sheetView').hidden = view !== 'sheet';
  $('#tlView').hidden = view !== 'tl';
  $('#personView').hidden = view !== 'person';
  $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
}

function renderPersonView(v) {
  const members = activeMembers();
  if (!members.length) return;
  // 既定は、実際にシフトが入る人（手入力のみの役員などは飛ばす）
  if (!members.some((m) => m.id === personId)) personId = (members.find((m) => m.mode !== 'manual') || members[0]).id;

  const chips = $('#personChips');
  chips.innerHTML = '';
  for (const m of members) {
    const b = el('button', 'pchip' + (m.id === personId ? ' on' : ''), m.name);
    b.addEventListener('click', () => { personId = m.id; renderPersonView(v); });
    chips.appendChild(b);
  }

  const m = members.find((x) => x.id === personId);
  const st = v.memberStats.find((s) => s.id === m.id) || { pWork: 0, pOff: 0, hours: 0, maxStreak: 0 };
  const lab = laborOf(state.options);
  const d = days();
  const cap = monthlyHourCap(lab, scopeDays().length);
  const exempt = lab.exemptKubun.includes(kubunOf(m));

  $('#pTitle').textContent = m.name;
  $('#pSub').textContent = `${state.year}年${period().title}　${(m.roles || []).join('・')}`;

  const host = $('#personList');
  host.innerHTML = '';
  const stat = el('div', 'pstat');
  const add = (label, val, over) => {
    const x = el('div', over ? 'over' : '');
    x.appendChild(el('span', '', label));
    x.appendChild(el('b', '', val));
    stat.appendChild(x);
  };
  add('出勤', `${st.pWork}日`);
  add('休み', `${st.pOff}日`);
  if (!exempt) add(scopeDays().length < period().monthDays ? '労働時間（月のここまで）' : '労働時間', `${st.hours}h`, st.hours > cap + 1e-9);
  add('最大連勤', `${st.maxStreak}日`);
  host.appendChild(stat);

  const grid = mdata().grid || {};
  for (const day of d) {
    const raw = grid[m.id] ? grid[m.id][day.day] : '';
    const val = raw === null || raw === undefined ? '' : raw;
    const work = isWorkSymbol(val) || (m.mode === 'always' && val === '');
    const row = el('div', 'pday'
      + (day.dow === 0 ? ' sun' : day.dow === 6 ? ' sat' : '')
      + (val === '特' ? ' special' : val === '✖' ? ' ng' : !work ? ' off' : '')
      + (isToday(day) ? ' today' : ''));

    const dd = el('div', 'd', String(day.day));
    dd.appendChild(el('small', '', DOW_LABELS[day.dow]));
    row.appendChild(dd);

    const sym = el('div', 'sym', PATTERNS[val] ? val : val || (work ? '出' : '休'));
    if (PATTERNS[val]) sym.classList.add('p-' + val);
    row.appendChild(sym);

    const tm = el('div', 'tm');
    if (PATTERNS[val]) {
      tm.appendChild(el('span', '', PATTERNS[val].time));
      const ld = lunchDuty(m, val);
      tm.appendChild(el('small', '', `実働${PATTERNS[val].hours}時間${ld ? `　${ld.time}は${ld.duty}` : ''}`));
    } else if (OFF_SYMBOLS[val]) {
      tm.appendChild(el('span', '', OFF_SYMBOLS[val].label));
    } else if (work) {
      tm.appendChild(el('span', '', '出勤（記号なし）'));
    } else {
      tm.appendChild(el('span', '', day.closed ? '休館日' : '休み'));
    }
    row.appendChild(tm);

    const rq = (mdata().requests[m.id] || {})[day.day];
    if (rq) row.appendChild(el('div', 'req', isWorkSymbol(rq) ? '出勤の希望' : '希望休'));
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
function alwaysCovers(m, h) {
  if (m.mode !== 'always') return false;
  const w = alwaysWindow(m);
  return w.from <= h && h < w.to;
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
  // その日に必要な枠（時間帯ごとの必要人数を出すため）。焼き鳥屋は、日下さんが入っている日だけ
  const slots = makeSlotter(state.rules, activeMembers())(day, grid);
  $('#tlSub').textContent = day.closed ? '休館日' : `予約 ${day.rooms}室 ／ 必要 ${slots.length}名`;
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
    who.appendChild(el('div', 'p', PATTERNS[val] ? `${val} ${PATTERNS[val].time}`
      : (m.mode === 'always' ? `記号なし ${alwaysWindow(m).label}` : val)));
    tr.appendChild(who);
    const role = (m.roles || [])[0] || '全般';
    for (const h of hours) {
      const td = el('td', 'h');
      const on = PATTERNS[val] ? coversHour(val, h) : alwaysCovers(m, h);
      if (on) td.classList.add('on', 'k' + role);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const cnt = el('tr', 'count');
  const cw = el('td', 'who', '館内の人数（必要）');
  cnt.appendChild(cw);
  hours.forEach((h, idx) => {
    const n = working.filter(({ m, val }) => (PATTERNS[val] ? coversHour(val, h) : alwaysCovers(m, h))).length;
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
  if (!grid || !hasGrid()) { toast('先にシフトを組んでください'); return; }
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
  if (!grid || !hasGrid()) { toast('先にシフトを組んでください'); return; }
  const tsv = toTSV(activeMembers(), days(), grid, { header: true });
  const csv = tsv.split('\n').map((line) => line.split('\t').map((c) => (/[",]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');
  const body = '﻿' + csv;
  const filename = `シフト案_${state.year}年${period().title.replace(/（.*）/, '')}.csv`;
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

/* ---------------- 共有：スプレッドシート ---------------- */
function renderShareStatus() {
  const st = $('#sheetStatus');
  const link = $('#sheetLink');
  const pub = mdata().published;
  $('#btnLoadSheet').hidden = !isSyncReady();
  if (!isSyncReady()) {
    st.className = 'share-d';
    st.textContent = 'まだ連携先が設定されていません。「条件を変える → 詳細設定 → スプレッドシート連携」で、最初に1回だけ設定してください。';
    $('#btnPublish').textContent = '連携を設定する';
    link.hidden = true;
    return;
  }
  $('#btnPublish').textContent = pub ? 'もう一度反映する' : 'スプレッドシートに反映';
  if (pub) {
    st.className = 'share-d ok';
    st.textContent = `「${pub.sheetName}」シートに反映済み（${pub.updatedAt}）。手直ししたら、もう一度反映してください。`;
    link.href = pub.url;
    link.hidden = false;
  } else {
    st.className = 'share-d';
    st.textContent = 'フロントのパソコンで開いているスプレッドシートに、最新のシフトを書き込みます。';
    link.hidden = true;
  }
}

async function publishToSheet() {
  if (!isSyncReady()) {
    goStep(1);
    if ($('#advBody').hidden) $('#btnToggleAdv').click();
    $('#syncSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const grid = mdata().grid;
  if (!grid || !hasGrid()) { toast('先にシフトを組んでください'); return; }
  const btn = $('#btnPublish');
  btn.disabled = true;
  btn.textContent = '書き込み中…';
  try {
    // 月のシートには、組んである期間（前半・後半）をまとめて書く。まだ組んでいない期間は空欄のまま
    const saved = state.period;
    let short = 0;
    const dayStats = [];
    for (const which of ['first', 'second']) {
      if (!periodMade(which)) continue;
      state.period = which;
      const v = validate(ctx(), grid);
      short += v.issues.filter((i) => i.type === 'shortage' && !i.optional).length;
      dayStats.push(...v.dayStats);
    }
    state.period = saved;
    const table = buildSheetTable({ days: monthDays(), members: activeMembers(), grid, dayStats });
    const res = await callSheet('publish', {
      sheetName: `${state.year}年${state.month}月`,
      title: `${state.year}年${state.month}月 シフト表（ホテルかなろあ）`,
      note: [short ? `※人が足りない枠が${short}件あります` : '', !periodMade('first') || !periodMade('second') ? '※まだ組んでいない期間は空欄です' : ''].filter(Boolean).join(' '),
      table,
      state: stateForSheet(state),
    });
    mdata().published = { sheetName: res.sheetName, url: res.url, updatedAt: res.updatedAt };
    save();
    toast(`スプレッドシートの「${res.sheetName}」に反映しました`);
  } catch (e) {
    toast(e.message, 6000);
    $('#sheetStatus').className = 'share-d bad';
    $('#sheetStatus').textContent = e.message;
  } finally {
    btn.disabled = false;
    if ($('#sheetStatus').className !== 'share-d bad') renderShareStatus();
    else $('#btnPublish').textContent = 'もう一度試す';
  }
}

async function loadFromSheet() {
  if (!confirm('スプレッドシートに反映された最新のデータを読み込みます。\nこのパソコンで反映していない変更は、上書きされて消えます。よろしいですか？')) return;
  const btn = $('#btnLoadSheet');
  btn.disabled = true;
  btn.textContent = '読み込み中…';
  try {
    const res = await callSheet('load');
    const loaded = JSON.parse(res.state);
    if (!loaded || !Array.isArray(loaded.members) || typeof loaded.months !== 'object') throw new Error('読み込んだデータの形が正しくありません');
    delete loaded._savedAt; delete loaded._version;
    const fixed = migrateRules(migrateRoster(loaded));
    state = mergeState(fixed);
    save();
    syncMonthInputs();
    tlDay = null;
    goStep(hasGrid() ? 3 : 1);
    toast(`最新のデータを読み込みました（${res.updatedAt} 反映分）`);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '最新を読み込む';
  }
}

/** いまの連携設定を、リンク1本にしてコピーする */
function copySetupLink() {
  const cfg = loadSync();
  if (!isValidSheetUrl(cfg.url) || !cfg.key) { toast('先にURLと合言葉を入れて、接続テストをしてください'); return; }
  const link = location.origin + location.pathname + '#setup=' + encodeSetup(cfg);
  navigator.clipboard.writeText(link).then(
    () => toast('設定リンクをコピーしました。合言葉が入っているので社内だけに送ってください', 6000),
    () => {
      const ta = el('textarea');
      ta.value = link;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      toast('設定リンクをコピーしました', 6000);
    },
  );
}

/** 「#setup=…」付きのリンクで開かれたら、連携の設定を入れて、つながるか試す */
async function applySetupLink() {
  const m = /^#setup=(.+)$/.exec(location.hash || '');
  if (!m) return;
  history.replaceState(null, '', location.pathname);   // 合言葉をアドレス欄に残さない
  const cfg = decodeSetup(m[1]);
  if (!cfg) { toast('設定リンクが正しくありません', 6000); return; }
  // 知らない人から送られたリンクで、名簿などの送り先が書き換わらないように、切り替える前に確認する
  if (!confirm(`設定リンクを開きました。スプレッドシートの連携先を、次のURLに切り替えます。\n\n${cfg.url}\n\n心当たりのあるリンクですか？（違うときは「キャンセル」）`)) { toast('連携先は変えませんでした', 4000); return; }
  saveSync(cfg);
  bindSync();
  try {
    const res = await callSheet('ping');
    $('#btnLoadSheet').hidden = false;
    renderShareStatus();
    toast(`つながりました：「${res.name}」`, 6000);
    await loadFromSheet();
  } catch (e) {
    toast(e.message, 8000);
  }
}

function bindSync() {
  const cfg = loadSync();
  const url = $('#syncUrl'), key = $('#syncKey'), status = $('#syncStatus');
  url.value = cfg.url || '';
  key.value = cfg.key || '';
  const show = () => {
    const c = loadSync();
    status.textContent = isSyncReady() ? (c.sheetName ? `設定済み（${c.sheetName}）` : '設定済み') : '未設定';
  };
  show();
  $('#syncKeyShow').addEventListener('change', (e) => { key.type = e.target.checked ? 'text' : 'password'; });
  $('#btnSyncTest').addEventListener('click', async () => {
    const u = url.value.trim();
    if (!isValidSheetUrl(u)) {
      status.textContent = 'URLの形が違います。「https://script.google.com/macros/s/…/exec」の形のものを貼ってください。';
      return;
    }
    if (!key.value) { status.textContent = '合言葉を入れてください。'; return; }
    saveSync({ url: u, key: key.value });
    status.textContent = '接続を確かめています…';
    try {
      const res = await callSheet('ping');
      saveSync({ url: u, key: key.value, sheetName: res.name });
      status.textContent = `つながりました：「${res.name}」${res.updatedAt ? `（最終反映 ${res.updatedAt}）` : ''}`;
      toast('スプレッドシートにつながりました');
      renderShareStatus();
    } catch (e) {
      status.textContent = e.message;
    }
  });
  $('#btnCopyGas').addEventListener('click', async () => {
    try {
      const code = await (await fetch('gas/Code.gs', { cache: 'no-store' })).text();
      if (!code.includes('doPost')) throw new Error();
      await navigator.clipboard.writeText(code);
      toast('連携用スクリプトをコピーしました。Apps Script に貼り付けてください');
    } catch (e) {
      toast('コピーできませんでした。gas/Code.gs を開いて中身を写してください', 5000);
    }
  });
}

/* ---------------- 共有：画像 ---------------- */
async function openImage() {
  const grid = mdata().grid;
  if (!grid || !hasGrid()) { toast('先にシフトを組んでください'); return; }
  const btn = $('#btnImage');
  btn.disabled = true;
  btn.textContent = '作成中…';
  let blob;
  try {
    const c = ctx();
    const v = validate(c, grid);
    const short = v.issues.filter((i) => i.type === 'shortage' && !i.optional).length;
    blob = await renderShiftImage({
      year: state.year, month: state.month, days: days(), members: activeMembers(), grid,
      dayStats: v.dayStats, note: short ? `人が足りない枠 ${short}件` : '',
      title: `${state.year}年${period().title} シフト表`,
    });
  } catch (e) {
    toast('画像を作れませんでした', 4000);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = '画像を作る';
  }
  const pn = period().title.replace(/（.*）/, '');
  const filename = `シフト表_${state.year}年${pn}.png`;
  const url = URL.createObjectURL(blob);
  const modal = $('#modal');
  modal.innerHTML = '';
  const mh = el('div', 'mh');
  const t = el('div');
  t.appendChild(el('h2', '', `${state.year}年${period().title}のシフト表（画像）`));
  t.appendChild(el('div', 'hint', `${Math.round(blob.size / 1024)}KB ／ PNG`));
  mh.appendChild(t);
  const x = el('button', 'btn sm x', '閉じる');
  const close = () => { closeModal(); URL.revokeObjectURL(url); };
  x.addEventListener('click', close);
  mh.appendChild(x);
  modal.appendChild(mh);
  const body = el('div', 'pad');
  const prev = el('div', 'imgprev');
  const img = el('img');
  img.src = url;
  img.alt = `${state.year}年${period().title}のシフト表`;
  prev.appendChild(img);
  body.appendChild(prev);
  const row = el('div', 'row');
  const saveBtn = el('button', 'btn primary', '画像を保存');
  saveBtn.addEventListener('click', () => saveBlob(blob, filename));
  row.appendChild(saveBtn);
  if (navigator.clipboard && window.ClipboardItem) {
    const copyBtn = el('button', 'btn', '画像をコピー（LINEに貼れます）');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('画像をコピーしました。LINEのトーク画面に貼り付けられます');
      } catch (e) {
        toast('コピーできませんでした。「画像を保存」を使ってください', 4000);
      }
    });
    row.appendChild(copyBtn);
  }
  body.appendChild(row);
  modal.appendChild(body);
  $('#mask').classList.add('show');
}

/** ファイルを保存する（claude.ai 上では保存機能ごし、それ以外は通常のダウンロード） */
/**
 * 希望休・予約客室数・名簿・組んだシフトを、まとめて1つのファイルに保存する。
 * 自動保存はブラウザの中だけなので、別のパソコンに移すときや、消えると困るときに使う。
 */
async function exportBackup() {
  const payload = { app: 'kanaloa-shift-planner', version: 1, savedAt: new Date().toISOString(), state };
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  await saveBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    `かなろあシフト_${state.year}年${state.month}月_${stamp}.json`);
}

/** 「ファイルに保存」で作ったファイルを読み込んで、この画面に戻す */
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const loaded = data && data.state ? data.state : data;
    if (!loaded || !Array.isArray(loaded.members) || typeof loaded.months !== 'object') {
      throw new Error('シフト作成ツールで保存したファイルではないようです');
    }
    const lines = Object.keys(loaded.months).sort().map((k) => {
      const md = loaded.months[k] || {};
      const req = Object.values(md.requests || {}).reduce((a, o) => a + Object.keys(o || {}).length, 0);
      const rooms = Object.keys(md.rooms || {}).length;
      return `・${k.replace('-', '年')}月：希望休${req}日分 ／ 予約客室数${rooms}日分${md.grid ? ' ／ シフト案あり' : ''}`;
    });
    if (!confirm(`このファイルを読み込みます。\n\n${lines.join('\n') || '（中身がありません）'}\n\n今このブラウザにある内容は上書きされます。よろしいですか？`)) return;
    const fixed = migrateRules(migrateRoster(loaded));
    state = mergeState(fixed);
    save();
    syncMonthInputs();
    tlDay = null;
    goStep(hasGrid() ? 3 : 1);
    toast('ファイルから戻しました');
  } catch (e) {
    toast(e.message || '読み込めませんでした', 6000);
  }
}

async function saveBlob(blob, filename) {
  const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: blob }); toast('保存しました'); }
    catch (e) { if (!e || e.code !== 'declined') toast('保存できませんでした'); }
    return;
  }
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('保存しました');
}

/* ---------------- 期間・締切・通知 ---------------- */
/** 確定したあとに手直ししたら、確定を取り消す（変えたシフトを、確定済みのまま送ってしまわないように） */
function touchedGrid() {
  const d = mdata().done;
  if (d && d[state.period]) {
    delete d[state.period];
    toast('手直ししたので、確定を取り消しました。もう一度「確定する」を押してください', 5000);
  }
}

function setPeriod(which) {
  if (state.period === which) return;
  if (runRaf) { clearTimeout(runRaf); runRaf = null; }   // 組んでいる途中なら止める（別の期間に書き込まないように）
  state.period = which;
  tlDay = null;
  save();
  goStep(step === 3 && !hasGrid() ? 1 : step === 2 ? 1 : step);
}

/** 期間ごとの締切と、完成しているか */
function periodStatus(which) {
  const p = periodRange(state.year, state.month, which);
  const dl = deadlineOf(p.year, p.month, p.which, state.options.deadlineDaysBefore);
  const doneAt = mdata().done[which];
  return { p, dl, doneAt, st: deadlineStatus(new Date(), dl, doneAt) };
}

function renderDeadline() {
  const tabs = $('#periodTabs');
  tabs.innerHTML = '';
  for (const which of ['first', 'second']) {
    const { p, dl, st } = periodStatus(which);
    const made = periodMade(which);
    const b = el('button', `dl-tab ${st.state}` + (which === state.period ? ' on' : ''));
    b.appendChild(el('span', 't', `${p.name}　${p.month}/${p.from}〜${p.month}/${p.to}`));
    const label = st.state === 'done' ? '完成・通知できます'
      : st.state === 'overdue' ? `締切 ${fmtDate(dl)} を過ぎています`
        : st.state === 'today' ? `今日が締切（${fmtDate(dl)}）`
          : `締切 ${fmtDate(dl)}（あと${st.daysLeft}日）${made ? '・確定前' : ''}`;
    b.appendChild(el('span', 's', label));
    b.addEventListener('click', () => setPeriod(which));
    tabs.appendChild(b);
  }
  const { p, dl, st } = periodStatus(state.period);
  $('#deadlineMsg').textContent = deadlineMessage(p, dl, st);
  $('#deadlineBar').className = 'deadline ' + st.state;
  const dd = $('#dlDays');
  if (document.activeElement !== dd) dd.value = state.options.deadlineDaysBefore;
}

/** スタッフへの通知文（LINEに貼る用）を出す */
let noticePersonId = null;
let notice = null;
function renderNotify(v) {
  const p = period();
  const grid = mdata().grid;
  const { dl, doneAt, st } = periodStatus(p.which);
  notice = buildNotice({ period: p, members: activeMembers(), days: days(), grid });
  $('#notifySub').textContent = `${p.title} ／ 締切 ${fmtDate(dl)}`;
  const short = v ? v.issues.filter((i) => i.type === 'shortage' && !i.optional).length : 0;
  const hint = $('#notifyHint');
  if (doneAt) {
    hint.className = 'hint ok';
    hint.textContent = `確定済みです（${new Date(doneAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）。下の文面と画像をスタッフに送ってください。手直ししたら、確定し直して送り直します。`;
  } else {
    hint.className = 'hint' + (st.state === 'overdue' || st.state === 'today' ? ' warn' : '');
    hint.textContent = `手直しが終わったら「確定する」を押してから、文面と画像をスタッフに送ってください。締切は ${fmtDate(dl)} です。`
      + (short ? `（いま人が足りない枠が${short}件あります）` : '');
  }
  $('#btnConfirm').textContent = doneAt ? '確定を取り消す' : 'このシフトで確定する';
  $('#btnConfirm').classList.toggle('primary', !doneAt);
  $('#noticeCommon').value = notice.common;

  const sel = $('#noticePersonSel');
  sel.innerHTML = '';
  if (!notice.perPerson.some((x) => x.id === noticePersonId)) noticePersonId = notice.perPerson[0] ? notice.perPerson[0].id : null;
  for (const x of notice.perPerson) {
    const o = el('option', '', `${x.name}（出勤${x.work}日）`);
    o.value = x.id;
    if (x.id === noticePersonId) o.selected = true;
    sel.appendChild(o);
  }
  showNoticePerson();
}
function showNoticePerson() {
  const x = notice && notice.perPerson.find((y) => y.id === noticePersonId);
  $('#noticePerson').value = x ? x.text : '';
}

function copyText(text, okMsg) {
  const fallback = () => {
    const ta = el('textarea');
    ta.value = text;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    toast(okMsg);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback);
  else fallback();
}

function toggleConfirm() {
  const p = period();
  const d = mdata().done;
  if (d[p.which]) {
    delete d[p.which];
    save(); renderResult(); renderDeadline();
    toast('確定を取り消しました');
    return;
  }
  const v = validate(ctx(), mdata().grid);
  const short = v.issues.filter((i) => i.type === 'shortage' && !i.optional).length;
  if (short && !confirm(`人が足りない枠が${short}件のこっています。このまま確定しますか？`)) return;
  d[p.which] = new Date().toISOString();
  save(); renderResult(); renderDeadline();
  toast(`${p.title}のシフトを確定しました。文面と画像をスタッフに送ってください`, 5000);
}

/* ---------------- 起動 ---------------- */
function stopRun() { if (runRaf) { clearTimeout(runRaf); runRaf = null; } }   // 組んでいる途中で月を変えたとき、別の月へ書き込まないように止める
function shiftMonth(delta) {
  stopRun();
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
  if (n === 2) { if (hasGrid()) goStep(3); else startRun(false); return; }
  goStep(n);
}));
$('#btnRun').addEventListener('click', () => startRun(false));
$('#btnRedo').addEventListener('click', () => startRun(true));
$('#btnBack1').addEventListener('click', () => goStep(1));
$('#btnRunStop').addEventListener('click', () => { if (runRaf) finishRun(0); });
$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
$('#year').addEventListener('change', (e) => { stopRun(); state.year = Number(e.target.value); tlDay = null; save(); goStep(1); });
$('#month').addEventListener('change', (e) => { stopRun(); state.month = Number(e.target.value); tlDay = null; save(); goStep(1); });
$('#btnExport').addEventListener('click', exportBackup);
$('#btnImport').addEventListener('click', () => $('#backupFile').click());
$('#backupFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';                       // 同じファイルをもう一度選べるように
  if (f) importBackup(f);
});
$('#btnCopy').addEventListener('click', copyTSV);
$('#btnPublish').addEventListener('click', publishToSheet);
$('#btnLoadSheet').addEventListener('click', loadFromSheet);
$('#btnImage').addEventListener('click', openImage);
$('#btnCsv').addEventListener('click', downloadCSV);
$('#btnConfirm').addEventListener('click', toggleConfirm);
$('#btnCopyCommon').addEventListener('click', () => copyText($('#noticeCommon').value, '全員向けの文面をコピーしました。SlackやLINEに貼り付けてください'));
$('#btnCopyPerson').addEventListener('click', () => copyText($('#noticePerson').value, 'この人の分をコピーしました'));
$('#btnCopyAll').addEventListener('click', () => {
  if (!notice) return;
  copyText(notice.perPerson.map((x) => x.text).join('\n\n――――――――――\n\n'), `${notice.perPerson.length}名分をまとめてコピーしました`);
});
$('#btnNoticeImage').addEventListener('click', openImage);
$('#noticePersonSel').addEventListener('change', (e) => { noticePersonId = e.target.value; showNoticePerson(); });
$('#dlDays').addEventListener('change', (e) => {
  state.options.deadlineDaysBefore = Math.min(14, Math.max(0, Number(e.target.value) || 0));
  save(); renderDeadline(); if (step === 3) renderNotify();
});
$('#showTimes').addEventListener('change', renderResult);
$('#bigText').addEventListener('change', renderResult);
$('#showLegend').addEventListener('change', renderLegend);
$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.v;
  viewChosen = true;
  showView();
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
  if (!confirm(`${state.year}年${state.month}月の希望休を、前半・後半ともすべて消します。よろしいですか？`)) return;
  mdata().requests = {}; mdata().streaks = {}; mdata().noRequest = {};
  save(); renderCollect();
});
$('#applyRoomsPaste').addEventListener('click', () => {
  const total = Number(state.options.totalRooms) || 28;
  const det = parseRoomsInputDetail($('#roomsPaste').value, period().monthDays, period().from, { month: state.month, periodLength: period().length });
  let parsed = det.rooms;
  const n = Object.keys(parsed).length;
  if (!n) { toast('数値を読み取れませんでした'); return; }
  // 日付つきの行が見つからず、数字を並べて読んだとき（表の列が多いなど）は、読み違いがないか確認してもらう
  if (det.mode === 'sequence' && /[\r\n\t]/.test($('#roomsPaste').value.trim()) && /[^\d\s,\t.]/.test($('#roomsPaste').value)) {
    if (!confirm(`日付つきの行が見つからなかったので、数字だけを${det.rooms[Object.keys(det.rooms)[0]] !== undefined ? Object.keys(det.rooms)[0] + '日' : ''}から順に${n}日分として読みます。\n\n表の列（曜日・予約数など）が混ざっていると、ずれます。「10/1 14」のように、日付と数を1行にした形で貼るのがおすすめです。\nこのまま入れますか？`)) return;
  }
  // ねっぱんの残室数を貼ったときは、予約客室数＝全客室数−残室数
  const vacancy = $('#roomsIsStock').checked;
  if (vacancy) parsed = roomsFromVacancy(parsed, total);
  mdata().rooms = { ...mdata().rooms, ...parsed };
  save(); renderRoomsGrid(); renderSummary();
  toast(vacancy ? `${n}日分の残室数から、予約客室数（${total}−残室数）を入れました` : `${n}日分の客室数を取り込みました`);
});

/* ---------------- 日ごとのリクエスト ---------------- */
const DAYREQ_LABEL = { full: '全員出勤', closed: '休館', rooms: '予約客室数', clean: '清掃の合計人数' };
/** 読み取った日ごとの指示を、この月のデータに書き込む */
function applyDayRequest(item) {
  const md = mdata();
  const lines = [];
  for (const d of item.days) {
    for (const fx of item.effects) {
      if (fx.kind === 'full') { if (!md.full.includes(d)) md.full.push(d); }
      else if (fx.kind === 'closed') { if (!md.closed.includes(d)) md.closed.push(d); }
      else if (fx.kind === 'rooms') md.rooms[d] = fx.value;
      else if (fx.kind === 'clean') md.needs[d] = { ...(md.needs[d] || {}), clean: fx.value };
      else if (fx.kind === 'slot') md.needs[d] = { ...(md.needs[d] || {}), [fx.ruleId]: fx.value };
    }
    if (item.note) md.notes[d] = item.note;
  }
  const dayText = item.days.length > 3 && item.days.every((d, i) => i === 0 || d === item.days[i - 1] + 1)
    ? `${item.days[0]}〜${item.days[item.days.length - 1]}日` : item.days.map((d) => d + '日').join('・');
  const what = item.effects.map((fx) => (fx.kind === 'slot' ? `${fx.label} ${fx.value}名` : fx.kind === 'rooms' ? `予約客室数 ${fx.value}室` : fx.kind === 'clean' ? `清掃 ${fx.value}名` : DAYREQ_LABEL[fx.kind])).join('・');
  lines.push(`${dayText}：${what}${item.note ? `（${item.note}）` : ''}`);
  return lines[0];
}
function doDayRequests() {
  const text = $('#dayReqText').value.trim();
  if (!text) { toast('リクエストを書いてください'); return; }
  const res = parseDayRequests(text, { month: state.month, daysInMonth: period().monthDays, rules: state.rules, totalRooms: Number(state.options.totalRooms) || 28 });
  const host = $('#dayReqResult');
  host.innerHTML = '';
  if (!res.items.length && !res.unread.length) { toast('読み取れませんでした'); return; }
  const done = res.items.map(applyDayRequest);
  save(); renderRoomsGrid(); renderSummary();
  if (done.length) {
    host.appendChild(el('h3', '', `反映しました ${done.length}件`));
    const ul = el('ul', 'ok-list');
    for (const l of done) ul.appendChild(el('li', '', l));
    host.appendChild(ul);
    host.appendChild(el('p', 'hint', '上の予約客室数の欄に反映されています（黄色の日が全員出勤）。直すときは、その日の欄で変えてください。'));
  }
  if (res.unread.length) {
    host.appendChild(el('h3', '', `読み取れませんでした ${res.unread.length}件`));
    const ul = el('ul', 'check-list');
    for (const u of res.unread) {
      const li = el('li');
      li.appendChild(el('span', 'check-why', u.why));
      li.appendChild(el('span', 'check-text', u.text));
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }
  if (done.length) { $('#dayReqText').value = ''; toast(`${done.length}件のリクエストを反映しました`); }
  else toast('読み取れなかった指示があります');
}
$('#btnDayReq').addEventListener('click', doDayRequests);
$('#btnClearDayReq').addEventListener('click', () => {
  if (!confirm(`${state.year}年${state.month}月の「全員出勤」「清掃の人数」「焼き鳥屋などの人数指定」「日ごとのメモ」を消します。よろしいですか？`)) return;
  const md = mdata();
  md.full = []; md.needs = {}; md.notes = {};
  save(); renderRoomsGrid(); renderSummary();
  $('#dayReqResult').innerHTML = '';
  toast('日ごとの指示を消しました');
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
  state.members = defaultMembers(); state.rosterRev = ROSTER_REV; save(); renderCollect(); renderStaff();
});
$('#addRule').addEventListener('click', () => {
  state.rules.push({ id: 'r' + Date.now(), label: '新しい枠', pattern: 'H', roles: [], base: 1, perRooms: 0, max: 2, enabled: true, optional: false });
  save(); renderRuleTable();
});
$('#resetRules').addEventListener('click', () => {
  if (!confirm('必要人員のルールを初期値に戻します。よろしいですか？')) return;
  state.rules = defaultSlotRules(); state.rulesRev = RULES_REV; save(); renderRuleTable(); renderCollect();
});

syncMonthInputs();
bindOptions();
bindSync();
$('#btnSyncLink').addEventListener('click', copySetupLink);
$('#btnLoadSheet').hidden = !isSyncReady();
/* 画面全体の大きさ（文字も表も一緒に拡大）。初期値は少し大きめ */
const ZOOM_STEPS = [1, 1.1, 1.2, 1.35, 1.5, 1.7];
const ZOOM_KEY = 'kanaloa.zoom';
let zoomIdx = window.matchMedia('(max-width: 700px)').matches ? 1 : 2; // スマホは画面が狭いので、少しだけ大きく
try {
  const raw = localStorage.getItem(ZOOM_KEY);
  const v = raw === null ? NaN : Number(raw);
  if (Number.isInteger(v) && v >= 0 && v < ZOOM_STEPS.length) zoomIdx = v;
} catch (e) { /* 既定のまま */ }
function applyZoom() {
  document.documentElement.style.zoom = String(ZOOM_STEPS[zoomIdx]);
  $('#btnZoomOut').disabled = zoomIdx === 0;
  $('#btnZoomIn').disabled = zoomIdx === ZOOM_STEPS.length - 1;
  try { localStorage.setItem(ZOOM_KEY, String(zoomIdx)); } catch (e) { /* 記憶できなくても動作は続ける */ }
}
$('#btnZoomOut').addEventListener('click', () => { if (zoomIdx > 0) { zoomIdx--; applyZoom(); } });
$('#btnZoomIn').addEventListener('click', () => { if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; applyZoom(); } });
applyZoom();

$('#btnAccount').addEventListener('click', openAccountModal);
renderAccountButton();
initAccount();
setImportMode('msg');
goStep(hasGrid() ? 3 : 1);
applySetupLink();
window.addEventListener('hashchange', applySetupLink);   // すでに開いている画面で設定リンクを踏んだとき
