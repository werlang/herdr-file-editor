import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeRegExp,
  normalizeFindOptions,
  buildFindRegExp,
  buildLineStarts,
  lineIndexAt,
  findMatches,
  stepMatchIndex,
  findMatchIndexAtLine,
  describeFindCounter,
  lineMatchSegments,
  trimMatchContext,
  parseGlobList,
  globToRegExp,
  matchesGlob,
  filterSearchRowsByGlobs,
  normalizeSearchPath,
  parseRgJson,
  parseGrepOutput,
  expandGrepRows,
  groupSearchRows,
  flattenSearchRows,
  formatSearchSummary,
  normalizeFindPrefs,
  normalizeFindProp,
  normalizeSections,
  shouldPromoteSearchClick,
  FIND_MATCH_CAP,
  SEARCH_MATCH_CAP,
  SEARCH_FILE_CAP,
} from "../mods/file-editor/find-logic.js";

test("escapeRegExp - escapes every regex metacharacter", () => {
  assert.equal(escapeRegExp("a.b*c+d?e(f)g[h]i{j}k|l\\m^$"), "a\\.b\\*c\\+d\\?e\\(f\\)g\\[h\\]i\\{j\\}k\\|l\\\\m\\^\\$");
  assert.equal(escapeRegExp(""), "");
  assert.equal(escapeRegExp(null), "");
});

test("normalizeFindOptions - defaults and caps", () => {
  assert.deepEqual(normalizeFindOptions(), {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    cap: FIND_MATCH_CAP,
  });
  assert.deepEqual(normalizeFindOptions({ caseSensitive: true, wholeWord: true, regex: true, cap: 7 }), {
    caseSensitive: true,
    wholeWord: true,
    regex: true,
    cap: 7,
  });
  assert.equal(normalizeFindOptions({ cap: -3 }).cap, FIND_MATCH_CAP);
  assert.equal(normalizeFindOptions({ cap: 1.9 }).cap, 1);
});

test("buildFindRegExp - literal, case, whole word, regex, empty and invalid", () => {
  const literal = buildFindRegExp("a.b", {});
  assert.equal(literal.valid, true);
  assert.equal(literal.source, "a\\.b");
  assert.equal(literal.flags, "gi");
  assert.equal(literal.regex.test("a.b"), true);
  assert.equal(literal.regex.test("axb"), false);

  const sensitive = buildFindRegExp("A", { caseSensitive: true });
  assert.equal(sensitive.flags, "g");
  assert.equal(sensitive.regex.test("a"), false);

  const whole = buildFindRegExp("cat", { wholeWord: true });
  assert.equal(whole.valid, true);
  assert.equal(whole.source, "cat");
  assert.equal(findMatches("cat concatenate cat.", "cat", { wholeWord: true }).matches.length, 2);

  const regex = buildFindRegExp("a+b", { regex: true });
  assert.equal(regex.valid, true);
  assert.equal(regex.regex.test("aaab"), true);

  const invalid = buildFindRegExp("(", { regex: true });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.regex, null);
  assert.equal(typeof invalid.error, "string");

  const empty = buildFindRegExp("");
  assert.deepEqual(empty, { empty: true, valid: true, error: null, source: "", flags: "", regex: null });
});

test("buildLineStarts and lineIndexAt - map offsets to lines", () => {
  const text = "one\ntwo\n\nfour";
  const starts = buildLineStarts(text);
  assert.deepEqual(starts, [0, 4, 8, 9]);
  assert.equal(lineIndexAt(starts, 0), 0);
  assert.equal(lineIndexAt(starts, 3), 0);
  assert.equal(lineIndexAt(starts, 4), 1);
  assert.equal(lineIndexAt(starts, 8), 2);
  assert.equal(lineIndexAt(starts, 9), 3);
  assert.equal(lineIndexAt([], 4), 0);
});

