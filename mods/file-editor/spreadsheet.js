/**
 * Spreadsheet preview parsing for herdr-file-editor.
 *
 * - CSV and TSV are parsed into rows, detecting the delimiter and honoring
 *   quoted fields, escaped quotes, CRLF and newlines inside quotes.
 * - XLSX/XLSM workbooks are read straight from their ZIP container (stored or
 *   deflated entries), then from the OOXML parts: shared strings, workbook
 *   relationships, styles and worksheet cells.
 *
 * Everything here is deterministic and free of GPUI/Herdr imports so the same
 * code runs in Node's test runner. The only runtime dependency is `zlib`, used
 * to inflate ZIP entries, which the Herdr shell exposes.
 */

import * as zlibModule from "zlib";

/** @type {any} */
const zlib = zlibModule;

/** Maximum rows rendered from one sheet (the header row included). */
export const SPREADSHEET_MAX_ROWS = 2000;

/** Maximum columns rendered from one sheet. */
export const SPREADSHEET_MAX_COLUMNS = 100;

/** Maximum characters kept from a single cell before it is ellipsized. */
export const SPREADSHEET_MAX_CELL_CHARS = 500;

/** Refuse workbooks larger than this, to keep the preview responsive. */
const MAX_WORKBOOK_BYTES = 128 * 1024 * 1024;

/** Refuse a single inflated OOXML part larger than this. */
const MAX_XML_PART_BYTES = 64 * 1024 * 1024;

/** Columns wider than this waste horizontal room, so they are clamped. */
const MAX_COLUMN_WIDTH = 340;

/** Columns narrower than this make values unreadable. */
const MIN_COLUMN_WIDTH = 64;

/** Built-in Excel number formats that matter for a readable preview. */
const BUILTIN_NUMBER_FORMATS = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/**
 * Cache of derived format properties. Styles are few, but cells are many, so
 * the regex work behind date/percent/decimal detection happens once per format.
 * @type {Map<string, {
 *   cleaned: string,
 *   isDate: boolean,
 *   timeOnly: boolean,
 *   showSeconds: boolean,
 *   hasTime: boolean,
 *   decimals: number | null,
 *   grouping: boolean,
 *   scientific: boolean,
 *   percent: boolean,
 *   text: boolean
 * }>}
 */
const FORMAT_INFO_CACHE = new Map();

/** Hot-path XML regexes. Global instances reset `lastIndex` before each loop. */
const ATTRIBUTE_PATTERN = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PHONETIC_PATTERN = /<rPh\b[\s\S]*?<\/rPh>/gi;
const TEXT_RUN_PATTERN = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/gi;
const NEWLINE_PATTERN = /\r\n?/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Compiled `<tag>...</tag>` readers, keyed by tag name. */
const ELEMENT_TEXT_PATTERNS = new Map();

/**
 * @typedef {{
 *   xfNumFmts: number[],
 *   numFmts: Map<number, string>,
 *   date1904?: boolean
 * }} SpreadsheetStyles
 */

/**
 * @typedef {{
 *   name: string,
 *   relId: string,
 *   state: string
 * }} WorkbookSheetInfo
 */

/**
 * @typedef {{
 *   name: string,
 *   method: number,
 *   compressedSize: number,
 *   uncompressedSize: number,
 *   localOffset: number
 * }} ZipEntryInfo
 */

/**
 * @typedef {{
 *   name: string,
 *   rows: string[][],
 *   rowNumbers: number[],
 *   widths: number[],
 *   columnCount: number,
 *   truncatedRows: boolean,
 *   truncatedColumns: boolean,
 *   error?: string | null
 * }} SpreadsheetSheet
 */

/**
 * @typedef {{
 *   kind: "csv" | "xlsx",
 *   delimiter?: string,
 *   delimiterLabel?: string,
 *   sheets: SpreadsheetSheet[],
 *   activeSheet: number,
 *   truncated: boolean
 * }} SpreadsheetWorkbook
 */

/**
 * Clamps a number into an inclusive range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolves a positive limit option, falling back to a default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Decodes the five predefined XML entities plus numeric character references.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeXmlEntities(text) {
  if (typeof text !== "string" || text.indexOf("&") === -1) return text ?? "";
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Reads the attributes of a single XML tag into a plain object.
 *
 * @param {string} tag
 * @returns {Record<string, string>}
 */
