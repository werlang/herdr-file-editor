/**
 * Pure helpers for the in-editor Find widget and the Files pane SEARCH section.
 *
 * Everything here is deterministic and free of GPUI/Herdr calls so it can be
 * unit-tested with Node's test runner. UI wiring lives in find-view.js, and the
 * view lifecycle lives in main.js.
 */

import { splitPathInfo } from "./file-logic.js";

/** Maximum matches the in-editor find engine keeps for one query. */
export const FIND_MATCH_CAP = 5000;

/** Maximum match rows a Files pane search keeps. */
export const SEARCH_MATCH_CAP = 2000;

/** Maximum files a Files pane search groups before it reports a limited result. */
export const SEARCH_FILE_CAP = 200;

/** Default height of one line in the read-only find view, in pixels. */
export const FIND_LINE_HEIGHT = 20;

/** Default visible context around a match in a Files pane result row. */
export const SEARCH_CONTEXT_CHARS = 180;

/**
 * Escapes a literal string so it can be embedded in a regular expression.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalizes the option bag accepted by the match engine and the search widget.
 *
 * @param {{
 *   caseSensitive?: boolean,
 *   wholeWord?: boolean,
 *   regex?: boolean,
 *   cap?: number,
 * }} [options]
 * @returns {{ caseSensitive: boolean, wholeWord: boolean, regex: boolean, cap: number }}
 */
export function normalizeFindOptions(options = {}) {
  const rawCap = Number(options?.cap);
  return {
    caseSensitive: options?.caseSensitive === true,
    wholeWord: options?.wholeWord === true,
    regex: options?.regex === true,
    cap: Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : FIND_MATCH_CAP,
  };
}

/**
 * Builds the global regular expression behind one find query.
 *
 * Literal mode escapes the query; regex mode passes it through. Whole-word
 * mode is applied per match by `findMatches` (rather than wrapped here) so the
 * source never depends on lookbehind support in the host's JS engine. Invalid
 * regular expressions are reported instead of thrown, so a half-typed pattern
 * never breaks the UI.
 *
 * @param {string} query
 * @param {{
 *   caseSensitive?: boolean,
 *   wholeWord?: boolean,
 *   regex?: boolean,
 * }} [options]
 * @returns {{
 *   empty: boolean,
 *   valid: boolean,
 *   error: string | null,
 *   source: string,
 *   flags: string,
 *   regex: RegExp | null,
 * }}
 */
export function buildFindRegExp(query, options = {}) {
  const opts = normalizeFindOptions(options);
  const raw = typeof query === "string" ? query : "";
  if (raw.length === 0) {
    return { empty: true, valid: true, error: null, source: "", flags: "", regex: null };
  }

  const body = opts.regex ? raw : escapeRegExp(raw);
  // Whole-word is built with a leading non-word boundary wrapped in a capture
  // group and a trailing lookahead. This avoids lookbehind (not every embedded
  // JS engine supports it) and, unlike a post-filter, lets the engine backtrack
  // from `foo` to `foobar` in an alternation so both remain whole-word matches.
  const source = opts.wholeWord ? `(?:^|\\W)(${body})(?=\\W|$)` : body;
  // `m` makes ^ and $ match line boundaries in regex mode, matching VS Code.
  const flags = opts.caseSensitive ? "gm" : "gim";
  try {
    return {
      empty: false,
      valid: true,
      error: null,
      source,
      flags,
      regex: new RegExp(source, flags),
    };
  } catch (err) {
    return {
      empty: false,
      valid: false,
      error: err?.message || "Invalid regular expression",
      source,
      flags,
      regex: null,
    };
  }
}

/**
 * Offsets at which each line starts. Used to turn a string index into a line
 * and column without rescanning the whole document for every match.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function buildLineStarts(text) {
  const starts = [0];
  const raw = typeof text === "string" ? text : "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * Finds the zero-based line containing a string index.
 *
 * @param {number[]} lineStarts
 * @param {number} index
 * @returns {number}
 */