test("findMatches - reports line, column, text and ids", () => {
  const text = "const render = 1;\nrender();\n// render again";
  const result = findMatches(text, "render");
  assert.equal(result.valid, true);
  assert.equal(result.limited, false);
  assert.equal(result.matches.length, 3);
  assert.deepEqual(
    result.matches.map((m) => ({ id: m.id, line: m.line, column: m.column, text: m.text })),
    [
      { id: 0, line: 0, column: 6, text: "render" },
      { id: 1, line: 1, column: 0, text: "render" },
      { id: 2, line: 2, column: 3, text: "render" },
    ]
  );
  assert.equal(result.matches[1].lineText, "render();");
});

test("findMatches - case sensitivity and whole word", () => {
  assert.equal(findMatches("Cat cat CAT", "cat").matches.length, 3);
  assert.equal(findMatches("Cat cat CAT", "cat", { caseSensitive: true }).matches.length, 1);
  assert.equal(findMatches("cat concatenate cat.", "cat", { wholeWord: true }).matches.length, 2);
});

test("findMatches - regex mode, invalid pattern and zero-length matches", () => {
  const regex = findMatches("a1 b22 c333", "\\d+", { regex: true });
  assert.deepEqual(
    regex.matches.map((m) => m.text),
    ["1", "22", "333"]
  );

  const invalid = findMatches("anything", "(", { regex: true });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.matches, []);
  assert.equal(typeof invalid.error, "string");

  const zero = findMatches("abc", "^", { regex: true });
  assert.deepEqual(zero.matches, []);
  assert.equal(zero.valid, true);
});

test("findMatches - empty query and cap with visible limited flag", () => {
  const empty = findMatches("abc", "");
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.matches, []);

  const capped = findMatches("x x x x x", "x", { cap: 3 });
  assert.equal(capped.matches.length, 3);
  assert.equal(capped.limited, true);
});

test("stepMatchIndex - wraps in both directions", () => {
  assert.equal(stepMatchIndex(-1, 0), -1);
  assert.equal(stepMatchIndex(-1, 3), 0);
  assert.equal(stepMatchIndex(0, 3), 1);
  assert.equal(stepMatchIndex(2, 3), 0);
  assert.equal(stepMatchIndex(0, 3, -1), 2);
  assert.equal(stepMatchIndex(1, 3, -1), 0);
  assert.equal(stepMatchIndex(-1, 3, -1), 2);
  assert.equal(stepMatchIndex(9, 3), 0);
});

test("findMatchIndexAtLine - first match at or after the line", () => {
  const matches = [{ line: 2 }, { line: 8 }, { line: 12 }];
  assert.equal(findMatchIndexAtLine(matches, 0), 0);
  assert.equal(findMatchIndexAtLine(matches, 2), 0);
  assert.equal(findMatchIndexAtLine(matches, 3), 1);
  assert.equal(findMatchIndexAtLine(matches, 12), 2);
  assert.equal(findMatchIndexAtLine(matches, 99), 0);
  assert.equal(findMatchIndexAtLine([], 1), -1);
});

test("describeFindCounter - empty, no results, position and invalid regex", () => {
  assert.equal(describeFindCounter(0, 0, { empty: true }), "");
  assert.equal(describeFindCounter(0, 0, {}), "No results");
  assert.equal(describeFindCounter(0, 3, {}), "1 of 3");
  assert.equal(describeFindCounter(2, 3, {}), "3 of 3");
  assert.equal(describeFindCounter(-1, 3, {}), "1 of 3");
  assert.equal(describeFindCounter(0, 3, { limited: true }), "1 of 3+");
  assert.equal(describeFindCounter(0, 0, { valid: false }), "Invalid regex");
});

test("lineMatchSegments - plain and highlighted runs with a current match", () => {
  const line = "one fish two fish";
  const matches = [
    { id: 0, line: 1, column: 4, length: 4 },
    { id: 1, line: 1, column: 13, length: 4 },
    { id: 2, line: 2, column: 0, length: 1 },
  ];
  assert.deepEqual(lineMatchSegments(line, matches, 1, 1), [
    { text: "one ", highlight: false, current: false },
    { text: "fish", highlight: true, current: false },
    { text: " two ", highlight: false, current: false },
    { text: "fish", highlight: true, current: true },
  ]);
  assert.deepEqual(lineMatchSegments("plain", matches, 0, 0), [{ text: "plain", highlight: false, current: false }]);
  assert.deepEqual(lineMatchSegments("", matches, 0, 0), [{ text: "", highlight: false, current: false }]);
});