function parseAttributes(tag) {
  /** @type {Record<string, string>} */
  const attrs = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_PATTERN.exec(tag))) {
    attrs[match[1]] = decodeXmlEntities(match[3] !== undefined ? match[3] : match[2]);
  }
  return attrs;
}

/**
 * Decodes UTF-8 bytes through the runtime's Buffer implementation.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeUtf8(bytes) {
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Normalizes a ZIP/OOXML path, resolving `.` and `..` segments.
 *
 * @param {string} path
 * @returns {string}
 */
function normalizeZipPath(path) {
  const parts = [];
  for (const part of String(path || "").replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Reads a little-endian uint16 from a byte array.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/**
 * Reads a little-endian uint32 from a byte array.
 *
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Finds the End Of Central Directory record of a ZIP archive.
 *
 * @param {Uint8Array} bytes
 * @returns {number} Offset of the record, or -1 when absent
 */
function findEndOfCentralDirectory(bytes) {
  const stop = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= stop; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

/**
 * Reads the central directory of a ZIP archive into a name-to-entry map.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<string, ZipEntryInfo>}
 */
function readZipEntries(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("Not a valid .xlsx workbook (no ZIP central directory).");

  const entryCount = readU16(bytes, eocd + 10);
  const directoryOffset = readU32(bytes, eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 workbooks are not supported.");
  }

  /** @type {Map<string, ZipEntryInfo>} */
  const entries = new Map();
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readU32(bytes, offset) !== 0x02014b50) {
      throw new Error("This workbook has a damaged ZIP directory.");
    }
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);

    if (flags & 0x0001) throw new Error("Encrypted workbooks are not supported.");

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) throw new Error("This workbook has a damaged ZIP directory.");
    const name = decodeUtf8(bytes.subarray(nameStart, nameEnd));

    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

/**
 * Extracts and inflates one ZIP entry.
 *
 * @param {Uint8Array} bytes
 * @param {ZipEntryInfo} entry
 * @returns {Uint8Array}
 */
function inflateZipEntry(bytes, entry) {
  const localOffset = entry.localOffset;
  if (localOffset + 30 > bytes.length || readU32(bytes, localOffset) !== 0x04034b50) {
    throw new Error("This workbook has a damaged ZIP entry.");
  }
  const nameLength = readU16(bytes, localOffset + 26);
  const extraLength = readU16(bytes, localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error("This workbook has a truncated ZIP entry.");
  if (entry.compressedSize === 0) return new Uint8Array(0);
  if (entry.uncompressedSize > MAX_XML_PART_BYTES) {
    throw new Error("This workbook contains an OOXML part that is too large to preview.");
  }

  if (entry.method === 0) {
    return bytes.slice(dataStart, dataEnd);
  }
  if (entry.method === 8) {
    const inflate = zlib.inflateRawSync;
    if (typeof inflate !== "function") throw new Error("This runtime cannot inflate XLSX workbooks.");
    const inflated = inflate(bytes.subarray(dataStart, dataEnd));
    if (inflated.length > MAX_XML_PART_BYTES) {
      throw new Error("This workbook contains an OOXML part that is too large to preview.");
    }
    return inflated instanceof Uint8Array ? inflated : new Uint8Array(inflated);
  }
  throw new Error(`Unsupported ZIP compression method (${entry.method}).`);
}

/**
 * Turns a stored value into bytes without copying when possible.
 *
 * @param {Uint8Array | ArrayLike<number> | null | undefined} value
 * @returns {Uint8Array | null}
 */
function toBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value.length === "number") {
    try {
      return Uint8Array.from(/** @type {ArrayLike<number>} */ (value));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The display width of text in approximate character cells, counting CJK and
 * emoji as two cells. Used only to size spreadsheet columns.
 *
 * @param {string} text
 * @returns {number}
 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Cleans a spreadsheet cell for one-line table display and caps its size.
 *
 * @param {unknown} value
 * @returns {string}
 */
function capCellText(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text.replace(NEWLINE_PATTERN, "\n").replace(/\n/g, " ");
  text = text.replace(CONTROL_PATTERN, "");
  if (text.length > SPREADSHEET_MAX_CELL_CHARS) {
    text = `${text.slice(0, SPREADSHEET_MAX_CELL_CHARS)}…`;
  }
  return text;
}

/**
 * Chooses the delimiter with the highest unquoted count in the first lines.
 *
 * @param {string} text
 * @returns {"," | ";" | "\t"}
 */
export function detectDelimiter(text) {
  if (typeof text !== "string" || text.length === 0) return ",";
  const candidates = [",", ";", "\t"];
  const counts = new Map(candidates.map((candidate) => [candidate, 0]));
  let inQuotes = false;
  let lines = 0;
  let sampled = 0;

  for (let i = 0; i < text.length && sampled < 65536; i += 1) {
    const ch = text[i];
    sampled += 1;
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        sampled += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes) continue;
    if (ch === "\n" || ch === "\r") {
      lines += 1;
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
        sampled += 1;
      }
      if (lines >= 20) break;
      continue;
    }
    const current = counts.get(/** @type {"," | ";" | "\t"} */ (ch));
    if (current !== undefined) counts.set(/** @type {"," | ";" | "\t"} */ (ch), current + 1);
  }

  let best = /** @type {"," | ";" | "\t"} */ (",");
  let bestCount = counts.get(best) || 0;
  for (const candidate of candidates) {
    const count = counts.get(/** @type {"," | ";" | "\t"} */ (candidate)) || 0;
    if (count > bestCount) {
      best = /** @type {"," | ";" | "\t"} */ (candidate);
      bestCount = count;
    }
  }
  return best;
}

/**
 * A human label for a CSV delimiter.
 *
 * @param {string} delimiter
 * @returns {string}
 */
export function delimiterLabel(delimiter) {
  if (delimiter === ";") return "Semicolon";
  if (delimiter === "\t") return "Tab";
  if (delimiter === "|") return "Pipe";
  return "Comma";
}

/**
 * Removes trailing empty columns, caps the width, and pads every row so row
 * rendering can index cells without bounds checks.
 *
 * @param {string[][]} rows
 * @param {number} maxColumns
 * @returns {number}
 */
function shapeRows(rows, maxColumns) {
  let columnCount = 0;
  for (const row of rows) {
    columnCount = Math.max(columnCount, Math.min(row.length, maxColumns));
  }
  while (columnCount > 0 && rows.every((row) => (row[columnCount - 1] ?? "") === "")) {
    columnCount -= 1;
  }
  for (const row of rows) {
    if (row.length > columnCount) row.length = columnCount;
    while (row.length < columnCount) row.push("");
  }
  return columnCount;
}

/**
 * Sizes each column from up to 200 sampled rows, clamped to a readable width.
 *
 * @param {string[][]} rows
 * @param {number} columnCount
 * @returns {number[]}
 */
export function computeColumnWidths(rows, columnCount) {
  const widths = [];
  const sampleRows = Math.min(rows.length, 200);
  for (let column = 0; column < columnCount; column += 1) {
    let maxWidth = 0;
    for (let row = 0; row < sampleRows; row += 1) {
      maxWidth = Math.max(maxWidth, displayWidth(rows[row][column] ?? ""));
    }
    widths.push(clamp(Math.round(18 + maxWidth * 6.6), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH));
  }
  return widths;
}

/**
 * Parses CSV or TSV source into a one-sheet workbook.
 *
 * @param {string} source
 * @param {{ delimiter?: string, extension?: string, maxRows?: number, maxColumns?: number }} [options]
 * @returns {SpreadsheetWorkbook}
 */
export function parseDelimitedText(source, options = {}) {
  const text = typeof source === "string" ? source.replace(/^\uFEFF/, "") : "";
  const extension = String(options.extension || "").toLowerCase();
  const forcedDelimiter = typeof options.delimiter === "string" && options.delimiter.length > 0 ? options.delimiter : null;
  const delimiter = forcedDelimiter || (extension === "tsv" ? "\t" : detectDelimiter(text));
  const maxRows = positiveLimit(options.maxRows, SPREADSHEET_MAX_ROWS);
  const maxColumns = positiveLimit(options.maxColumns, SPREADSHEET_MAX_COLUMNS);

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let column = 0;
  let inQuotes = false;
  let index = 0;
  let truncatedRows = false;
  let truncatedColumns = false;

  const append = (ch) => {
    if (field.length < SPREADSHEET_MAX_CELL_CHARS) field += ch;
  };

  const finishField = () => {
    if (column < maxColumns) {
      row.push(capCellText(field));
    } else {
      truncatedColumns = true;
    }
    field = "";
    column += 1;
  };

  const finishRow = () => {
    finishField();
    if (rows.length < maxRows) {
      rows.push(row);
    } else {
      truncatedRows = true;
    }
    row = [];
    column = 0;
  };

  while (index < text.length) {
    const ch = text[index];

    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          append('"');
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      append(ch);
      index += 1;
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (ch === delimiter) {
      finishField();
      index += 1;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      finishRow();
      if (ch === "\r" && text[index + 1] === "\n") index += 1;
      index += 1;
      if (rows.length >= maxRows) {
        if (/\S/.test(text.slice(index))) truncatedRows = true;
        break;
      }
      continue;
    }

    append(ch);
    index += 1;
  }

  if (index >= text.length && (field !== "" || row.length > 0 || column > 0)) {
    finishRow();
  }

  // A trailing newline must not become a phantom record, and neither should
  // trailing blank lines at the end of the file.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }

  const columnCount = shapeRows(rows, maxColumns);
  const sheet = {
    name: extension === "tsv" ? "TSV" : "CSV",
    rows,
    rowNumbers: rows.map((_row, rowIndex) => rowIndex + 1),
    widths: computeColumnWidths(rows, columnCount),
    columnCount,
    truncatedRows,
    truncatedColumns,
  };

  return {
    kind: "csv",
    delimiter,
    delimiterLabel: delimiterLabel(delimiter),
    sheets: [sheet],
    activeSheet: 0,
    truncated: truncatedRows || truncatedColumns,
  };
}

/**
 * Returns the text content of every `<t>` element inside a shared-string or
 * inline-string fragment, ignoring phonetic run data.
 *
 * @param {string} xml
 * @returns {string}
 */
function collectTextRuns(xml) {
  const withoutPhonetics = String(xml || "").replace(PHONETIC_PATTERN, "");
  let out = "";
  TEXT_RUN_PATTERN.lastIndex = 0;
  let match;
  while ((match = TEXT_RUN_PATTERN.exec(withoutPhonetics))) {
    out += decodeXmlEntities(match[1] ?? "");
  }
  return out;
}

/**
 * Reads `xl/sharedStrings.xml` into an indexed string table.
 *
 * @param {string | null} xml
 * @returns {string[]}
 */
function readSharedStrings(xml) {
  /** @type {string[]} */
  const values = [];
  if (!xml) return values;
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/gi;
  let match;
  while ((match = re.exec(xml))) {
    values.push(collectTextRuns(match[1] ?? ""));
  }
  return values;
}

/**
 * Reads custom number formats and the cell-style number-format index list.
 *
 * @param {string | null} xml
 * @returns {SpreadsheetStyles}
 */
function readStyles(xml) {
  /** @type {SpreadsheetStyles} */
  const styles = { xfNumFmts: [], numFmts: new Map() };
  if (!xml) return styles;

  const numFmtRe = /<numFmt\b([^>]*?)(?:\/>|>[\s\S]*?<\/numFmt>)/gi;
  let match;
  while ((match = numFmtRe.exec(xml))) {
    const attrs = parseAttributes(match[1]);
    const id = Number(attrs.numFmtId);
    if (Number.isFinite(id) && typeof attrs.formatCode === "string") {
      styles.numFmts.set(id, attrs.formatCode);
    }
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/i.exec(xml);
  if (cellXfs) {
    const xfRe = /<xf\b[^>]*>/gi;
    while ((match = xfRe.exec(cellXfs[1]))) {
      const attrs = parseAttributes(match[0]);
      const id = Number(attrs.numFmtId);
      styles.xfNumFmts.push(Number.isFinite(id) ? id : 0);
    }
  }
  return styles;
}

/**
 * Reads the ordered sheet descriptions from `xl/workbook.xml`.
 *
 * @param {string} xml
 * @returns {WorkbookSheetInfo[]}
 */
function readWorkbookSheets(xml) {
  /** @type {WorkbookSheetInfo[]} */
  const sheets = [];
  const block = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/i.exec(xml);
  if (!block) return sheets;

  const re = /<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/gi;
  let match;
  while ((match = re.exec(block[1]))) {
    const attrs = parseAttributes(match[1]);
    sheets.push({
      name: attrs.name || `Sheet ${sheets.length + 1}`,
      relId: attrs["r:id"] || attrs.id || "",
      state: attrs.state || "visible",
    });
  }
  return sheets;
}

/**
 * Reads workbook relationships, keeping only worksheet targets.
 *
 * @param {string | null} xml
 * @returns {Map<string, string>}
 */
function readWorksheetRelationships(xml) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!xml) return map;
  const re = /<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/gi;
  let match;
  while ((match = re.exec(xml))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.Id || !attrs.Target) continue;
    if (attrs.TargetMode === "External") continue;
    if (attrs.Type && !attrs.Type.endsWith("/worksheet")) continue;
    map.set(attrs.Id, attrs.Target);
  }
  return map;
}