export function lineIndexAt(lineStarts, index) {
  if (!Array.isArray(lineStarts) || lineStarts.length === 0) return 0;
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

/**
 * Finds every non-empty match of a query in text.
 *
 * Each match carries its absolute index, line, column, line text and a stable
 * id, which is what the read-only find view uses to highlight the current
 * occurrence. Empty regex matches are skipped so a pattern such as `^` cannot
 * loop forever. Whole-word mode wraps the body in boundary groups, so the
 * engine can still backtrack through alternatives.
 *
 * @param {string} text
 * @param {string} query
 * @param {{
 *   caseSensitive?: boolean,
 *   wholeWord?: boolean,
 *   regex?: boolean,
 *   cap?: number,
 * }} [options]
 * @returns {{
 *   empty: boolean,
 *   valid: boolean,
 *   error: string | null,
 *   matches: Array<{
 *     id: number,
 *     index: number,
 *     length: number,
 *     line: number,
 *     column: number,
 *     text: string,
 *     lineText: string,
 *   }>,
 *   limited: boolean,
 * }}
 */
export function findMatches(text, query, options = {}) {
  const opts = normalizeFindOptions(options);
  const raw = typeof text === "string" ? text : "";
  const built = buildFindRegExp(query, opts);
  if (built.empty) {
    return { empty: true, valid: true, error: null, matches: [], limited: false };
  }
  if (!built.valid || !built.regex) {
    return { empty: false, valid: false, error: built.error, matches: [], limited: false };
  }

  const regex = built.regex;
  const lineStarts = buildLineStarts(raw);
  const lines = raw.split("\n");
  const matches = [];
  let limited = false;
  let match;

  while ((match = regex.exec(raw)) !== null) {
    const matchedText = opts.wholeWord ? match[1] ?? "" : match[0];
    const index = opts.wholeWord ? match.index + match[0].length - matchedText.length : match.index;
    if (matchedText.length === 0) {
      regex.lastIndex += 1;
      if (regex.lastIndex > raw.length) break;
      continue;
    }
    if (matches.length >= opts.cap) {
      limited = true;
      break;
    }
    const line = lineIndexAt(lineStarts, index);
    matches.push({
      id: matches.length,
      index,
      length: matchedText.length,
      line,
      column: index - lineStarts[line],
      text: matchedText,
      lineText: lines[line] ?? "",
    });
  }

  return { empty: false, valid: true, error: null, matches, limited };
}

/**
 * Steps to the next or previous match with wrap-around.
 *
 * @param {number} current Zero-based current match, or -1 when nothing is current.
 * @param {number} total Match count.
 * @param {1 | -1} [direction=1]
 * @returns {number} The new zero-based index, or -1 when there are no matches.
 */
export function stepMatchIndex(current, total, direction = 1) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (count === 0) return -1;
  const pos = Number.isFinite(current) ? Math.floor(current) : -1;
  if (direction < 0) {
    return pos <= 0 ? count - 1 : Math.min(count - 1, pos - 1);
  }
  return pos < 0 || pos >= count - 1 ? 0 : pos + 1;
}

/**
 * Picks the first match at or after a requested zero-based line. Used by the
 * `find: { ..., line }` prop when a search result opens its file; the caller
 * converts the 1-based search line to this zero-based coordinate.
 *
 * @param {Array<{ line: number }>} matches
 * @param {number | null | undefined} line Zero-based line.
 * @returns {number} Zero-based match index, or -1 for no matches.
 */
export function findMatchIndexAtLine(matches, line) {
  if (!Array.isArray(matches) || matches.length === 0) return -1;
  const wanted = Number.isFinite(line) ? Math.max(0, Math.floor(line)) : 0;
  const index = matches.findIndex((match) => match.line >= wanted);
  return index >= 0 ? index : 0;
}

/**
 * The counter label shown beside the find input.
 *
 * @param {number} current
 * @param {number} total
 * @param {{ empty?: boolean, valid?: boolean, limited?: boolean }} [state]
 * @returns {string}
 */
export function describeFindCounter(current, total, state = {}) {
  if (state.valid === false) return "Invalid regex";
  if (state.empty) return "";
  if (!Number.isFinite(total) || total <= 0) return "No results";
  const pos = Math.max(1, Math.min(total, (Number(current) || 0) + 1));
  return `${pos} of ${total}${state.limited ? "+" : ""}`;
}

/**
 * Splits one line into plain and highlighted runs for the find view.
 *
 * @param {string} lineText
 * @param {Array<{ id: number, line: number, column: number, length: number }>} matches
 * @param {number} line
 * @param {number} currentId
 * @returns {Array<{ text: string, highlight: boolean, current: boolean }>}
 */