test("lineMatchSegments - clamps matches that run past the line", () => {
  const segments = lineMatchSegments("abc", [{ id: 0, line: 0, column: 2, length: 99 }], 0, 0);
  assert.deepEqual(segments, [
    { text: "ab", highlight: false, current: false },
    { text: "c", highlight: true, current: true },
  ]);
});

test("trimMatchContext - leaves short lines intact", () => {
  assert.deepEqual(trimMatchContext("const render = 1;", 6, 6), {
    text: "const render = 1;",
    matchStart: 6,
    matchLength: 6,
    leadingEllipsis: false,
    trailingEllipsis: false,
  });
});

test("trimMatchContext - centers and ellipsises a long line around the match", () => {
  const line = `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`;
  const trimmed = trimMatchContext(line, 300, 6, 60);
  assert.equal(trimmed.text.length, 60);
  assert.equal(trimmed.leadingEllipsis, true);
  assert.equal(trimmed.trailingEllipsis, true);
  assert.equal(trimmed.text.slice(trimmed.matchStart, trimmed.matchStart + trimmed.matchLength), "NEEDLE");
  assert.equal(trimmed.matchLength, 6);
});

test("trimMatchContext - handles a match near the start and near the end", () => {
  const line = `${"x".repeat(400)}`;
  const start = trimMatchContext(`${"NEEDLE"}${line}`, 0, 6, 40);
  assert.equal(start.leadingEllipsis, false);
  assert.equal(start.trailingEllipsis, true);
  assert.equal(start.text.slice(start.matchStart, start.matchStart + start.matchLength), "NEEDLE");

  const end = trimMatchContext(`${line}NEEDLE`, 400, 6, 40);
  assert.equal(end.leadingEllipsis, true);
  assert.equal(end.trailingEllipsis, false);
  assert.equal(end.text.slice(end.matchStart, end.matchStart + end.matchLength), "NEEDLE");
});

test("trimMatchContext - clamps out-of-range positions", () => {
  const trimmed = trimMatchContext("short", 99, 99, 20);
  assert.equal(trimmed.text, "short");
  assert.equal(trimmed.matchStart, 5);
  assert.equal(trimmed.matchLength, 0);
});

test("parseGlobList - comma-separated, trimmed, ignores empties", () => {
  assert.deepEqual(parseGlobList("src/**, *.js,  , dist/**"), ["src/**", "*.js", "dist/**"]);
  assert.deepEqual(parseGlobList(["a", " b "]), ["a", "b"]);
  assert.deepEqual(parseGlobList(null), []);
});