/**
 * Removes literals, escapes, colors and spacing hints from a format code.
 *
 * @param {string} code
 * @returns {string}
 */
function cleanFormatCode(code) {
  return String(code || "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\[ -~]/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/_.?/g, "")
    .replace(/\*.?/g, "");
}

/**
 * Derives the display rules for one number format, cached by format id/code.
 *
 * @param {number} numFmtId
 * @param {string} code
 * @returns {{
 *   cleaned: string,
 *   isDate: boolean,
 *   timeOnly: boolean,
 *   showSeconds: boolean,
 *   hasTime: boolean,
 *   decimals: number | null,
 *   grouping: boolean,
 *   scientific: boolean,
 *   percent: boolean,
 *   text: boolean
 * }}
 */
function formatInfo(numFmtId, code) {
  const key = `${numFmtId}\u0000${code}`;
  const cached = FORMAT_INFO_CACHE.get(key);
  if (cached) return cached;

  const cleaned = cleanFormatCode(code);
  const decimalMatch = /\.([0#]+)/.exec(cleaned);
  const info = {
    cleaned,
    isDate:
      (numFmtId >= 14 && numFmtId <= 22) ||
      (numFmtId >= 45 && numFmtId <= 47) ||
      /[ymdhs]/i.test(cleaned),
    timeOnly:
      (numFmtId >= 18 && numFmtId <= 21) ||
      (numFmtId >= 45 && numFmtId <= 47) ||
      (/[hs]/i.test(cleaned) && !/[yd]/i.test(cleaned)),
    showSeconds: /s/i.test(cleaned),
    hasTime: /[hs]/i.test(cleaned),
    decimals: decimalMatch ? Math.min(6, (decimalMatch[1].match(/0/g) || []).length) : null,
    grouping: /#,##|,#/.test(cleaned),
    scientific: /[eE][+-]/.test(code),
    percent: String(code).includes("%"),
    text: numFmtId === 49 || code === "@",
  };
  FORMAT_INFO_CACHE.set(key, info);
  return info;
}

/**
 * Formats a number using the first decimal pattern in a format code.
 *
 * @param {number} value
 * @param {ReturnType<typeof formatInfo>} info
 * @returns {string}
 */
function formatNumberWithCode(value, info) {
  const magnitude = Math.abs(value);
  let text = info.decimals !== null
    ? magnitude.toFixed(info.decimals)
    : String(Math.round(magnitude * 1e10) / 1e10);

  if (info.grouping) {
    const dot = text.indexOf(".");
    const integer = dot >= 0 ? text.slice(0, dot) : text;
    const fraction = dot >= 0 ? text.slice(dot) : "";
    text = `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction}`;
  }

  if (value < 0) {
    if (info.cleaned.includes("(") && info.cleaned.includes(")")) return `(${text})`;
    return `-${text}`;
  }
  return text;
}

/**
 * Formats an Excel serial date/time for display.
 *
 * @param {number} serial
 * @param {ReturnType<typeof formatInfo>} info
 * @param {boolean} [date1904=false]
 * @returns {string}
 */
function formatExcelDate(serial, info, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return String(serial);
  if (date1904) serial += 1462;

  // Excel pretends 1900-02-29 existed; serials before March 1900 need a shift.
  const adjusted = serial < 60 ? serial + 1 : serial;
  const milliseconds = Math.round((adjusted - 25569) * 86400000);
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return String(serial);

  const pad = (value) => String(value).padStart(2, "0");
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();

  if (info.timeOnly) {
    return `${pad(hours)}:${pad(minutes)}${info.showSeconds ? `:${pad(seconds)}` : ""}`;
  }

  let out = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (info.hasTime) {
    out += ` ${pad(hours)}:${pad(minutes)}${info.showSeconds ? `:${pad(seconds)}` : ""}`;
  }
  return out;
}

/**
 * Formats a numeric cell according to its style.
 *
 * @param {string} raw
 * @param {number} styleIndex
 * @param {SpreadsheetStyles} styles
 * @returns {string}
 */
function formatExcelNumber(raw, styleIndex, styles) {
  const value = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(value)) return capCellText(raw);

  const numFmtId = styles.xfNumFmts[styleIndex] ?? 0;
  const code = styles.numFmts.get(numFmtId) ?? BUILTIN_NUMBER_FORMATS[numFmtId] ?? "General";
  const info = formatInfo(numFmtId, code);

  if (info.text) return capCellText(raw);
  if (info.isDate) return formatExcelDate(value, info, styles.date1904 === true);
  if (info.percent) {
    const decimals = info.decimals ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  if (info.scientific) return String(value);
  return formatNumberWithCode(value, info);
}

/**
 * Extracts the `B12` style column index from a cell reference.
 *
 * @param {string} ref
 * @returns {number | null} Zero-based column, or null when the reference is absent
 */
function columnFromReference(ref) {
  const match = /^([A-Za-z]+)/.exec(String(ref || ""));
  if (!match) return null;
  let column = 0;
  for (const ch of match[1].toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, column - 1);
}

/**
 * Reads a single element's text, including self-closing empties.
 *
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function readElementText(xml, tag) {
  let pattern = ELEMENT_TEXT_PATTERNS.get(tag);
  if (!pattern) {
    pattern = new RegExp(`<${tag}\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, "i");
    ELEMENT_TEXT_PATTERNS.set(tag, pattern);
  }
  const match = pattern.exec(xml || "");
  return match ? decodeXmlEntities(match[1] ?? "") : "";
}

/**
 * Converts one `<c>` element into display text.
 *
 * @param {Record<string, string>} attrs
 * @param {string} content
 * @param {string[]} sharedStrings
 * @param {SpreadsheetStyles} styles
 * @returns {string}
 */
function readCellValue(attrs, content, sharedStrings, styles) {
  const type = attrs.t || "n";
  const styleIndex = Number(attrs.s ?? 0) || 0;

  if (type === "s") {
    const index = Number.parseInt(readElementText(content, "v"), 10);
    return capCellText(Number.isFinite(index) ? sharedStrings[index] ?? "" : "");
  }

  if (type === "inlineStr") {
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/i.exec(content || "");
    return capCellText(collectTextRuns(inline ? inline[1] : content));
  }

  if (type === "str") {
    return capCellText(readElementText(content, "v"));
  }

  if (type === "b") {
    const raw = readElementText(content, "v");
    if (raw === "") return "";
    return raw === "1" ? "TRUE" : "FALSE";
  }

  if (type === "e") {
    return capCellText(readElementText(content, "v"));
  }

  if (type === "d") {
    return capCellText(readElementText(content, "v").replace("T", " ").replace(/(\.\d+)?Z$/, ""));
  }

  const raw = readElementText(content, "v");
  if (raw === "") return "";
  return capCellText(formatExcelNumber(raw, styleIndex, styles));
}

/**
 * Parses one worksheet part into shaped rows.
 *
 * @param {string} xml
 * @param {string[]} sharedStrings
 * @param {SpreadsheetStyles} styles
 * @returns {{ rows: string[][], rowNumbers: number[], columnCount: number, truncatedRows: boolean, truncatedColumns: boolean }}
 */
function parseWorksheet(xml, sharedStrings, styles) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {number[]} */
  const rowNumbers = [];
  let truncatedRows = false;
  let truncatedColumns = false;
  let lastRowNumber = 0;

  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/i.exec(xml);
  if (!sheetData) {
    return { rows, rowNumbers, columnCount: 0, truncatedRows, truncatedColumns };
  }

  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(sheetData[1]))) {
    if (rows.length >= SPREADSHEET_MAX_ROWS) {
      truncatedRows = true;
      break;
    }

    const rowAttrs = parseAttributes(rowMatch[1]);
    let rowNumber = Number(rowAttrs.r);
    if (!Number.isFinite(rowNumber) || rowNumber <= 0) rowNumber = lastRowNumber + 1;
    if (rowNumber <= lastRowNumber) rowNumber = lastRowNumber + 1;

    // Preserve modest gaps so data keeps its visual position, but never let a
    // stray cell on row 1,000,000 allocate a million empty rows.
    if (lastRowNumber > 0) {
      const gap = rowNumber - lastRowNumber - 1;
      if (gap > 0 && gap <= 50 && rows.length + gap < SPREADSHEET_MAX_ROWS) {
        for (let blank = 0; blank < gap; blank += 1) {
          rows.push([]);
          rowNumbers.push(lastRowNumber + blank + 1);
        }
      }
    }
    lastRowNumber = rowNumber;

    /** @type {string[]} */
    const cells = [];
    let nextColumn = 0;
    const content = rowMatch[2] || "";
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi;
    let cellMatch;

    while ((cellMatch = cellRe.exec(content))) {
      const cellAttrs = parseAttributes(cellMatch[1]);
      let column = columnFromReference(cellAttrs.r);
      if (column === null) column = nextColumn;
      nextColumn = column + 1;

      if (column >= SPREADSHEET_MAX_COLUMNS) {
        truncatedColumns = true;
        continue;
      }
      while (cells.length < column) cells.push("");
      cells[column] = readCellValue(cellAttrs, cellMatch[2] || "", sharedStrings, styles);
    }

    rows.push(cells);
    rowNumbers.push(rowNumber);
  }

  // Drop trailing all-empty rows and columns so a stray styled cell does not
  // leave a field of blank table behind the data.
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === "")) {
    rows.pop();
    rowNumbers.pop();
  }

  const columnCount = shapeRows(rows, SPREADSHEET_MAX_COLUMNS);
  return { rows, rowNumbers, columnCount, truncatedRows, truncatedColumns };
}

