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
  searchGlobVariants,
  filterSearchRowsByGlobs,
  normalizeSearchPath,
  parseRgJson,
  parseGrepOutput,
  expandGrepRows,
  buildRipgrepArgs,
  buildGrepArgs,
  formatSearchError,
  classifySearchResult,
  findHorizontalOffset,
  shouldConsumePendingFind,
  findPropSignature,
  PENDING_FIND_TTL_MS,
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
  applyPreserveCase,
  expandReplacement,
  applyReplacements,
  replaceSingleMatch,
  replacementDiffSegments,
  expandSearchReplacement,
  selectFreshMatches,
  planFileReplacements,
  collectReplaceTargets,
  formatReplaceAllConfirmation,
  normalizeReplacePrefs,
  SEARCH_ROW_HEIGHT,
  REPLACE_MAX_BYTES,
  searchWindow,
  classifyReplacementRead,
  isDirtyFileState,
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
  assert.equal(literal.flags, "gim");
  assert.equal(literal.regex.test("a.b"), true);
  assert.equal(literal.regex.test("axb"), false);

  const sensitive = buildFindRegExp("A", { caseSensitive: true });
  assert.equal(sensitive.flags, "gm");
  assert.equal(sensitive.regex.test("a"), false);

  const whole = buildFindRegExp("cat", { wholeWord: true });
  assert.equal(whole.valid, true);
  assert.match(whole.source, /^\(\?:\^\|\\W\)\(cat\)\(\?=\\W\|\$\)$/);
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

test("findMatches - regex anchors match line boundaries (R1)", () => {
  const imports = findMatches("import a\nimport b\n", "^import", { regex: true });
  assert.equal(imports.matches.length, 2);
  assert.deepEqual(
    imports.matches.map((match) => match.line),
    [0, 1]
  );

  const semicolons = findMatches("a;\nb;\n", ";$", { regex: true });
  assert.equal(semicolons.matches.length, 2);
  assert.deepEqual(
    semicolons.matches.map((match) => match.line),
    [0, 1]
  );
});