test("globToRegExp and matchesGlob - base names, paths, globstar, braces and question marks", () => {
  assert.equal(matchesGlob("index.js", "*.js"), true);
  assert.equal(matchesGlob("src/index.js", "*.js"), true);
  assert.equal(matchesGlob("src/index.ts", "*.js"), false);
  assert.equal(matchesGlob("src/a/b.ts", "src/**"), true);
  assert.equal(matchesGlob("src/a/b.ts", "src/*.ts"), false);
  assert.equal(matchesGlob("src/a/b.ts", "src/**/*.ts"), true);
  assert.equal(matchesGlob("a/b.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("b.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("b.js", "**/*.{js,ts}"), true);
  assert.equal(matchesGlob("b.tsx", "**/*.{js,ts}"), false);
  assert.equal(matchesGlob("a.md", "?.md"), true);
  assert.equal(matchesGlob("ab.md", "?.md"), false);
  assert.equal(matchesGlob("src\\a\\b.ts", "src/**"), true);
});

test("filterSearchRowsByGlobs - includes OR together and excludes win", () => {
  const rows = [
    { file: "src/a.js" },
    { file: "src/a.ts" },
    { file: "test/a.js" },
    { file: "dist/a.js" },
  ];
  assert.deepEqual(
    filterSearchRowsByGlobs(rows, { include: "src/**, test/**" }).map((row) => row.file),
    ["src/a.js", "src/a.ts", "test/a.js"]
  );
  assert.deepEqual(
    filterSearchRowsByGlobs(rows, { include: "*.js", exclude: "dist/**" }).map((row) => row.file),
    ["src/a.js", "test/a.js"]
  );
  assert.deepEqual(
    filterSearchRowsByGlobs(rows, { exclude: "*.ts" }).map((row) => row.file),
    ["src/a.js", "test/a.js", "dist/a.js"]
  );
});

test("normalizeSearchPath - strips ./ and normalizes separators", () => {
  assert.equal(normalizeSearchPath("./src/a.js"), "src/a.js");
  assert.equal(normalizeSearchPath("src\\a.js"), "src/a.js");
  assert.equal(normalizeSearchPath("src/a.js/"), "src/a.js");
  assert.equal(normalizeSearchPath(null), "");
});

test("parseRgJson - groups submatch rows and skips non-match events", () => {
  const stdout = [
    JSON.stringify({ type: "begin", data: { path: { text: "src/a.js" } } }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "./src/a.js" },
        lines: { text: "const render = render;\n" },
        line_number: 3,
        submatches: [
          { start: 6, end: 12 },
          { start: 15, end: 21 },
        ],
      },
    }),
    "not json",
    JSON.stringify({ type: "end", data: { path: { text: "src/a.js" } } }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/b.ts" },
        lines: { text: "render();\n" },
        line_number: 1,
        submatches: [{ start: 0, end: 6 }],
      },
    }),
  ].join("\n");

  const parsed = parseRgJson(stdout);
  assert.equal(parsed.limited, false);
  assert.deepEqual(parsed.rows, [
    { file: "src/a.js", line: 3, column: 6, length: 6, text: "const render = render;" },
    { file: "src/a.js", line: 3, column: 15, length: 6, text: "const render = render;" },
    { file: "src/b.ts", line: 1, column: 0, length: 6, text: "render();" },
  ]);
});

test("parseRgJson - caps matches and files with a limited flag", () => {
  const makeMatch = (file, lineNumber) =>
    JSON.stringify({
      type: "match",
      data: {
        path: { text: file },
        lines: { text: "x\n" },
        line_number: lineNumber,
        submatches: [{ start: 0, end: 1 }],
      },
    });

  const cappedMatches = parseRgJson([makeMatch("a.js", 1), makeMatch("a.js", 2), makeMatch("a.js", 3)].join("\n"), {
    maxMatches: 2,
  });
  assert.equal(cappedMatches.rows.length, 2);
  assert.equal(cappedMatches.limited, true);

  const cappedFiles = parseRgJson([makeMatch("a.js", 1), makeMatch("b.js", 1), makeMatch("c.js", 1)].join("\n"), {
    maxFiles: 2,
  });
  assert.deepEqual(
    cappedFiles.rows.map((row) => row.file),
    ["a.js", "b.js"]
  );
  assert.equal(cappedFiles.limited, true);
});

test("parseRgJson - decodes base64 bytes payloads", () => {
  const pathBytes = Buffer.from("src/bytes.js", "utf8").toString("base64");
  const lineBytes = Buffer.from("render\n", "utf8").toString("base64");
  const stdout = JSON.stringify({
    type: "match",
    data: {
      path: { bytes: pathBytes },
      lines: { bytes: lineBytes },
      line_number: 2,
      submatches: [{ start: 0, end: 6 }],
    },
  });
  const parsed = parseRgJson(stdout);
  assert.deepEqual(parsed.rows, [{ file: "src/bytes.js", line: 2, column: 0, length: 6, text: "render" }]);
});