export function lineMatchSegments(lineText, matches, line, currentId) {
  const text = typeof lineText === "string" ? lineText : "";
  const result = [];
  let cursor = 0;

  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || match.line !== line) continue;
    const start = Math.max(0, Math.min(text.length, match.column));
    const end = Math.max(start, Math.min(text.length, start + Math.max(0, match.length)));
    if (end <= start) continue;
    if (start > cursor) {
      result.push({ text: text.slice(cursor, start), highlight: false, current: false });
    }
    result.push({ text: text.slice(start, end), highlight: true, current: match.id === currentId });
    cursor = Math.max(cursor, end);
  }

  if (cursor < text.length) {
    result.push({ text: text.slice(cursor), highlight: false, current: false });
  }
  if (result.length === 0) {
    result.push({ text, highlight: false, current: false });
  }
  return result;
}

/**
 * Trims a long result line around a match and reports where the highlight sits
 * inside the returned text.
 *
 * @param {string} lineText
 * @param {number} column
 * @param {number} length
 * @param {number} [maxLength=SEARCH_CONTEXT_CHARS]
 * @returns {{
 *   text: string,
 *   matchStart: number,
 *   matchLength: number,
 *   leadingEllipsis: boolean,
 *   trailingEllipsis: boolean,
 * }}
 */
