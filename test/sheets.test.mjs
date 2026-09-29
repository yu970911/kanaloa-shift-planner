// スプレッドシート連携スクリプト（gas/Code.gs）を、Google の機能を模した環境で動かして確かめる: node test/sheets.test.mjs
import fs from 'fs';
import vm from 'vm';
import { buildSheetTable, stateForSheet, encodeSetup, decodeSetup } from '../js/sheets.js';
import { generateShift, validate } from '../js/solver.js';
import { defaultSlotRules, defaultOptions, buildDays } from '../js/model.js';
import { testMembers, testRules } from './fixtures.mjs';

let failed = 0;
const ok = (c, name, extra = '') => { console.log((c ? '  PASS ' : '  FAIL ') + name + (extra ? '  … ' + extra : '')); if (!c) failed++; };

/* ---- Google の機能をまねる ---- */
function makeSheet(name) {
  const sh = {
    name, cells: new Map(), maxRows: 1000, maxCols: 26, hidden: false, frozenRows: 0, frozenCols: 0, id: Math.floor(Math.random() * 1e6),
    clear() { this.cells.clear(); },
    getMaxColumns() { return this.maxCols; }, getMaxRows() { return this.maxRows; },
    insertColumnsAfter(_, n) { this.maxCols += n; }, insertRowsAfter(_, n) { this.maxRows += n; },
    setFrozenRows(n) { this.frozenRows = n; }, setFrozenColumns(n) { this.frozenCols = n; },
    setColumnWidth() {}, setColumnWidths() {}, setRowHeights() {}, hideSheet() { this.hidden = true; },
    getSheetId() { return this.id; }, getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, +k.split(',')[0]); return m; },
    getRange(r, c, rows = 1, cols = 1) {
      if (r < 1 || c < 1) throw new Error(`範囲外 (${r},${c})`);
      if (c + cols - 1 > sh.maxCols) throw new Error(`列が足りません: ${c + cols - 1} > ${sh.maxCols}`);
      if (r + rows - 1 > sh.maxRows) throw new Error(`行が足りません: ${r + rows - 1} > ${sh.maxRows}`);
      const check2d = (a, label) => {
        if (!Array.isArray(a) || a.length !== rows || a.some((x) => !Array.isArray(x) || x.length !== cols)) {
          throw new Error(`${label} の大きさが範囲と合いません（範囲 ${rows}×${cols}）`);
        }
      };
      const rg = {
        setValue(v) { sh.cells.set(`${r},${c}`, v); return rg; },
        setValues(a) {
          check2d(a, 'setValues');
          a.forEach((row, i) => row.forEach((v, j) => {
            const s = String(v);
            if (s.length > 50000) throw new Error('1セル50,000文字を超えています');
            sh.cells.set(`${r + i},${c + j}`, v);
          }));
          return rg;
        },
        setBackgrounds(a) { check2d(a, 'setBackgrounds'); return rg; },
        setFontColors(a) { check2d(a, 'setFontColors'); return rg; },
        setFontWeights(a) { check2d(a, 'setFontWeights'); return rg; },
        getValue() { return sh.cells.get(`${r},${c}`); },
        getDisplayValue() { return String(sh.cells.get(`${r},${c}`) ?? ''); },
        getValues() { const out = []; for (let i = 0; i < rows; i++) { const row = []; for (let j = 0; j < cols; j++) row.push(sh.cells.get(`${r + i},${c + j}`) ?? ''); out.push(row); } return out; },
        setNumberFormat() { return rg; }, setFontSize() { return rg; }, setFontWeight() { return rg; }, setFontColor() { return rg; },
        setHorizontalAlignment() { return rg; }, setVerticalAlignment() { return rg; }, setBorder() { return rg; },
      };
      return rg;
    },
  };
  return sh;
}
const book = { sheets: [makeSheet('シート1')], active: null };
const SpreadsheetApp = {
  BorderStyle: { SOLID: 1, SOLID_MEDIUM: 2 },
  getActive: () => ({
    getName: () => 'かなろあ シフト共有',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/xxxx/edit',
    getSheetByName: (n) => book.sheets.find((s) => s.name === n) || null,
    insertSheet: (n, idx) => { const s = makeSheet(n); if (idx === 0) book.sheets.unshift(s); else book.sheets.push(s); return s; },
    setActiveSheet: (s) => { book.active = s; },
    moveActiveSheet: (pos) => { book.sheets = book.sheets.filter((s) => s !== book.active); book.sheets.splice(pos - 1, 0, book.active); },
  }),
};
const ctxG = {
  SpreadsheetApp,
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Utilities: { formatDate: () => '2026/09/17 10:30' },
};
vm.createContext(ctxG);
const code = fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
vm.runInContext(code.replace("const KEY = 'ここに合言葉を入れてください';", "const KEY = 'kanaloa-test';"), ctxG);
const post = (body) => JSON.parse(vm.runInContext(`doPost(${JSON.stringify({ postData: { contents: JSON.stringify(body) } })})`, ctxG).body);