test("parseRgJson - converts UTF-8 byte offsets to JS string offsets", () => {
  const line = "açúcar render";
  const byteStart = Buffer.byteLength("açúcar ", "utf8");
  const stdout = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/unicode.js" },
      lines: { text: `${line}\n` },
      line_number: 4,
      submatches: [{ start: byteStart, end: byteStart + 6 }],
    },
  });
  const parsed = parseRgJson(stdout);
  assert.deepEqual(parsed.rows, [
    { file: "src/unicode.js", line: 4, column: "açúcar ".length, length: 6, text: line },
  ]);
});

test("parseGrepOutput - parses path:line:text, keeps colons in text and skips notices", () => {
  const stdout = [
    "src/a.js:3:const render = 1;",
    "src/a.js:4:http://localhost:3000",
    "C:\\work\\a.js:9:render()",
    "Binary file src/bin.dat matches",
    "malformed line",
    "",
  ].join("\n");
  const parsed = parseGrepOutput(stdout);
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(parsed.rows, [
    { file: "src/a.js", line: 3, text: "const render = 1;" },
    { file: "src/a.js", line: 4, text: "http://localhost:3000" },
    { file: "C:/work/a.js", line: 9, text: "render()" },
  ]);
});

test("expandGrepRows - applies case, whole-word and regex rules with exact columns", () => {
  const rows = [
    { file: "a.js", line: 1, text: "render Render renderer" },
    { file: "a.js", line: 2, text: "RENDER()" },
  ];
  const insensitive = expandGrepRows(rows, "render");
  assert.deepEqual(
    insensitive.rows.map((row) => ({ line: row.line, column: row.column, length: row.length })),
    [
      { line: 1, column: 0, length: 6 },
      { line: 1, column: 7, length: 6 },
      { line: 1, column: 14, length: 6 },
      { line: 2, column: 0, length: 6 },
    ]
  );
  assert.equal(insensitive.valid, true);

  const sensitive = expandGrepRows(rows, "render", { caseSensitive: true });
  assert.equal(sensitive.rows.length, 2);

  const whole = expandGrepRows(rows, "render", { caseSensitive: true, wholeWord: true });
  assert.deepEqual(
    whole.rows.map((row) => ({ line: row.line, column: row.column })),
    [{ line: 1, column: 0 }]
  );

  const regex = expandGrepRows([{ file: "a.js", line: 1, text: "v1.2.3" }], "\\d+", { regex: true });
  assert.deepEqual(
    regex.rows.map((row) => row.column),
    [1, 3, 5]
  );

  const invalid = expandGrepRows(rows, "(", { regex: true });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.rows, []);

  const capped = expandGrepRows(rows, "render", { cap: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.limited, true);
});

test("groupSearchRows - groups by file, splits name and dir, and caps", () => {
  const rows = [
    { file: "src/a.js", line: 1, column: 0, length: 3, text: "foo" },
    { file: "src/a.js", line: 4, column: 2, length: 3, text: "x foo" },
    { file: "b.md", line: 2, column: 1, length: 3, text: "foo" },
  ];
  const grouped = groupSearchRows(rows);
  assert.equal(grouped.totalFiles, 2);
  assert.equal(grouped.totalMatches, 3);
  assert.equal(grouped.limited, false);
  assert.deepEqual(
    grouped.groups.map((group) => ({ file: group.file, name: group.name, dir: group.dir, count: group.count })),
    [
      { file: "src/a.js", name: "a.js", dir: "src", count: 2 },
      { file: "b.md", name: "b.md", dir: "", count: 1 },
    ]
  );
  assert.deepEqual(grouped.groups[0].matches[1], { line: 4, column: 2, length: 3, text: "x foo" });

  const capped = groupSearchRows(rows, { maxMatches: 2 });
  assert.equal(capped.totalMatches, 2);
  assert.equal(capped.limited, true);

  const cappedFiles = groupSearchRows(rows, { maxFiles: 1 });
  assert.equal(cappedFiles.totalFiles, 1);
  assert.equal(cappedFiles.limited, true);
});

