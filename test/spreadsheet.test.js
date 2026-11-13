import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  parseDelimitedText,
  parseXlsxWorkbook,
  detectDelimiter,
  delimiterLabel,
  computeColumnWidths,
  visibleColumnRange,
  visibleRowRange,
  SPREADSHEET_MAX_ROWS,
  SPREADSHEET_MAX_COLUMNS,
} from "../mods/file-editor/spreadsheet.js";

/**
 * Builds a minimal ZIP archive with deflated entries. CRCs are left at zero
 * because the preview reader only needs names, sizes and compressed bytes.
 *
 * @param {Array<[string, string]>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf-8");
    const data = Buffer.from(content, "utf-8");
    const compressed = deflateRawSync(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** A small but representative workbook with shared/inline strings, gaps and styles. */
const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sales &amp; Data" sheetId="1" r:id="rId1"/>
    <sheet name="Second" sheetId="2" r:id="rId2"/>
  </sheets>
  <workbookView activeTab="1"/>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>`;

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Name</t></si>
  <si><t>Age</t></si>
  <si><r><t>Ali</t></r><r><t>ce</t></r><rPh><t>ignored</t></rPh></si>
</sst>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="164" applyNumberFormat="1"/>
    <xf numFmtId="10" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

const SHEET_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Bob</t></is></c><c r="B3" s="1"><v>45292</v></c></row>
    <row r="5"><c r="D5" t="b"><v>1</v></c><c r="E5" s="2"><v>0.25</v></c></row>
  </sheetData>
</worksheet>`;