export function trimMatchContext(lineText, column, length, maxLength = SEARCH_CONTEXT_CHARS) {
  const raw = typeof lineText === "string" ? lineText.replace(/\r$/, "") : "";
  const max = Number.isFinite(maxLength) && maxLength > 8 ? Math.floor(maxLength) : SEARCH_CONTEXT_CHARS;
  const safeColumn = Math.max(0, Math.min(raw.length, Number(column) || 0));
  const safeLength = Math.max(0, Math.min(raw.length - safeColumn, Number(length) || 0));
  if (raw.length <= max) {
    return {
      text: raw,
      matchStart: safeColumn,
      matchLength: safeLength,
      leadingEllipsis: false,
      trailingEllipsis: false,
    };
  }

  const before = Math.max(12, Math.floor((max - safeLength) / 3));
  let start = Math.max(0, safeColumn - before);
  let end = Math.min(raw.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  const matchStart = Math.max(0, safeColumn - start);
  const visibleLength = Math.max(0, Math.min(safeLength, end - safeColumn));

  return {
    text: raw.slice(start, end),
    matchStart,
    matchLength: visibleLength,
    leadingEllipsis: start > 0,
    trailingEllipsis: end < raw.length,
  };
}

/**
 * Splits a comma-separated include/exclude field into trimmed globs.
 *
 * @param {string | string[] | null | undefined} value
 * @returns {string[]}
 */
export function parseGlobList(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  return source.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * Converts a VS Code-style glob into a regular expression.
 *
 * `*` matches within a path segment, `**` matches across segments, `?` matches
 * one non-separator character, and `{a,b}` alternates. A glob without a slash
 * matches the base name at any depth, which is how `*.js` behaves in VS Code.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const raw = String(glob ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  const hasSlash = raw.includes("/");
  const isBareName = !hasSlash && !/[*?{[]/.test(raw);
  let source = "";
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "*") {
      if (raw[i + 1] === "*") {
        if (raw[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
          continue;
        }
        source += ".*";
        i += 2;
        continue;
      }
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = raw.indexOf("}", i + 1);
      if (close > i) {
        const alternatives = raw
          .slice(i + 1, close)
          .split(",")
          .map((part) => escapeRegExp(part))
          .join("|");
        source += `(?:${alternatives})`;
        i = close + 1;
        continue;
      }
    }
    source += escapeRegExp(ch);
    i += 1;
  }

  const prefix = hasSlash ? "^" : "(?:^|/)";
  const suffix = isBareName ? "(?:/|$)" : "$";
  try {
    return new RegExp(`${prefix}${source}${suffix}`);
  } catch {
    return new RegExp("a^");
  }
}

/**
 * Tests whether a relative file path matches a glob.
 *
 * @param {string} filePath
 * @param {string} glob
 * @returns {boolean}
 */
export function matchesGlob(filePath, glob) {
  const path = normalizeSearchPath(filePath);
  if (!path) return false;
  return globToRegExp(glob).test(path);
}

/**
 * Applies comma-separated include and exclude globs to raw search rows.
 *
 * Includes are OR-ed; excludes win. An empty include list means "everything".
 *
 * @param {Array<{ file: string }>} rows
 * @param {{ include?: string | string[], exclude?: string | string[] }} [globs]
 * @returns {Array<{ file: string }>}
 */
export function filterSearchRowsByGlobs(rows, globs = {}) {
  const include = parseGlobList(globs.include);
  const exclude = parseGlobList(globs.exclude);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const file = normalizeSearchPath(row?.file);
    if (!file) return false;
    if (include.length > 0 && !include.some((glob) => matchesGlob(file, glob))) return false;
    if (exclude.some((glob) => matchesGlob(file, glob))) return false;
    return true;
  });
}

/**
 * Expands one VS Code-style glob into the pattern(s) a search tool needs.
 * A bare name such as `src` or `README.md` means that folder or file at any
 * depth, which needs both the descendant and the node itself.
 *
 * @param {string} glob
 * @returns {string[]}
 */
export function searchGlobVariants(glob) {
  const raw = String(glob ?? "").trim().replace(/^!+/, "");
  if (!raw) return [];
  if (raw.includes("/") || /[*?{[]/.test(raw)) return [raw];
  return [`**/${raw}/**`, `**/${raw}`];
}

/**
 * Builds the ripgrep argument vector for a search. The caps are deliberately
 * low enough to keep one pathological file from stalling the UI: at most 1,000
 * columns per line, 2 MiB per file and 200 matches per file.
 *
 * @param {{
 *   query: string,
 *   caseSensitive?: boolean,
 *   wholeWord?: boolean,
 *   regex?: boolean,
 *   include?: string[],
 *   exclude?: string[],
 * }} options
 * @returns {string[]}
 */
export function buildRipgrepArgs(options) {
  const args = [
    "--json",
    "--line-number",
    "--color",
    "never",
    "--no-heading",
    "--max-columns",
    "1000",
    "--max-columns-preview",
    "--max-filesize",
    "2M",
    "--max-count",
    "200",
  ];
  if (options.caseSensitive !== true) args.push("-i");
  if (options.wholeWord === true) args.push("-w");
  if (options.regex !== true) args.push("--fixed-strings");
  for (const glob of Array.isArray(options.include) ? options.include : []) {
    for (const variant of searchGlobVariants(glob)) args.push("--glob", variant);
  }
  for (const glob of Array.isArray(options.exclude) ? options.exclude : []) {
    for (const variant of searchGlobVariants(glob)) args.push("--glob", `!${variant}`);
  }
  args.push("-e", String(options.query ?? ""), ".");
  return args;
}

/**
 * Builds the grep fallback argument vector. NUL separators (`--null`) keep
 * paths containing `:digits:` intact, `-I` skips binary files and `-m 200`
 * bounds each file. Include/exclude globs without a slash are passed straight
 * to grep; slash-bearing globs are applied afterwards, before the match cap.
 *
 * @param {{
 *   query: string,
 *   caseSensitive?: boolean,
 *   wholeWord?: boolean,
 *   regex?: boolean,
 *   include?: string[],
 *   exclude?: string[],
 * }} options
 * @returns {string[]}
 */
export function buildGrepArgs(options) {
  const args = ["-rn", "-I", "--null", "-m", "200"];
  if (options.caseSensitive !== true) args.push("-i");
  if (options.wholeWord === true) args.push("-w");
  args.push(options.regex === true ? "-E" : "-F", "-e", String(options.query ?? ""));
  args.push("--exclude-dir=.git", "--exclude-dir=node_modules");

  const simple = (glob) => !String(glob ?? "").includes("/");
  const fileLike = (glob) => /[*?{[]/.test(glob) || String(glob).includes(".");
  for (const glob of Array.isArray(options.include) ? options.include : []) {
    // A bare folder name (`src`) must not become --include=src: grep would
    // then search only a file literally named src. It is applied by the
    // post-filter instead.
    if (simple(glob) && fileLike(glob)) args.push(`--include=${glob}`);
  }
  for (const glob of Array.isArray(options.exclude) ? options.exclude : []) {
    if (!simple(glob)) continue;
    args.push(`--exclude=${glob}`);
    args.push(`--exclude-dir=${glob}`);
  }
  args.push(".");
  return args;
}

/**
 * Shortens arbitrary process stderr into one readable line.
 *
 * @param {string} text
 * @param {number} [max=220]
 * @returns {string}
 */
function compactErrorText(text, max = 220) {
  const compact = String(text ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/**
 * Turns raw rg/grep stderr into a message the search panel can show. Regex
 * dialect failures get a stable, user-facing prefix instead of a raw dump.
 *
 * @param {string} stderr
 * @param {boolean} [regexMode=false]
 * @returns {string | null}
 */
export function formatSearchError(stderr, regexMode = false) {
  const compact = compactErrorText(stderr);
  if (!compact) return null;
  const regexFailure =
    /regex parse error|error parsing regex|invalid regular expression|unrecognized character|look-around|look-around, including look-ahead|backreference/i.test(
      compact
    );
  if (regexMode && regexFailure) {
    const detail = compact.replace(/^.*?regex parse error:?\s*/i, "").trim();
    return `Regex not supported by search: ${detail || compact}`;
  }
  return compact;
}

/**
 * Interprets a search tool's exit code and parsed rows. Exit 2 usually means a
 * partial read error; if the tool still produced matches, they are usable and
 * the stderr becomes a dim warning instead of throwing the result away.
 *
 * @param {number} code
 * @param {number} rowCount
 * @param {string} stderr
 * @param {boolean} [regexMode=false]
 * @returns {{ error: string | null, warning: string | null }}
 */
export function classifySearchResult(code, rowCount, stderr, regexMode = false) {
  if (code === 0 || code === 1) return { error: null, warning: null };
  const message = formatSearchError(stderr, regexMode) || "Search failed";
  if (rowCount > 0) return { error: null, warning: message };
  return { error: message, warning: null };
}

/**
 * Character offset that brings a match column into view in the read-only find
 * view. The line-number gutter stays fixed; the visible text is sliced from
 * this column, which is cheaper and more reliable than shifting a laid-out row.
 *
 * @param {number} column Zero-based match column.
 * @param {number} viewportWidth
 * @param {number} [charWidth=7.4] Approximate monospace character width in px.
 * @param {number} [gutter=48]
 * @param {number} [rightPad=24]
 * @returns {number} Number of characters to trim from the line start.
 */
export function findHorizontalOffset(column, viewportWidth, charWidth = 7.4, gutter = 48, rightPad = 24) {
  const width = Math.max(1, Number(viewportWidth) || 800);
  const available = Math.max(1, width - gutter - rightPad);
  const visibleChars = Math.max(1, Math.floor(available / Math.max(0.1, Number(charWidth) || 7.4)));
  const col = Math.max(0, Math.floor(Number(column) || 0));
  if (col < visibleChars) return 0;
  return Math.max(0, col - Math.floor(visibleChars * 0.25));
}

/** How long a pending-find record is allowed to live, in milliseconds. */
export const PENDING_FIND_TTL_MS = 15000;

/**
 * Whether a `shared("file-editor.pendingFind")` record should be consumed by
 * this file tab. Records are single-use and expire quickly so a stale one does
 * not re-open find in a later tab.
 *
 * @param {unknown} pending
 * @param {string} fileKey
 * @param {number | null | undefined} lastTimestamp
 * @param {number} [now=Date.now()]
 * @param {number} [ttl=PENDING_FIND_TTL_MS]
 * @returns {boolean}
 */
export function shouldConsumePendingFind(pending, fileKey, lastTimestamp, now = Date.now(), ttl = PENDING_FIND_TTL_MS) {
  if (!pending || typeof pending !== "object") return false;
  if (pending.fileKey !== fileKey || !pending.find) return false;
  const timestamp = Number(pending.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  if (lastTimestamp && timestamp === lastTimestamp) return false;
  const age = now - timestamp;
  return age >= -1000 && age <= Math.max(0, ttl);
}

/**
 * Stable signature for a find prop, used to apply the prop only once per file
 * tab even when the view re-initializes on a tab switch.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function findPropSignature(raw) {
  const find = normalizeFindProp(raw);
  if (!find) return null;
  return JSON.stringify([find.query, find.caseSensitive, find.wholeWord, find.regex, find.line, find.at]);
}

/**
 * Normalizes a path reported by a search tool into a relative, forward-slash
 * path suitable for `openFileTab`.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizeSearchPath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Decodes the text/bytes pair rg uses for paths and line contents.
 *
 * @param {{ text?: string, bytes?: string } | null | undefined} value
 * @returns {string}
 */
function rgText(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") {
    try {
      return Buffer.from(value.bytes, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Converts one of ripgrep's UTF-8 byte offsets into a JavaScript UTF-16 code
 * unit offset. rg reports submatch positions in bytes; slicing a JS string with
 * them would shift highlights on any line with non-ASCII text.
 *
 * The encoded line and its ASCII flag are precomputed once per match event, and
 * ASCII lines (the overwhelmingly common case) need no conversion at all.
 *
 * @param {Buffer} bytes UTF-8 encoding of the line.
 * @param {number} offset Byte offset reported by rg.
 * @param {boolean} ascii True when byte and UTF-16 offsets are identical.
 * @param {number} textLength Length of the decoded line.
 * @param {Uint32Array | null} byteMap Cumulative bytes at each code unit.
 * @returns {number}
 */
function byteOffsetToCodeUnit(bytes, offset, ascii, textLength, byteMap) {
  const safe = Math.max(0, Math.min(bytes.length, Number(offset) || 0));
  if (ascii) return safe;
  if (byteMap && safe <= byteMap[byteMap.length - 1]) {
    let low = 0;
    let high = byteMap.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (byteMap[mid] < safe) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  return bytes.subarray(0, safe).toString("utf8").length;
}

/**
 * Builds the cumulative UTF-8 byte offset at each UTF-16 code unit of a line.
 * Used once per non-ASCII line, so each rg submatch becomes a binary search
 * instead of re-encoding a prefix.
 *
 * @param {string} text
 * @returns {Uint32Array}
 */
function buildByteToUnitMap(text) {
  const map = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const codePoint = text.codePointAt(i) ?? 0;
    if (codePoint > 0xffff) {
      bytes += 4;
      map[i + 1] = bytes;
      i += 1;
      map[i + 1] = bytes;
    } else {
      bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : 3;
      map[i + 1] = bytes;
    }
  }
  return map;
}

/**
 * Parses `rg --json` output into flat match rows.
 *
 * One row is produced per submatch, because the Files pane shows one row per
 * occurrence even when a line has several. Malformed events are skipped:
 * ripgrep may interleave summary/begin/end events or a partial final line.
 *
 * @param {string} stdout
 * @param {{ maxMatches?: number, maxFiles?: number }} [options]
 * @returns {{
 *   rows: Array<{ file: string, line: number, column: number, length: number, text: string }>,
 *   limited: boolean,
 * }}
 */
export function parseRgJson(stdout, options = {}) {
  const maxMatches = Number.isFinite(options.maxMatches) ? Math.max(1, options.maxMatches) : SEARCH_MATCH_CAP;
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(1, options.maxFiles) : SEARCH_FILE_CAP;
  const rows = [];
  const files = new Set();
  let limited = false;

  for (const rawLine of String(stdout ?? "").split("\n")) {
    if (!rawLine.trim()) continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!event || event.type !== "match" || !event.data) continue;

    const file = normalizeSearchPath(rgText(event.data.path));
    if (!file) continue;
    if (!files.has(file)) {
      if (files.size >= maxFiles) {
        limited = true;
        continue;
      }
      files.add(file);
    }

    const line = Math.max(1, Number(event.data.line_number) || 1);
    const text = rgText(event.data.lines).replace(/\r?\n$/, "");
    const lineBytes = Buffer.from(text, "utf8");
    const asciiLine = lineBytes.length === text.length;
    const byteMap = asciiLine ? null : buildByteToUnitMap(text);
    const submatches = Array.isArray(event.data.submatches) ? event.data.submatches : [];
    for (const sub of submatches) {
      if (rows.length >= maxMatches) {
        limited = true;
        break;
      }
      const startBytes = Math.max(0, Number(sub?.start) || 0);
      const endBytes = Math.max(startBytes, Number(sub?.end) || startBytes);
      const start = byteOffsetToCodeUnit(lineBytes, startBytes, asciiLine, text.length, byteMap);
      const end = byteOffsetToCodeUnit(lineBytes, endBytes, asciiLine, text.length, byteMap);
      rows.push({ file, line, column: start, length: Math.max(0, end - start), text });
    }
    if (rows.length >= maxMatches) {
      limited = true;
      break;
    }
  }

  return { rows, limited };
}

/**
 * Parses `grep -rn --null` output into candidate rows.
 *
 * With `--null`, grep writes `path\0line:text`, so a path containing `:12:`
 * cannot be mistaken for the line separator. The colon form is still accepted
 * as a fallback (older greps or a NUL-less transport). `Binary file … matches`
 * notices are ignored.
 *
 * @param {string} stdout
 * @returns {{
 *   rows: Array<{ file: string, line: number, text: string }>,
 *   malformed: number,
 * }}
 */
export function parseGrepOutput(stdout) {
  const rows = [];
  let malformed = 0;
  for (const rawLine of String(stdout ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    if (line.startsWith("Binary file ")) continue;

    let file = "";
    let lineNumber = NaN;
    let text = "";
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      file = line.slice(0, nul);
      const rest = /^(\d+):(.*)$/.exec(line.slice(nul + 1));
      if (rest) {
        lineNumber = Number(rest[1]);
        text = rest[2];
      }
    } else {
      const match = /^(.*?):(\d+):(.*)$/.exec(line);
      if (match) {
        file = match[1];
        lineNumber = Number(match[2]);
        text = match[3];
      }
    }

    if (!file || !Number.isFinite(lineNumber)) {
      malformed += 1;
      continue;
    }
    rows.push({ file: normalizeSearchPath(file), line: lineNumber, text });
  }
  return { rows, malformed };
}

/**
 * Re-runs the JavaScript match engine over grep's candidate lines, which yields
 * exact columns and applies whole-word/case/regex semantics consistently with
 * the in-editor find widget.
 *
 * @param {Array<{ file: string, line: number, text: string }>} rows
 * @param {string} query
 * @param {{ caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean, cap?: number }} [options]
 * @returns {{
 *   rows: Array<{ file: string, line: number, column: number, length: number, text: string }>,
 *   limited: boolean,
 *   valid: boolean,
 *   error: string | null,
 * }}
 */
export function expandGrepRows(rows, query, options = {}) {
  const cap = normalizeFindOptions(options).cap;
  const out = [];
  let limited = false;
  let valid = true;
  let error = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (out.length >= cap) {
      limited = true;
      break;
    }
    const result = findMatches(row.text, query, { ...options, cap: cap - out.length });
    if (!result.valid) {
      valid = false;
      error = result.error;
      break;
    }
    for (const match of result.matches) {
      if (out.length >= cap) {
        limited = true;
        break;
      }
      out.push({ file: row.file, line: row.line, column: match.column, length: match.length, text: row.text });
    }
    if (result.limited) limited = true;
  }

  return { rows: out, limited, valid, error };
}

/**
 * Groups flat match rows by file and applies the result caps.
 *
 * @param {Array<{ file: string, line: number, column: number, length: number, text: string }>} rows
 * @param {{ maxMatches?: number, maxFiles?: number }} [options]
 * @returns {{
 *   groups: Array<{
 *     file: string,
 *     name: string,
 *     dir: string,
 *     count: number,
 *     matches: Array<{ line: number, column: number, length: number, text: string }>,
 *   }>,
 *   totalMatches: number,
 *   totalFiles: number,
 *   limited: boolean,
 * }}
 */
export function groupSearchRows(rows, options = {}) {
  const maxMatches = Number.isFinite(options.maxMatches) ? Math.max(1, options.maxMatches) : SEARCH_MATCH_CAP;
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(1, options.maxFiles) : SEARCH_FILE_CAP;
  const groups = [];
  const byFile = new Map();
  let totalMatches = 0;
  let limited = false;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (totalMatches >= maxMatches) {
      limited = true;
      break;
    }
    const file = normalizeSearchPath(row?.file);
    if (!file) continue;
    let group = byFile.get(file);
    if (!group) {
      if (groups.length >= maxFiles) {
        limited = true;
        continue;
      }
      const { base, dir } = splitPathInfo(file);
      group = { file, name: base, dir, count: 0, matches: [] };
      byFile.set(file, group);
      groups.push(group);
    }
    group.matches.push({
      line: Math.max(1, Number(row.line) || 1),
      column: Math.max(0, Number(row.column) || 0),
      length: Math.max(0, Number(row.length) || 0),
      text: typeof row.text === "string" ? row.text : "",
    });
    group.count += 1;
    totalMatches += 1;
  }

  return { groups, totalMatches, totalFiles: groups.length, limited };
}

/**
 * Flattens grouped results into the uniform row list a virtual list renders:
 * a group header followed by its match rows unless the group is collapsed.
 *
 * @param {Array<{
 *   file: string,
 *   name: string,
 *   dir: string,
 *   count: number,
 *   matches: Array<{ line: number, column: number, length: number, text: string }>,
 * }>} groups
 * @param {Set<string> | string[] | null | undefined} [collapsedFiles]
 * @returns {Array<
 *   { kind: "group", key: string, group: object } |
 *   { kind: "match", key: string, group: object, match: object }
 * >}
 */
export function flattenSearchRows(groups, collapsedFiles) {
  const collapsed =
    collapsedFiles instanceof Set ? collapsedFiles : new Set(Array.isArray(collapsedFiles) ? collapsedFiles : []);
  const rows = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    rows.push({ kind: "group", key: `g:${group.file}`, group });
    if (collapsed.has(group.file)) continue;
    group.matches.forEach((match, index) => {
      rows.push({
        kind: "match",
        key: `m:${group.file}:${match.line}:${match.column}:${index}`,
        group,
        match,
      });
    });
  }
  return rows;
}

/**
 * The summary line shown above search results.
 *
 * @param {{
 *   totalMatches?: number,
 *   totalFiles?: number,
 *   limited?: boolean,
 *   valid?: boolean,
 *   error?: string | null,
 *   query?: string,
 *   running?: boolean,
 * }} [state]
 * @returns {string}
 */
export function formatSearchSummary(state = {}) {
  if (state.running) return "Searching…";
  if (state.valid === false) return "Invalid regex";
  const query = typeof state.query === "string" ? state.query : "";
  if (query.trim().length === 0) return "";
  const matches = Math.max(0, Number(state.totalMatches) || 0);
  const files = Math.max(0, Number(state.totalFiles) || 0);
  if (matches === 0) return state.error ? String(state.error) : "No results found";
  return `${matches} result${matches === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}${
    state.limited ? " (limited)" : ""
  }`;
}

/**
 * Reads the persisted find preferences from shared state.
 *
 * @param {unknown} raw
 * @returns {{ query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean }}
 */
export function normalizeFindPrefs(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    query: typeof value.query === "string" ? value.query : "",
    caseSensitive: value.caseSensitive === true,
    wholeWord: value.wholeWord === true,
    regex: value.regex === true,
  };
}

/**
 * Normalizes a `find` prop into something the editor can consume.
 *
 * @param {unknown} raw
 * @returns {{ query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean, line: number | null } | null}
 */
export function normalizeFindProp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const prefs = normalizeFindPrefs(raw);
  const hasLine = Number.isFinite(raw.line);
  if (prefs.query.length === 0 && !hasLine) return null;
  return {
    ...prefs,
    line: hasLine ? Math.max(1, Math.floor(raw.line)) : null,
    // Per-request nonce: a new search-result click must re-open find even when
    // the same query and line were consumed before for this file.
    at: Number.isFinite(raw.at) ? raw.at : null,
  };
}

/**
 * Normalizes the persisted sidebar section state.
 *
 * @param {unknown} raw
 * @returns {{ explorer: boolean, search: boolean }}
 */
export function normalizeSections(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    explorer: value.explorer !== false,
    search: value.search === true,
  };
}

/**
 * Detects a double-click from two click events on the same virtual-list key.
 * The search list uses keys rather than indices, so this stays correct when
 * results reorder.
 *
 * @param {{ key: string, at: number } | null | undefined} previous
 * @param {string} key
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {boolean}
 */
export function shouldPromoteSearchClick(previous, key, now = Date.now(), windowMs = 500) {
  if (!previous || previous.key !== key) return false;
  return Math.abs(now - previous.at) <= windowMs;
}