test("flattenSearchRows - headers then match rows, hiding collapsed groups", () => {
  const groups = [
    {
      file: "src/a.js",
      name: "a.js",
      dir: "src",
      count: 2,
      matches: [
        { line: 1, column: 0, length: 3, text: "foo" },
        { line: 4, column: 2, length: 3, text: "x foo" },
      ],
    },
    { file: "b.md", name: "b.md", dir: "", count: 1, matches: [{ line: 2, column: 1, length: 3, text: "foo" }] },
  ];
  const open = flattenSearchRows(groups);
  assert.deepEqual(
    open.map((row) => row.key),
    ["g:src/a.js", "m:src/a.js:1:0:0", "m:src/a.js:4:2:1", "g:b.md", "m:b.md:2:1:0"]
  );
  const collapsed = flattenSearchRows(groups, new Set(["src/a.js"]));
  assert.deepEqual(
    collapsed.map((row) => row.key),
    ["g:src/a.js", "g:b.md", "m:b.md:2:1:0"]
  );
  assert.deepEqual(flattenSearchRows(null), []);
});

test("formatSearchSummary - running, invalid, empty, zero, plural and limited", () => {
  assert.equal(formatSearchSummary({ running: true }), "Searching…");
  assert.equal(formatSearchSummary({ valid: false }), "Invalid regex");
  assert.equal(formatSearchSummary({ query: "" }), "");
  assert.equal(formatSearchSummary({ query: "x", totalMatches: 0 }), "No results found");
  assert.equal(formatSearchSummary({ query: "x", totalMatches: 1, totalFiles: 1 }), "1 result in 1 file");
  assert.equal(formatSearchSummary({ query: "x", totalMatches: 5, totalFiles: 2 }), "5 results in 2 files");
  assert.equal(
    formatSearchSummary({ query: "x", totalMatches: 5, totalFiles: 2, limited: true }),
    "5 results in 2 files (limited)"
  );
});

test("normalizeFindPrefs and normalizeFindProp - tolerate junk and line numbers", () => {
  assert.deepEqual(normalizeFindPrefs(null), { query: "", caseSensitive: false, wholeWord: false, regex: false });
  assert.deepEqual(normalizeFindPrefs({ query: "x", caseSensitive: true, wholeWord: 1 }), {
    query: "x",
    caseSensitive: true,
    wholeWord: false,
    regex: false,
  });

  assert.equal(normalizeFindProp(null), null);
  assert.equal(normalizeFindProp({}), null);
  assert.deepEqual(normalizeFindProp({ query: "render", caseSensitive: true, line: 12.9 }), {
    query: "render",
    caseSensitive: true,
    wholeWord: false,
    regex: false,
    line: 12,
  });
  assert.deepEqual(normalizeFindProp({ line: 0 }), {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    line: 1,
  });
});

test("normalizeSections - explorer defaults open and search defaults collapsed", () => {
  assert.deepEqual(normalizeSections(null), { explorer: true, search: false });
  assert.deepEqual(normalizeSections({ explorer: false, search: true }), { explorer: false, search: true });
  assert.deepEqual(normalizeSections({}), { explorer: true, search: false });
});

test("shouldPromoteSearchClick - same key inside the window promotes", () => {
  assert.equal(shouldPromoteSearchClick(null, "file:a"), false);
  assert.equal(shouldPromoteSearchClick({ key: "file:a", at: 1000 }, "file:b", 1100), false);
  assert.equal(shouldPromoteSearchClick({ key: "file:a", at: 1000 }, "file:a", 1100), true);
  assert.equal(shouldPromoteSearchClick({ key: "file:a", at: 1000 }, "file:a", 1600), false);
  assert.equal(shouldPromoteSearchClick({ key: "file:a", at: 1000 }, "file:a", 1000, 0), true);
});

test("public caps match the documented budgets", () => {
  assert.equal(SEARCH_MATCH_CAP, 2000);
  assert.equal(SEARCH_FILE_CAP, 200);
  assert.ok(FIND_MATCH_CAP >= 1000);
});