/* ---- 実際のシフトで往復させる ---- */
const members = testMembers();
const days = buildDays(2026, 10, {}, [], 14);
const options = { ...defaultOptions(), iterations: 60 };
const res = generateShift({ days, members, requests: {}, rules: testRules(), options });
const v = validate({ days, members, requests: {}, rules: testRules(), options }, res.grid);
const table = buildSheetTable({ days, members, grid: res.grid, dayStats: v.dayStats });
// 保存データを大きくして、分割保存も確かめる（12か月分）
const state = { year: 2026, month: 10, members, rules: testRules(), options, months: {} };
for (let i = 1; i <= 12; i++) state.months[`2026-${String(i).padStart(2, '0')}`] = { rooms: {}, closed: [], requests: {}, streaks: {}, grid: res.grid, note: '=SUM(A1) テスト +1 -1' };
const json = stateForSheet(state);

console.log('=== スプレッドシート連携スクリプト ===');
ok(JSON.parse(vm.runInContext('doGet()', ctxG).body).ok, 'URLを開くと「動いています」と返す');
ok(post({ action: 'ping', key: 'wrong' }).error === 'key', '合言葉が違うと拒否する');
ok(post({ action: 'ping', key: 'kanaloa-test' }).name === 'かなろあ シフト共有', '合言葉が合えばつながる');

const pub = post({ action: 'publish', key: 'kanaloa-test', sheetName: '2026年10月', title: 't', table, state: json });
ok(pub.ok, 'シフト表を書き込める', pub.error || pub.sheetName);
const sh = book.sheets[0];
ok(sh.name === '2026年10月', '書き込んだシートが一番左に来る', book.sheets.map((s) => s.name).join(' / '));
ok(sh.maxCols >= 4 + 31, '31日分の列が足りない場合は列を足す', sh.maxCols + '列');
ok(sh.getRange(4, 2).getValue() === '名前' || sh.getRange(3, 2).getValue() === '名前', '見出しが書かれている');
ok(sh.frozenRows === 5 && sh.frozenCols === 4, '見出し3行と名前の列を固定する', `行${sh.frozenRows} 列${sh.frozenCols}`);
const data = book.sheets.find((s) => s.name === '_data');
ok(data && data.hidden, '保存データは非表示のシートに置く');
ok(Number(data.getRange(1, 3).getValue()) >= 2, '大きな保存データは複数のセルに分けて置く', `${json.length.toLocaleString()}文字 → ${data.getRange(1, 3).getValue()}セル`);

const load = post({ action: 'load', key: 'kanaloa-test' });
ok(load.ok && load.state === json, '書き込んだ保存データを、1文字も違わず読み戻せる', `${load.state.length.toLocaleString()}文字`);
const back = JSON.parse(load.state);
ok(back.months['2026-03'].note === '=SUM(A1) テスト +1 -1', '「=」で始まる文字も数式にならず、そのまま戻る');

// 2回目の反映で上書き
const pub2 = post({ action: 'publish', key: 'kanaloa-test', sheetName: '2026年10月', title: 't', table, state: '{"small":true}' });
ok(pub2.ok && post({ action: 'load', key: 'kanaloa-test' }).state === '{"small":true}', 'もう一度反映すると、古い保存データの残りが混ざらない');
ok(book.sheets.filter((s) => s.name === '2026年10月').length === 1, '同じ月を反映しても、シートが増えない');

console.log('\n=== 設定リンク ===');
{
  const cfg = { url: 'https://script.google.com/macros/s/AKfycbTEST12345/exec', key: 'かなろあ2026' };
  const token = encodeSetup(cfg);
  ok(!/[+/=]/.test(token), 'リンクに使える文字だけになる', token);
  const back = decodeSetup(token);
  ok(back && back.url === cfg.url && back.key === cfg.key, '元のURLと合言葉に戻せる', JSON.stringify(back));
  ok(decodeSetup('こわれたトークン') === null, '壊れたリンクは受け付けない');
  ok(decodeSetup(encodeSetup({ url: 'https://example.com/exec', key: 'x' })) === null, 'Apps Script以外のURLは受け付けない');
}

console.log(failed === 0 ? '\n全項目 PASS' : `\n${failed}件 FAIL`);
process.exit(failed ? 1 : 0);