test("findMatches - whole word retries alternation candidates (R8)", () => {
  const one = findMatches("foobar", "foo|foobar", { regex: true, wholeWord: true });
  assert.equal(one.matches.length, 1);
  assert.equal(one.matches[0].text, "foobar");
  assert.equal(one.matches[0].index, 0);

  const both = findMatches("foo foobar", "foo|foobar", { regex: true, wholeWord: true });
  assert.deepEqual(
    both.matches.map((match) => match.text),
    ["foo", "foobar"]
  );
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

test("matchesGlob - bare folder names match at any depth (R6)", () => {
  assert.equal(matchesGlob("src", "src"), true);
  assert.equal(matchesGlob("src/a.js", "src"), true);
  assert.equal(matchesGlob("project/src/a.js", "src"), true);
  assert.equal(matchesGlob("srcx/a.js", "src"), false);
  assert.equal(matchesGlob("node_modules/pkg/index.js", "node_modules"), true);
  assert.equal(matchesGlob("docs/README.md", "README.md"), true);
  assert.equal(matchesGlob("docs/README.md.bak", "README.md"), false);
});

test("searchGlobVariants - bare names expand to node and descendants (R6)", () => {
  assert.deepEqual(searchGlobVariants("src"), ["**/src/**", "**/src"]);
  assert.deepEqual(searchGlobVariants("README.md"), ["**/README.md/**", "**/README.md"]);
  assert.deepEqual(searchGlobVariants("*.js"), ["*.js"]);
  assert.deepEqual(searchGlobVariants("src/**"), ["src/**"]);
  assert.deepEqual(searchGlobVariants(""), []);
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

test("parseRgJson - parses a 1 MB line with 2,000 submatches under 50 ms (R5)", () => {
  const line = "a".repeat(1_000_000);
  const submatches = [];
  for (let i = 0; i < 2000; i += 1) {
    const start = i * 400;
    submatches.push({ start, end: start + 4 });
  }
  const stdout = JSON.stringify({
    type: "match",
    data: {
      path: { text: "big.js" },
      lines: { text: `${line}\n` },
      line_number: 1,
      submatches,
    },
  });
  const started = performance.now();
  const parsed = parseRgJson(stdout, { maxMatches: 5000, maxFiles: 200 });
  const elapsed = performance.now() - started;
  assert.equal(parsed.rows.length, 2000);
  assert.ok(elapsed < 50, `parse took ${elapsed.toFixed(1)} ms`);
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

test("parseGrepOutput - NUL separators keep paths containing :digits: intact (R9)", () => {
  const stdout = [
    "C:\\work:12:file.js\0" + "9:const render = 1;",
    "src/a.js\0" + "3:http://localhost:3000",
    "broken\0not-a-line",
    "",
  ].join("\n");
  const parsed = parseGrepOutput(stdout);
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(parsed.rows, [
    { file: "C:/work:12:file.js", line: 9, text: "const render = 1;" },
    { file: "src/a.js", line: 3, text: "http://localhost:3000" },
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

test("formatSearchSummary - whitespace-only query is empty (R7)", () => {
  assert.equal(formatSearchSummary({ query: "   " }), "");
  assert.equal(formatSearchSummary({ query: "\t\n" }), "");
});

test("buildRipgrepArgs - caps line size, file size, per-file matches and globs (R3/R5/R6)", () => {
  const args = buildRipgrepArgs({
    query: "render",
    caseSensitive: false,
    wholeWord: true,
    regex: true,
    include: ["src", "*.js"],
    exclude: ["node_modules", "dist/**"],
  });
  assert.ok(args.includes("--max-columns"));
  assert.equal(args[args.indexOf("--max-columns") + 1], "1000");
  assert.ok(args.includes("--max-columns-preview"));
  assert.deepEqual(args.slice(args.indexOf("--max-filesize"), args.indexOf("--max-filesize") + 2), [
    "--max-filesize",
    "1M",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--max-count"), args.indexOf("--max-count") + 2), ["--max-count", "200"]);
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("-w"));
  assert.ok(!args.includes("--fixed-strings"));
  assert.deepEqual(
    args.filter((arg, index) => args[index - 1] === "--glob"),
    ["**/src/**", "**/src", "*.js", "!**/node_modules/**", "!**/node_modules", "!dist/**"]
  );
  assert.deepEqual(args.slice(-3), ["-e", "render", "."]);
  const spaced = buildRipgrepArgs({ query: " render " });
  assert.deepEqual(spaced.slice(-3), ["-e", " render ", "."]);
});

test("buildGrepArgs - NUL output, binary skip, excludes and per-file cap (R3/R5/R9)", () => {
  const args = buildGrepArgs({
    query: "render",
    caseSensitive: true,
    wholeWord: false,
    regex: false,
    include: ["*.md", "src/**", "src"],
    exclude: ["node_modules", "dist/**"],
  });
  assert.deepEqual(args.slice(0, 5), ["-rn", "-I", "--null", "-m", "200"]);
  assert.ok(!args.includes("-i"));
  assert.ok(!args.includes("-w"));
  assert.ok(args.includes("-F"));
  assert.ok(args.includes("--include=*.md"));
  assert.ok(!args.includes("--include=src/**"));
  assert.ok(!args.includes("--include=src"));
  assert.ok(args.includes("--exclude=node_modules"));
  assert.ok(args.includes("--exclude-dir=node_modules"));
  assert.ok(args.includes("--exclude-dir=.git"));
  assert.ok(!args.includes("--exclude=dist/**"));
  assert.equal(args[args.indexOf("-e") + 1], "render");
  assert.equal(args.at(-1), ".");
  const spaced = buildGrepArgs({ query: " render " });
  assert.equal(spaced[spaced.indexOf("-e") + 1], " render ");
});

test("formatSearchError - clean regex dialect message and raw fallback (C)", () => {
  const regexError = formatSearchError(
    "regex parse error:\n    (?<=a)foo\n    ^^^\nerror: look-around, including look-ahead and look-behind, is not supported",
    true
  );
  assert.match(regexError, /^Regex not supported by search: /);
  assert.match(regexError, /look-around|look-behind/);
  assert.equal(formatSearchError("permission denied", true), "permission denied");
  assert.equal(formatSearchError("", true), null);
  assert.ok(formatSearchError("x".repeat(500)).length <= 220);
});

test("classifySearchResult - exit 2 keeps parsed matches as a warning (R4)", () => {
  assert.deepEqual(classifySearchResult(0, 5, "", false), { error: null, warning: null });
  assert.deepEqual(classifySearchResult(1, 0, "", false), { error: null, warning: null });
  const partial = classifySearchResult(2, 3, "permission denied", true);
  assert.equal(partial.error, null);
  assert.equal(partial.warning, "permission denied");
  const failed = classifySearchResult(2, 0, "regex parse error: look-around is not supported", true);
  assert.equal(failed.warning, null);
  assert.match(failed.error, /^Regex not supported by search: /);
});

test("findHorizontalOffset - keeps the current match on screen (R10)", () => {
  assert.equal(findHorizontalOffset(0, 800), 0);
  assert.equal(findHorizontalOffset(10, 800), 0);
  const far = findHorizontalOffset(300, 800);
  assert.ok(far > 0);
  assert.ok(far < 300);
  assert.ok(300 - far < 100);
});

test("shouldConsumePendingFind - single use, right file and short TTL (R2)", () => {
  const now = 1_000_000;
  const pending = { fileKey: "root/a.js", find: { query: "x" }, timestamp: now - 100 };
  assert.equal(shouldConsumePendingFind(pending, "root/a.js", null, now), true);
  assert.equal(shouldConsumePendingFind(pending, "root/b.js", null, now), false);
  assert.equal(shouldConsumePendingFind(pending, "root/a.js", pending.timestamp, now), false);
  assert.equal(shouldConsumePendingFind(pending, "root/a.js", null, now + PENDING_FIND_TTL_MS + 1), false);
  assert.equal(shouldConsumePendingFind(null, "root/a.js", null, now), false);
  assert.equal(shouldConsumePendingFind({ fileKey: "root/a.js", timestamp: now }, "root/a.js", null, now), false);
});

test("findPropSignature - stable per prop, different for a new line (B)", () => {
  const a = findPropSignature({ query: "render", wholeWord: true, line: 10 });
  const b = findPropSignature({ query: "render", wholeWord: true, line: 10 });
  const c = findPropSignature({ query: "render", wholeWord: true, line: 11 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(
    findPropSignature({ query: "render", line: 10, at: 1 }),
    findPropSignature({ query: "render", line: 10, at: 2 }),
    "a new click on the same result must re-open find"
  );
  assert.equal(findPropSignature(null), null);
  assert.equal(findPropSignature({}), null);
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
    at: null,
  });
  assert.deepEqual(normalizeFindProp({ line: 0 }), {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    line: 1,
    at: null,
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

test("expandReplacement - plain mode is literal and preserve case still applies", () => {
  assert.equal(expandReplacement("$1 \\n", { text: "Foo" }), "$1 \\n");
  assert.equal(expandReplacement("bar", { text: "Foo" }, { preserveCase: true }), "Bar");
  assert.equal(expandReplacement("", { text: "Foo" }, { regex: true }), "");
  assert.equal(expandReplacement(null, { text: "Foo" }), "");
});

test("expandReplacement - regex groups, $&, $$ and escapes", () => {
  assert.equal(expandReplacement("$1-$2", { text: "a-b", groups: ["a", "b"] }, { regex: true }), "a-b");
  assert.equal(expandReplacement("$0", { text: "foo", groups: [] }, { regex: true }), "foo");
  assert.equal(expandReplacement("$0-$&", { text: "foo", groups: [] }, { regex: true }), "foo-foo");
  assert.equal(expandReplacement("$&", { text: "foo", groups: [] }, { regex: true }), "foo");
  assert.equal(expandReplacement("$$1", { text: "foo", groups: ["x"] }, { regex: true }), "$1");
  assert.equal(expandReplacement("\\n\\t\\\\", { text: "", groups: [] }, { regex: true }), "\n\t\\");
  assert.equal(expandReplacement("\\$1", { text: "foo", groups: ["x"] }, { regex: true }), "$1");
  assert.equal(expandReplacement("C:\\path", { text: "x", groups: [] }, { regex: true }), "C:\\path");
  assert.equal(expandReplacement("\\q\\z", { text: "x", groups: [] }, { regex: true }), "\\q\\z");
  assert.equal(expandReplacement("$9", { text: "foo", groups: ["x"] }, { regex: true }), "$9");
  assert.equal(expandReplacement("$99", { text: "foo", groups: ["x"] }, { regex: true }), "$99");
  assert.equal(expandReplacement("$1", { text: "ç", groups: ["á"] }, { regex: true }), "á");
});

test("expandReplacement - case operations \\u \\l \\U \\L and \\E", () => {
  assert.equal(expandReplacement("\\u$1", { text: "foo", groups: ["bar"] }, { regex: true }), "Bar");
  assert.equal(expandReplacement("\\l$1", { text: "FOO", groups: ["BAR"] }, { regex: true }), "bAR");
  assert.equal(expandReplacement("\\U$1\\E-$1", { text: "foo", groups: ["bar"] }, { regex: true }), "BAR-bar");
  assert.equal(expandReplacement("\\L$1\\E-$1", { text: "FOO", groups: ["BAR"] }, { regex: true }), "bar-BAR");
  assert.equal(expandReplacement("\\Ufoo\\E", { text: "x" }, { regex: true }), "FOO");
});

test("applyPreserveCase - VS Code lower, title, upper, mixed and separated segments", () => {
  assert.equal(applyPreserveCase("bar", "foo"), "bar");
  assert.equal(applyPreserveCase("Bar", "foo"), "bar");
  assert.equal(applyPreserveCase("bar", "Foo"), "Bar");
  assert.equal(applyPreserveCase("bar", "FOO"), "BAR");
  assert.equal(applyPreserveCase("bar", "fOo"), "bar");
  assert.equal(applyPreserveCase("baz", "fooBar"), "baz");
  assert.equal(applyPreserveCase("baz", "FooBAR"), "Baz");
  assert.equal(applyPreserveCase("baz_qux", "Foo_Bar"), "Baz_Qux");
  assert.equal(applyPreserveCase("baz-qux", "FOO-BAR"), "BAZ-QUX");
  assert.equal(applyPreserveCase("baz-qux", "foo-bar"), "baz-qux");
  assert.equal(applyPreserveCase("bar", ""), "bar");
  assert.equal(applyPreserveCase("", "Foo"), "");
  assert.equal(applyPreserveCase("éclair", "École"), "Éclair");
  assert.equal(applyPreserveCase("baz_qux", "FooBar"), "Baz_qux");
});

test("applyReplacements - back to front, adjacent, overlapping and empty", () => {
  const text = "foo foo foo";
  const matches = findMatches(text, "foo").matches;
  assert.equal(applyReplacements(text, matches, "bar"), "bar bar bar");
  assert.equal(applyReplacements(text, matches, ""), "  ");
  assert.equal(
    applyReplacements("aXbXc", [{ index: 1, length: 1 }, { index: 3, length: 1 }], "yy"),
    "ayybyyc"
  );
  assert.equal(
    applyReplacements("ab", [{ index: 0, length: 1 }, { index: 1, length: 1 }], "X"),
    "XX"
  );
  assert.equal(applyReplacements("abc", [{ index: 0, length: 2 }, { index: 1, length: 2 }], "X"), "aX");
  assert.equal(applyReplacements("abc", [], "X"), "abc");
});

test("applyReplacements - CRLF, unicode, regex groups and whole-word groups", () => {
  const crlf = "foo\r\nbar\r\nfoo\r\n";
  assert.equal(applyReplacements(crlf, findMatches(crlf, "foo").matches, "baz"), "baz\r\nbar\r\nbaz\r\n");
  assert.equal(
    applyReplacements("açúcar foo", findMatches("açúcar foo", "foo").matches, "é"),
    "açúcar é"
  );

  const regexText = "a1 b2";
  assert.equal(
    applyReplacements(
      regexText,
      findMatches(regexText, "([a-z])(\\d)", { regex: true }).matches,
      "$2$1",
      { regex: true, query: "([a-z])(\\d)" }
    ),
    "1a 2b"
  );
  assert.equal(
    applyReplacements("foo", [{ index: 0, length: 3, groups: ["x"] }], "$1", { regex: true }),
    "x"
  );
  assert.equal(
    applyReplacements(
      "cat",
      findMatches("cat", "(c)(at)", { regex: true, wholeWord: true }).matches,
      "$1$2",
      { regex: true, wholeWord: true, query: "(c)(at)" }
    ),
    "cat"
  );
});

test("applyReplacements - preserve case maps the replacement to the match", () => {
  const text = "foo Foo FOO";
  assert.equal(
    applyReplacements(text, findMatches(text, "foo").matches, "bar", { preserveCase: true }),
    "bar Bar BAR"
  );
});

test("replaceSingleMatch - replaces one, selects the next and wraps", () => {
  const text = "foo foo foo";
  const matches = findMatches(text, "foo").matches;
  const first = replaceSingleMatch(text, matches, 0, "bar", { query: "foo" });
  assert.equal(first.text, "bar foo foo");
  assert.equal(first.replaced, true);
  assert.equal(first.nextIndex, 0);

  const last = replaceSingleMatch(text, matches, 2, "bar", { query: "foo" });
  assert.equal(last.text, "foo foo bar");
  assert.equal(last.nextIndex, 0);

  const missing = replaceSingleMatch(text, matches, 99, "bar", { query: "foo" });
  assert.equal(missing.text, text);
  assert.equal(missing.replaced, false);
  assert.equal(missing.nextIndex, -1);
});

test("replaceSingleMatch - skips a replacement that matches the query", () => {
  const text = "foo foo";
  const matches = findMatches(text, "foo").matches;
  const result = replaceSingleMatch(text, matches, 0, "foo", { query: "foo" });
  assert.equal(result.text, "foo foo");
  assert.equal(result.nextIndex, 1);

  const grown = replaceSingleMatch("x", [{ index: 0, length: 1, text: "x" }], 0, "xx", { query: "x" });
  assert.equal(grown.text, "xx");
  assert.equal(grown.nextIndex, 0);
});

test("replacementDiffSegments - removed and inserted, empty and multiline", () => {
  assert.deepEqual(replacementDiffSegments("foo", "bar"), [
    { kind: "removed", text: "foo" },
    { kind: "inserted", text: "bar" },
  ]);
  assert.deepEqual(replacementDiffSegments("foo", ""), [{ kind: "removed", text: "foo" }]);
  assert.deepEqual(replacementDiffSegments("", "bar"), [{ kind: "inserted", text: "bar" }]);
  assert.deepEqual(replacementDiffSegments("", ""), []);
  assert.deepEqual(replacementDiffSegments("foo", "a\nb\tc"), [
    { kind: "removed", text: "foo" },
    { kind: "inserted", text: "a↵b→c" },
  ]);
  assert.deepEqual(replacementDiffSegments("ç", "é"), [
    { kind: "removed", text: "ç" },
    { kind: "inserted", text: "é" },
  ]);
});

test("formatReplaceAllConfirmation - singular, plural, empty and long", () => {
  assert.equal(formatReplaceAllConfirmation(1, 1, "x"), "Replace 1 occurrence across 1 file with 'x'?");
  assert.equal(formatReplaceAllConfirmation(3, 2, "y"), "Replace 3 occurrences across 2 files with 'y'?");
  assert.equal(formatReplaceAllConfirmation(0, 0, ""), "Replace 0 occurrences across 0 files with ''?");
  const long = formatReplaceAllConfirmation(2, 2, "x".repeat(100));
  assert.ok(long.includes("…"));
  assert.ok(long.length < 140);
});

test("expandSearchReplacement - literal, regex groups and preserve case", () => {
  assert.equal(expandSearchReplacement("foo bar", "foo", {}, { column: 0, length: 3 }, "baz"), "baz");
  assert.equal(
    expandSearchReplacement("a1 b2", "([a-z])(\\d)", { regex: true }, { column: 0, length: 2 }, "$2$1"),
    "1a"
  );
  assert.equal(
    expandSearchReplacement("Foo", "foo", {}, { column: 0, length: 3 }, "bar", { preserveCase: true }),
    "Bar"
  );
  assert.equal(expandSearchReplacement("foo", "foo", {}, { column: 99, length: 1 }, "bar"), "bar");
});

test("selectFreshMatches and planFileReplacements - safe file replace", () => {
  const fresh = findMatches("foo foo", "foo").matches;
  const selected = selectFreshMatches(fresh, [{ line: 1, column: 0, length: 3, text: "foo" }]);
  assert.equal(selected.matches.length, 1);
  assert.equal(selected.missing, 0);
  const missing = selectFreshMatches(fresh, [{ line: 1, column: 1, length: 3, text: "foo" }]);
  assert.equal(missing.matches.length, 0);
  assert.equal(missing.missing, 1);

  // SEARCH rows carry the full line text; the matched slice is compared.
  const fullLine = selectFreshMatches(fresh, [{ line: 1, column: 4, length: 3, text: "foo foo" }]);
  assert.equal(fullLine.matches.length, 1);
  assert.equal(fullLine.matches[0].index, 4);
  assert.equal(fullLine.missing, 0);

  const plan = planFileReplacements(
    "foo foo",
    "foo",
    {},
    [
      { line: 1, column: 0, length: 3, text: "foo" },
      { line: 1, column: 4, length: 3, text: "foo" },
    ],
    "bar"
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.text, "bar bar");
  assert.equal(plan.count, 2);

  const changed = planFileReplacements(
    "foo baz",
    "foo",
    {},
    [
      { line: 1, column: 0, length: 3, text: "foo" },
      { line: 1, column: 4, length: 3, text: "foo" },
    ],
    "bar"
  );
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, "changed");
  assert.equal(changed.missing, 1);

  const crlf = planFileReplacements(
    "foo\r\nbar\r\n",
    "foo",
    {},
    [{ line: 1, column: 0, length: 3, text: "foo" }],
    "baz"
  );
  assert.equal(crlf.text, "baz\r\nbar\r\n");

  const empty = planFileReplacements("foo foo", "foo", {}, [], "bar");
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");

  const regex = planFileReplacements(
    "a1 b2",
    "([a-z])(\\d)",
    { regex: true },
    [
      { line: 1, column: 0, length: 2, text: "a1" },
      { line: 1, column: 3, length: 2, text: "b2" },
    ],
    "$2$1"
  );
  assert.equal(regex.text, "1a 2b");
});

test("collectReplaceTargets - normalizes paths and clamps fields", () => {
  assert.deepEqual(
    collectReplaceTargets([{ file: "./a.js", matches: [{ line: 2, column: 1, length: 3, text: "foo" }] }]),
    [{ file: "a.js", matches: [{ line: 2, column: 1, length: 3, text: "foo" }] }]
  );
  assert.deepEqual(collectReplaceTargets(null), []);
  assert.deepEqual(collectReplaceTargets([{ file: "", matches: [] }]), []);
});

test("normalizeReplacePrefs and find props carry replace state", () => {
  assert.deepEqual(normalizeReplacePrefs(null), { replace: "", replaceOpen: false, preserveCase: false });
  assert.deepEqual(normalizeReplacePrefs({ replace: "x", replaceOpen: true, preserveCase: true }), {
    replace: "x",
    replaceOpen: true,
    preserveCase: true,
  });

  const prop = normalizeFindProp({ query: "x", replace: "y" });
  assert.equal(prop.replace, "y");
  assert.equal(prop.replaceOpen, true);

  const legacy = normalizeFindProp({ query: "x" });
  assert.deepEqual(legacy, {
    query: "x",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    line: null,
    at: null,
  });

  assert.notEqual(
    findPropSignature({ query: "x", replace: "a" }),
    findPropSignature({ query: "x", replace: "b" })
  );
  assert.equal(
    findPropSignature({ query: "x", replace: "a", replaceOpen: true }),
    findPropSignature({ query: "x", replace: "a", replaceOpen: true })
  );
});

test("parseRgJson - astral characters keep later columns aligned (S6)", () => {
  const line = "a😀foo foo";
  const stdout = JSON.stringify({
    type: "match",
    data: {
      path: { text: "emoji.txt" },
      lines: { text: `${line}\n` },
      line_number: 1,
      submatches: [
        { start: 5, end: 8 },
        { start: 9, end: 12 },
      ],
    },
  });
  const parsed = parseRgJson(stdout);
  assert.deepEqual(parsed.rows, [
    { file: "emoji.txt", line: 1, column: 3, length: 3, text: line },
    { file: "emoji.txt", line: 1, column: 7, length: 3, text: line },
  ]);
});

test("parseRgJson - CJK characters keep later columns aligned (S6)", () => {
  const line = "a中foo";
  const stdout = JSON.stringify({
    type: "match",
    data: {
      path: { text: "cjk.txt" },
      lines: { text: `${line}\n` },
      line_number: 1,
      submatches: [{ start: 4, end: 7 }],
    },
  });
  const parsed = parseRgJson(stdout);
  assert.deepEqual(parsed.rows, [{ file: "cjk.txt", line: 1, column: 2, length: 3, text: line }]);
});

test("expandGrepRows - strips a UTF-8 BOM so grep and rg agree (S6)", () => {
  const expanded = expandGrepRows([{ file: "bom.txt", line: 1, text: "\uFEFFfoo bar" }], "foo");
  assert.deepEqual(expanded.rows, [{ file: "bom.txt", line: 1, column: 0, length: 3, text: "foo bar" }]);
});

test("planFileReplacements - keeps a BOM and offsets only line 1 (S6)", () => {
  const first = planFileReplacements(
    "\uFEFFfoo bar",
    "foo",
    {},
    [{ line: 1, column: 0, length: 3, text: "foo bar" }],
    "baz"
  );
  assert.equal(first.ok, true);
  assert.equal(first.text, "\uFEFFbaz bar");

  const second = planFileReplacements(
    "\uFEFFfoo\nfoo",
    "foo",
    {},
    [{ line: 2, column: 0, length: 3, text: "foo" }],
    "baz"
  );
  assert.equal(second.ok, true);
  assert.equal(second.text, "\uFEFFfoo\nbaz");
});

test("search replacement preview equals the applied preserve-case text (S3)", () => {
  const line = "Foo foo FOO";
  const matches = findMatches(line, "foo").matches;
  const previews = matches.map((match) =>
    expandSearchReplacement(line, "foo", {}, match, "bar", { preserveCase: true })
  );
  assert.deepEqual(previews, ["Bar", "bar", "BAR"]);

  const targets = matches.map((match) => ({
    line: 1,
    column: match.column,
    length: match.length,
    text: line,
  }));
  const plan = planFileReplacements(line, "foo", {}, targets, "bar", { preserveCase: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.text, "Bar bar BAR");

  let applied = line;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    applied = applied.slice(0, match.column) + previews[index] + applied.slice(match.column + match.length);
  }
  assert.equal(applied, plan.text);
});

test("classifyReplacementRead - too large, not UTF-8, unreadable and unknown size (S2)", () => {
  assert.deepEqual(classifyReplacementRead({ byteSize: REPLACE_MAX_BYTES - 1, text: "ok" }), {
    ok: true,
    reason: null,
  });
  assert.deepEqual(classifyReplacementRead({ byteSize: REPLACE_MAX_BYTES, text: "ok" }), {
    ok: false,
    reason: "too large",
  });
  assert.deepEqual(classifyReplacementRead({ byteSize: 10, text: "bad\uFFFD" }), {
    ok: false,
    reason: "not UTF-8",
  });
  assert.deepEqual(classifyReplacementRead({ byteSize: 10, text: null }), {
    ok: false,
    reason: "unreadable",
  });
  assert.deepEqual(classifyReplacementRead({ byteSize: null, text: "ok" }), {
    ok: false,
    reason: "size check failed",
  });
});

test("isDirtyFileState - live set, cache and persisted state all block writes (S7)", () => {
  assert.equal(isDirtyFileState({ key: "a", dirtyKeys: new Set(["a"]) }), true);
  assert.equal(isDirtyFileState({ key: "a", cached: { dirty: true } }), true);
  assert.equal(isDirtyFileState({ key: "a", persisted: { dirty: true } }), true);
  assert.equal(isDirtyFileState({ key: "a", cached: { dirty: false }, persisted: { dirty: false } }), false);
  assert.equal(isDirtyFileState({ key: "b", dirtyKeys: new Set(["a"]), cached: { dirty: false } }), false);
  assert.equal(isDirtyFileState({ key: "", cached: { dirty: true } }), false);
});

test("searchWindow - renders only the visible rows plus overscan (C1)", () => {
  assert.equal(SEARCH_ROW_HEIGHT, 24);
  const top = searchWindow(2000, 0, 400, SEARCH_ROW_HEIGHT, 6);
  assert.equal(top.start, 0);
  assert.equal(top.end, 29);
  assert.equal(top.visibleCount, 29);
  assert.equal(top.maxScroll, 2000 * SEARCH_ROW_HEIGHT - 400);
  assert.equal(top.offset, 0);

  const mid = searchWindow(2000, 2400, 400, SEARCH_ROW_HEIGHT, 6);
  assert.equal(mid.offset, 2400);
  assert.equal(mid.start, 94);
  assert.equal(mid.end, 123);
  assert.equal(mid.visibleCount, 29);

  const bottom = searchWindow(2000, top.maxScroll, 400, SEARCH_ROW_HEIGHT, 6);
  assert.equal(bottom.end, 2000);
  assert.ok(bottom.visibleCount <= 29);
  assert.equal(bottom.offset, top.maxScroll);

  assert.deepEqual(searchWindow(0, 0, 400, SEARCH_ROW_HEIGHT, 6), {
    start: 0,
    end: 0,
    top: 0,
    bottom: 0,
    maxScroll: 0,
    offset: 0,
    visibleCount: 0,
  });
  assert.equal(searchWindow(10, 0, 100, SEARCH_ROW_HEIGHT, 0).visibleCount, 5);
});

test("applyReplacements - replaces more than the display cap (C4)", () => {
  const text = "x ".repeat(6000).trim();
  const matches = findMatches(text, "x", { cap: Number.MAX_SAFE_INTEGER }).matches;
  assert.equal(matches.length, 6000);
  const replaced = applyReplacements(text, matches, "y");
  assert.equal((replaced.match(/y/g) || []).length, 6000);
  assert.equal(replaced.includes("x"), false);
});
