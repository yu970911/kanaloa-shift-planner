/**
 * @OnlyCurrentDoc
 *
 * ホテルかなろあ シフト自動作成 ― スプレッドシート連携用スクリプト
 *
 * 【設定のしかた】
 *  1. シフトを共有したいスプレッドシートを開く
 *  2. メニュー「拡張機能」→「Apps Script」
 *  3. 最初から入っている中身を全部消して、このファイルの中身を貼り付ける
 *  4. すぐ下の KEY を、好きな合言葉に書き換える（ツールにも同じ合言葉を入れます）
 *  5. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分
 *       アクセスできるユーザー：全員
 *     →「デプロイ」→ Googleアカウントの承認
 *  6. 表示された「ウェブアプリのURL」をコピーして、ツールの
 *     「詳細設定 → スプレッドシート連携」に貼り付ける
 *
 * このスクリプトが触るのは、このスプレッドシートだけです（@OnlyCurrentDoc）。
 */
const KEY = 'ここに合言葉を入れてください';   // ← 合言葉はApps Script側だけに書く。このファイルには残さない

const DATA_SHEET = '_data';        // ツールの保存データ（非表示のシート）
const CHUNK = 40000;               // 1セルに入る文字数の上限（50,000）より小さく分ける
const TZ = 'Asia/Tokyo';

function doGet() {
  return json_({ ok: true, message: 'シフト連携スクリプトは動いています。ツールから使います。' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  if (KEY === 'ここに合言葉を入れてください') return json_({ ok: false, error: 'setup' });
  if (!req || req.key !== KEY) return json_({ ok: false, error: 'key' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
  try {
    if (req.action === 'ping') return json_(ping_());
    if (req.action === 'publish') return json_(publish_(req));
    if (req.action === 'load') return json_(load_());
    return json_({ ok: false, error: 'action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function ping_() {
  const ss = SpreadsheetApp.getActive();
  const data = ss.getSheetByName(DATA_SHEET);
  return {
    ok: true,
    name: ss.getName(),
    url: ss.getUrl(),
    updatedAt: data ? String(data.getRange(1, 2).getDisplayValue() || '') : '',
  };
}

/**
 * シフト表を「2026年10月」のようなシートに書き出し、いちばん左に置く。
 * ツールの保存データも一緒に残すので、別のパソコンから最新を読み込める。
 */
function publish_(req) {
  const t = req.table;
  if (!t || !t.values || !t.values.length) return { ok: false, error: 'bad_request' };
  const ss = SpreadsheetApp.getActive();
  const name = String(req.sheetName || 'シフト');

  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, 0);
  } else {
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(1);
  }
  sh.clear();
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);

  const rows = t.values.length;
  const cols = t.values[0].length;
  const top = 3;                                         // 1行目：見出し、2行目：更新日時
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  if (sh.getMaxRows() < top + rows + 2) sh.insertRowsAfter(sh.getMaxRows(), top + rows + 2 - sh.getMaxRows());

  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm');
  sh.getRange(1, 1).setValue(req.title || name).setFontSize(15).setFontWeight('bold');
  sh.getRange(2, 1).setValue('最終更新 ' + stamp + (req.note ? '　' + req.note : '')).setFontColor('#8d949c');

  const range = sh.getRange(top, 1, rows, cols);
  range.setNumberFormat('@');                            // 記号や日付が勝手に変換されないように
  range.setValues(t.values);
  range.setBackgrounds(t.backgrounds);
  range.setFontColors(t.fontColors);
  range.setFontWeights(t.fontWeights);
  range.setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(top, 1, rows, 3).setHorizontalAlignment('left');
  range.setBorder(true, true, true, true, true, true, '#e4e7ea', SpreadsheetApp.BorderStyle.SOLID);

  // 担当の切り替わりに太めの線
  (t.groupBreaks || []).forEach(function (r) {
    sh.getRange(top + r, 1, 1, cols).setBorder(true, null, null, null, null, null, '#9aa3ab', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  });

  sh.setFrozenRows(top + (t.headerRows || 1) - 1);
  sh.setFrozenColumns(t.frozenCols || 4);
  (t.colWidths || []).forEach(function (w, i) { if (w) sh.setColumnWidth(i + 1, w); });
  if (t.dayColWidth) sh.setColumnWidths((t.frozenCols || 4) + 1, cols - (t.frozenCols || 4), t.dayColWidth);
  sh.setRowHeights(top, rows, 24);

  if (req.state) saveState_(ss, req.state, stamp);

  return { ok: true, sheetName: name, url: ss.getUrl() + '#gid=' + sh.getSheetId(), updatedAt: stamp };
}

function saveState_(ss, stateJson, stamp) {
  let sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DATA_SHEET);
    sh.hideSheet();
  }
  sh.clear();
  const s = String(stateJson);
  const parts = [];
  // 先頭に文字を1つ付けて、数式や数値として解釈されないようにする（読むときに外す）
  for (let i = 0; i < s.length; i += CHUNK) parts.push(['c' + s.slice(i, i + CHUNK)]);
  sh.getRange(1, 1, parts.length, 1).setNumberFormat('@').setValues(parts);
  sh.getRange(1, 2).setValue(stamp);
  sh.getRange(1, 3).setValue(parts.length);
}

function load_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) return { ok: false, error: 'nodata' };
  const n = Number(sh.getRange(1, 3).getValue()) || 0;
  if (!n) return { ok: false, error: 'nodata' };
  const state = sh.getRange(1, 1, n, 1).getValues().map(function (r) { return String(r[0]).slice(1); }).join('');
  return { ok: true, state: state, updatedAt: String(sh.getRange(1, 2).getDisplayValue() || '') };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