const SHEET_TWO = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c></row></sheetData>
</worksheet>`;

function sampleWorkbook() {
  return makeZip([
    ["xl/workbook.xml", WORKBOOK_XML],
    ["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
    ["xl/sharedStrings.xml", SHARED_STRINGS],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", SHEET_ONE],
    ["xl/worksheets/sheet2.xml", SHEET_TWO],
  ]);
}

test("parseDelimitedText - parses headers, quotes, escapes and embedded newlines", () => {
  const workbook = parseDelimitedText(
    'Name,Age,Note\r\n"Alice, A.",30,"He said ""hi""\nnext line"\r\nBob,25,\r\n',
    { extension: "csv" }
  );

  assert.equal(workbook.kind, "csv");
  assert.equal(workbook.delimiter, ",");
  assert.equal(workbook.delimiterLabel, "Comma");
  assert.deepEqual(workbook.sheets[0].rows, [
    ["Name", "Age", "Note"],
    ["Alice, A.", "30", 'He said "hi" next line'],
    ["Bob", "25", ""],
  ]);
  assert.deepEqual(workbook.sheets[0].rowNumbers, [1, 2, 3]);
  assert.equal(workbook.sheets[0].columnCount, 3);
  assert.equal(workbook.truncated, false);
});

test("parseDelimitedText - detects semicolons and honors TSV tabs", () => {
  const semicolons = parseDelimitedText("name;city\nAna;Lisbon\n", { extension: "csv" });
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(semicolons.delimiter, ";");
  assert.equal(semicolons.delimiterLabel, "Semicolon");
  assert.deepEqual(semicolons.sheets[0].rows[1], ["Ana", "Lisbon"]);

  const tabs = parseDelimitedText("name\tcity\nAna\tLisbon\n", { extension: "tsv" });
  assert.equal(tabs.delimiter, "\t");
  assert.equal(tabs.delimiterLabel, "Tab");
  assert.equal(tabs.sheets[0].name, "TSV");
  assert.deepEqual(tabs.sheets[0].rows[1], ["Ana", "Lisbon"]);
});

test("parseDelimitedText - caps rows and columns without losing the header", () => {
  const workbook = parseDelimitedText('"a,b",c,d\n1,2,3\n4,5,6', {
    maxRows: 2,
    maxColumns: 2,
  });
  const sheet = workbook.sheets[0];

  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.columnCount, 2);
  assert.deepEqual(sheet.rows[0], ["a,b", "c"]);
  assert.equal(sheet.truncatedRows, true);
  assert.equal(sheet.truncatedColumns, true);
  assert.equal(workbook.truncated, true);
});

test("parseDelimitedText - empty input yields an empty one-sheet workbook", () => {
  const workbook = parseDelimitedText("", { extension: "csv" });
  assert.equal(workbook.sheets.length, 1);
  assert.deepEqual(workbook.sheets[0].rows, []);
  assert.equal(workbook.sheets[0].columnCount, 0);
  assert.deepEqual(workbook.sheets[0].widths, []);
});

test("delimiterLabel - names supported separators", () => {
  assert.equal(delimiterLabel(","), "Comma");
  assert.equal(delimiterLabel(";"), "Semicolon");
  assert.equal(delimiterLabel("\t"), "Tab");
  assert.equal(delimiterLabel("|"), "Pipe");
});

test("parseXlsxWorkbook - reads sheet names, shared strings, gaps and number formats", () => {
  const workbook = parseXlsxWorkbook(sampleWorkbook());

  assert.equal(workbook.kind, "xlsx");
  assert.equal(workbook.sheets.length, 2);
  assert.equal(workbook.sheets[0].name, "Sales & Data");
  assert.equal(workbook.activeSheet, 1);

  const sheet = workbook.sheets[0];
  assert.equal(sheet.columnCount, 5);
  assert.equal(sheet.rows.length, 5);
  assert.deepEqual(sheet.rowNumbers, [1, 2, 3, 4, 5]);
  assert.deepEqual(sheet.rows[0], ["Name", "Age", "", "", ""]);
  assert.deepEqual(sheet.rows[1], ["Alice", "30", "", "", ""]);
  assert.deepEqual(sheet.rows[2], ["Bob", "2024-01-01", "", "", ""]);
  assert.deepEqual(sheet.rows[3], ["", "", "", "", ""]);
  assert.deepEqual(sheet.rows[4], ["", "", "", "TRUE", "25.00%"]);
  assert.equal(sheet.widths.length, 5);

  assert.deepEqual(workbook.sheets[1].rows, [["Hello"]]);
});

test("parseXlsxWorkbook - honors the 1904 date system", () => {
  const zip = makeZip([
    [
      "xl/workbook.xml",
      '<workbook><workbookPr date1904="1"/><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/styles.xml",
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" s="0"><v>0</v></c></row></sheetData></worksheet>',
    ],
  ]);

  const workbook = parseXlsxWorkbook(zip);
  assert.deepEqual(workbook.sheets[0].rows, [["1904-01-01"]]);
});

test("parseXlsxWorkbook - supports workbooks with no shared string table", () => {
  const zip = makeZip([
    ["xl/workbook.xml", '<workbook><sheets><sheet name="One" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Only</t></is></c></row></sheetData></worksheet>',
    ],
  ]);

  const workbook = parseXlsxWorkbook(zip);
  assert.equal(workbook.sheets.length, 1);
  assert.deepEqual(workbook.sheets[0].rows, [["Only"]]);
  assert.equal(workbook.activeSheet, 0);
});

test("parseXlsxWorkbook - rejects non-ZIP and encrypted input", () => {
  assert.throws(() => parseXlsxWorkbook(Buffer.from("not a workbook")), /valid \.xlsx|ZIP/i);
  assert.throws(
    () => parseXlsxWorkbook(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])),
    /Encrypted/i
  );
});

test("computeColumnWidths - clamps tiny and very wide values", () => {
  const widths = computeColumnWidths(
    [
      ["a", "x".repeat(200)],
      ["", ""],
    ],
    2
  );
  assert.equal(widths[0], 64);
  assert.equal(widths[1], 340);
});

test("visibleColumnRange - keeps partially visible columns and reports the offset", () => {
  const range = visibleColumnRange([100, 100, 100, 100], 150, 120);
  assert.deepEqual(range, { start: 1, end: 3, offset: 50 });
  assert.deepEqual(visibleColumnRange([], 0, 100), { start: 0, end: 0, offset: 0 });
});

test("visibleRowRange - virtualizes rows with overscan", () => {
  const range = visibleRowRange(100, 130, 100, 26, 2);
  assert.deepEqual(range, { start: 3, end: 12, offset: 52 });
  assert.deepEqual(visibleRowRange(0, 0, 100, 26), { start: 0, end: 0, offset: 0 });
});

test("spreadsheet limits stay aligned with the documented preview bounds", () => {
  assert.equal(SPREADSHEET_MAX_ROWS, 2000);
  assert.equal(SPREADSHEET_MAX_COLUMNS, 100);
});