/**
 * Reads an XLSX/XLSM workbook from its raw bytes.
 *
 * @param {Uint8Array | ArrayLike<number>} input
 * @returns {SpreadsheetWorkbook}
 */
export function parseXlsxWorkbook(input) {
  const bytes = toBytes(input);
  if (!bytes || bytes.length === 0) throw new Error("This workbook is empty.");
  if (bytes.length > MAX_WORKBOOK_BYTES) throw new Error("This workbook is too large to preview.");
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error("Encrypted workbooks are not supported.");
  }

  const entries = readZipEntries(bytes);
  if (entries.size === 0) throw new Error("Not a valid .xlsx workbook (empty ZIP archive).");

  /** @type {Map<string, Uint8Array>} */
  const inflated = new Map();
  /** @param {string} name */
  const getBytes = (name) => {
    const cached = inflated.get(name);
    if (cached) return cached;
    const entry = entries.get(name);
    if (!entry) return null;
    const data = inflateZipEntry(bytes, entry);
    inflated.set(name, data);
    return data;
  };
  /** @param {string} name */
  const getXml = (name) => {
    const data = getBytes(name);
    return data ? decodeUtf8(data) : null;
  };

  const workbookXml = getXml("xl/workbook.xml");
  if (!workbookXml) throw new Error("This workbook does not contain xl/workbook.xml.");

  const workbookSheets = readWorkbookSheets(workbookXml);
  const relationships = readWorksheetRelationships(getXml("xl/_rels/workbook.xml.rels"));
  const sharedStrings = readSharedStrings(getXml("xl/sharedStrings.xml"));
  const styles = readStyles(getXml("xl/styles.xml"));
  styles.date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["']1["']/i.test(workbookXml);

  const worksheetNames = Array.from(entries.keys())
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(/(\d+)\.xml$/i.exec(a)?.[1] ?? 0);
      const nb = Number(/(\d+)\.xml$/i.exec(b)?.[1] ?? 0);
      return na - nb || a.localeCompare(b);
    });

  /** @type {SpreadsheetSheet[]} */
  const sheets = [];
  for (let index = 0; index < workbookSheets.length; index += 1) {
    const info = workbookSheets[index];
    let sheetName = null;
    const target = relationships.get(info.relId);
    if (target) {
      const resolved = target.startsWith("/")
        ? normalizeZipPath(target)
        : normalizeZipPath(`xl/${target}`);
      if (entries.has(resolved)) sheetName = resolved;
    }
    if (!sheetName && worksheetNames[index]) sheetName = worksheetNames[index];

    if (!sheetName) {
      sheets.push({
        name: info.name,
        rows: [],
        rowNumbers: [],
        widths: [],
        columnCount: 0,
        truncatedRows: false,
        truncatedColumns: false,
        error: "This worksheet is missing from the workbook.",
      });
      continue;
    }

    try {
      const xml = getXml(sheetName);
      if (!xml) throw new Error("empty worksheet");
      const parsed = parseWorksheet(xml, sharedStrings, styles);
      sheets.push({
        name: info.name,
        rows: parsed.rows,
        rowNumbers: parsed.rowNumbers,
        widths: computeColumnWidths(parsed.rows, parsed.columnCount),
        columnCount: parsed.columnCount,
        truncatedRows: parsed.truncatedRows,
        truncatedColumns: parsed.truncatedColumns,
      });
    } catch (error) {
      sheets.push({
        name: info.name,
        rows: [],
        rowNumbers: [],
        widths: [],
        columnCount: 0,
        truncatedRows: false,
        truncatedColumns: false,
        error: error instanceof Error ? error.message : "Could not read this worksheet.",
      });
    }
  }

  const workbookView = /<workbookView\b[^>]*>/i.exec(workbookXml);
  const activeTab = workbookView ? Number(parseAttributes(workbookView[0]).activeTab) : 0;
  const activeSheet = Number.isFinite(activeTab)
    ? clamp(Math.floor(activeTab), 0, Math.max(0, sheets.length - 1))
    : 0;

  return {
    kind: "xlsx",
    sheets,
    activeSheet,
    truncated: sheets.some((sheet) => sheet.truncatedRows || sheet.truncatedColumns),
  };
}

