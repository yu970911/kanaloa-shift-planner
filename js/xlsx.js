// 外部ライブラリなしで、色・文字の大きさ付きの .xlsx を作る（zipは無圧縮）。
// sheet = { name, colWidths:[文字数], rowHeights:[pt|null], rows:[[{v, s}]], merges:['A1:L1'], freeze:{x,y} }
// s（書式）= { sz, b, fg, bg, h:'left'|'center'|'right', border, wrap }

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let n = i + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const argb = (hex) => 'FF' + String(hex || '#000000').replace('#', '').toUpperCase();

/** 無圧縮zipを作る。files = [{name, data(Uint8Array)}] */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const header = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0),
    ]);
    chunks.push(header, name, f.data);
    central.push({ name, crc, size: f.data.length, offset });
    offset += header.length + name.length + f.data.length;
  }
  let centralSize = 0;
  const cd = [];
  for (const c of central) {
    const rec = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset),
    ]);
    cd.push(rec, c.name);
    centralSize += rec.length + c.name.length;
  }
  const end = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const all = [...chunks, ...cd, end];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/** 1シートの .xlsx を作って Uint8Array で返す */
export function buildXlsx(sheet) {
  // 書式の登録（同じ書式は使い回す）
  const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = [];
  const fontIdx = new Map(), fillIdx = new Map(), xfIdx = new Map();
  let borderThin = -1;
  const fontOf = (sz, b, fg) => {
    const key = `${sz}|${b ? 1 : 0}|${fg || ''}`;
    if (!fontIdx.has(key)) {
      fonts.push(`<font>${b ? '<b/>' : ''}<sz val="${sz}"/>${fg ? `<color rgb="${argb(fg)}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`);
      fontIdx.set(key, fonts.length - 1);
    }
    return fontIdx.get(key);
  };
  const fillOf = (bg) => {
    if (!bg) return 0;
    if (!fillIdx.has(bg)) {
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${argb(bg)}"/><bgColor indexed="64"/></patternFill></fill>`);
      fillIdx.set(bg, fills.length - 1);
    }
    return fillIdx.get(bg);
  };
  const borderOf = (on) => {
    if (!on) return 0;
    if (borderThin < 0) {
      const side = (n) => `<${n} style="thin"><color rgb="FFBFBFBF"/></${n}>`;
      borders.push(`<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`);
      borderThin = borders.length - 1;
    }
    return borderThin;
  };
  fontOf(11, false, null); // 既定のフォント（index 0）
  xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  const styleOf = (s) => {
    if (!s) return 0;
    const key = JSON.stringify([s.sz || 11, !!s.b, s.fg || '', s.bg || '', s.h || '', !!s.border, !!s.wrap]);
    if (!xfIdx.has(key)) {
      const f = fontOf(s.sz || 11, s.b, s.fg), fl = fillOf(s.bg), bd = borderOf(s.border);
      const align = `<alignment horizontal="${s.h || 'general'}" vertical="center"${s.wrap ? ' wrapText="1"' : ''}/>`;
      xfs.push(`<xf numFmtId="0" fontId="${f}" fillId="${fl}" borderId="${bd}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`);
      xfIdx.set(key, xfs.length - 1);
    }
    return xfIdx.get(key);
  };

  // シートのXML
  const rowsXml = sheet.rows.map((cells, ri) => {
    const ht = sheet.rowHeights && sheet.rowHeights[ri];
    const cs = cells.map((c, ci) => {
      if (!c) return '';
      const ref = colName(ci) + (ri + 1);
      const s = styleOf(c.s);
      const v = c.v;
      if (v === undefined || v === null || v === '') return `<c r="${ref}" s="${s}"/>`;
      if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cs}</row>`;
  }).join('');
  const cols = (sheet.colWidths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const fz = sheet.freeze;
  const pane = fz && (fz.x || fz.y)
    ? `<pane${fz.x ? ` xSplit="${fz.x}"` : ''}${fz.y ? ` ySplit="${fz.y}"` : ''} topLeftCell="${colName(fz.x || 0)}${(fz.y || 0) + 1}" activePane="${fz.x && fz.y ? 'bottomRight' : fz.y ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
    : '';
  const merges = (sheet.merges || []).length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rowsXml}</sheetData>${merges}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/></worksheet>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const files = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(String(sheet.name || 'Sheet1').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', text: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml },
  ].map((f) => ({ name: f.name, data: enc.encode(f.text) }));
  return zip(files);
}