/**
 * Finds the columns intersecting a horizontal viewport. The returned `offset`
 * is how far the first visible column is scrolled out of view.
 *
 * @param {number[]} widths
 * @param {number} scrollX
 * @param {number} viewportWidth
 * @returns {{ start: number, end: number, offset: number }}
 */
export function visibleColumnRange(widths, scrollX, viewportWidth) {
  const count = widths.length;
  if (count === 0) return { start: 0, end: 0, offset: 0 };

  const target = Math.max(0, scrollX || 0);
  let start = 0;
  let cumulative = 0;
  while (start < count - 1 && cumulative + widths[start] <= target) {
    cumulative += widths[start];
    start += 1;
  }
  const offset = Math.max(0, target - cumulative);

  let end = start;
  let used = -offset;
  while (end < count && used < viewportWidth) {
    used += widths[end];
    end += 1;
  }
  if (end === start) end = Math.min(count, start + 1);
  return { start, end, offset };
}

/**
 * Finds the rows intersecting a vertical viewport. The returned `offset` is
 * how far the first rendered row is scrolled out of view.
 *
 * @param {number} rowCount
 * @param {number} scrollY
 * @param {number} viewportHeight
 * @param {number} rowHeight
 * @param {number} [overscan=2]
 * @returns {{ start: number, end: number, offset: number }}
 */
export function visibleRowRange(rowCount, scrollY, viewportHeight, rowHeight, overscan = 2) {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0, offset: 0 };
  const target = Math.max(0, scrollY || 0);
  const first = Math.floor(target / rowHeight);
  const start = Math.max(0, first - overscan);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + overscan * 2 + 1;
  const end = Math.min(rowCount, start + visible);
  return { start, end, offset: target - start * rowHeight };
}
