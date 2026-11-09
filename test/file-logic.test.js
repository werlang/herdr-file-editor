import test from "node:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  splitPathInfo,
  normalizeTabTarget,
  resolveAbsolutePath,
  detectLanguage,
  isMarkdownFile,
  isSvgFile,
  prepareSvgPreview,
  prepareSvgPreviewInfo,
  defaultViewMode,
  prepareFileText,
  countLines,
  isContentDirty,
  encodeBase64Chunks,
  isFileReadonly,
  readonlyReason,
  shouldReloadWatchedFile,
  parseMarkdownBlocks,
  buildSyntaxTheme,
  resolveLocationState,
  resolveFileTab,
  mergeOpenTabEntry,
  fileIconPath,
  isLightColor,
  isImageFile,
  imageHeaderSize,
  IMAGE_ZOOM_LEVELS,
  IMAGE_ZOOM_MIN,
  IMAGE_ZOOM_MAX,
  normalizeImageZoom,
  stepImageZoom,
  imageZoomPercent,
  getAncestorFolders,
  normalizeFileToRoot,
  parseTabFileName,
  matchCandidateFile,
  resolveActiveOpenedFile,
  FILE_ICON_DEFAULT,
  FILE_ICON_BY_EXT,
  FILE_ICON_BY_NAME,
} from "../mods/file-editor/file-logic.js";

test("splitPathInfo - extracts base, dir, and ext correctly", () => {
  assert.deepEqual(splitPathInfo("src/components/Header.tsx"), {
    base: "Header.tsx",
    dir: "src/components",
    ext: "tsx",
  });

  assert.deepEqual(splitPathInfo("README.md"), {
    base: "README.md",
    dir: "",
    ext: "md",
  });

  // Windows backslash normalization
  assert.deepEqual(splitPathInfo("C:\\Users\\dev\\project\\main.js"), {
    base: "main.js",
    dir: "C:/Users/dev/project",
    ext: "js",
  });

  // Dotfiles
  assert.deepEqual(splitPathInfo(".gitignore"), {
    base: ".gitignore",
    dir: "",
    ext: "gitignore",
  });

  assert.deepEqual(splitPathInfo("nested/.eslintrc.json"), {
    base: ".eslintrc.json",
    dir: "nested",
    ext: "json",
  });

  // Files without extension
  assert.deepEqual(splitPathInfo("Makefile"), {
    base: "Makefile",
    dir: "",
    ext: "",
  });

  // Trailing dot and single/double dot edge cases
  assert.deepEqual(splitPathInfo("foo."), {
    base: "foo.",
    dir: "",
    ext: "",
  });
  assert.deepEqual(splitPathInfo("."), {
    base: ".",
    dir: "",
    ext: "",
  });
  assert.deepEqual(splitPathInfo(".."), {
    base: "..",
    dir: "",
    ext: "",
  });

  // Empty or invalid input
  assert.deepEqual(splitPathInfo(""), { base: "", dir: "", ext: "" });
  assert.deepEqual(splitPathInfo(null), { base: "", dir: "", ext: "" });
  assert.deepEqual(splitPathInfo(undefined), { base: "", dir: "", ext: "" });
});

test("normalizeTabTarget - cleans up root and file parameters", () => {
  // Standard folder and relative file
  assert.deepEqual(normalizeTabTarget({ folder: "/work/repo", file: "src/main.js" }), {
    root: "/work/repo",
    file: "src/main.js",
  });

  // Trailing slashes on root and cwd
  assert.deepEqual(normalizeTabTarget({ cwd: "/work/repo///", file: "README.md" }), {
    root: "/work/repo",
    file: "README.md",
  });

  // Absolute file with no root splits directory and basename
  assert.deepEqual(normalizeTabTarget({ file: "/Users/dev/project/index.js" }), {
    root: "/Users/dev/project",
    file: "index.js",
  });

  // File prefixed with root is stripped to relative path
  assert.deepEqual(normalizeTabTarget({ folder: "/work/repo", file: "/work/repo/src/app.js" }), {
    root: "/work/repo",
    file: "src/app.js",
  });

  // Windows backslash normalization
  assert.deepEqual(normalizeTabTarget({ folder: "C:\\work\\repo\\", file: "src\\app.js" }), {
    root: "C:/work/repo",
    file: "src/app.js",
  });

  // Empty and missing props
  assert.deepEqual(normalizeTabTarget({}), { root: "", file: "" });
  assert.deepEqual(normalizeTabTarget(null), { root: "", file: "" });
});

test("resolveAbsolutePath - joins root and relative path safely", () => {
  assert.equal(resolveAbsolutePath("/work/repo", "src/main.js"), "/work/repo/src/main.js");
  assert.equal(resolveAbsolutePath("/work/repo/", "src/main.js"), "/work/repo/src/main.js");
  assert.equal(resolveAbsolutePath("/work/repo", "/src/main.js"), "/work/repo/src/main.js");
  assert.equal(resolveAbsolutePath("/work/repo", "folder"), "/work/repo/folder");
  assert.equal(resolveAbsolutePath("C:\\work\\repo\\", "src\\app.js"), "C:/work/repo/src/app.js");
  assert.equal(resolveAbsolutePath("", "src/main.js"), "src/main.js");
  assert.equal(resolveAbsolutePath(null, "src/main.js"), "src/main.js");
  assert.equal(resolveAbsolutePath("/work/repo", ""), "/work/repo");
  assert.equal(resolveAbsolutePath("/work/repo", null), "/work/repo");
});

test("detectLanguage - identifies common languages and special filenames", () => {
  assert.deepEqual(detectLanguage("main.js"), { language: "js", label: "JavaScript" });
  assert.deepEqual(detectLanguage("app.ts"), { language: "js", label: "TypeScript" });
  assert.deepEqual(detectLanguage("App.jsx"), { language: "js", label: "JSX" });
  assert.deepEqual(detectLanguage("Component.tsx"), { language: "js", label: "TSX" });
  assert.deepEqual(detectLanguage("data.json"), { language: "json", label: "JSON" });
  assert.deepEqual(detectLanguage("doc.md"), { language: "markdown", label: "Markdown" });
  assert.deepEqual(detectLanguage("main.rs"), { language: "rust", label: "Rust" });
  assert.deepEqual(detectLanguage("script.py"), { language: "python", label: "Python" });
  assert.deepEqual(detectLanguage("server.go"), { language: "go", label: "Go" });
  assert.deepEqual(detectLanguage("style.css"), { language: "css", label: "CSS" });
  assert.deepEqual(detectLanguage("config.yaml"), { language: "yaml", label: "YAML" });
  assert.deepEqual(detectLanguage("deploy.sh"), { language: "bash", label: "Shell" });

  // Special files
  assert.deepEqual(detectLanguage("Dockerfile"), { language: "dockerfile", label: "Dockerfile" });
  assert.deepEqual(detectLanguage("dockerfile"), { language: "dockerfile", label: "Dockerfile" });
  assert.deepEqual(detectLanguage("Makefile"), { language: "makefile", label: "Makefile" });
  assert.deepEqual(detectLanguage("CMakeLists.txt"), { language: "cmake", label: "CMake" });
  assert.deepEqual(detectLanguage(".gitignore"), { language: "text", label: "Gitignore" });

  // Case-insensitivity in extension
  assert.deepEqual(detectLanguage("NOTES.MD"), { language: "markdown", label: "Markdown" });
  assert.deepEqual(detectLanguage("INDEX.JS"), { language: "js", label: "JavaScript" });

  // Fallbacks
  assert.deepEqual(detectLanguage("custom.xyz"), { language: "xyz", label: "XYZ" });
  assert.deepEqual(detectLanguage("UNKNOWN"), { language: "text", label: "Text" });
});

test("isMarkdownFile - detects markdown extensions case-insensitively", () => {
  assert.equal(isMarkdownFile("README.md"), true);
  assert.equal(isMarkdownFile("guide.markdown"), true);
  assert.equal(isMarkdownFile("page.mdx"), true);
  assert.equal(isMarkdownFile("DOC.MD"), true);
  assert.equal(isMarkdownFile("sub/folder/notes.markdown"), true);

  assert.equal(isMarkdownFile("main.js"), false);
  assert.equal(isMarkdownFile("style.css"), false);
  assert.equal(isMarkdownFile("Makefile"), false);
  assert.equal(isMarkdownFile(""), false);
  assert.equal(isMarkdownFile(null), false);
});

test("isSvgFile - detects svg extensions case-insensitively", () => {
  assert.equal(isSvgFile("icon.svg"), true);
  assert.equal(isSvgFile("GRAPHIC.SVG"), true);
  assert.equal(isSvgFile("sub/folder/illustration.svg"), true);

  assert.equal(isSvgFile("main.js"), false);
  assert.equal(isSvgFile("style.css"), false);
  assert.equal(isSvgFile("photo.png"), false);
  assert.equal(isSvgFile("svg"), false);
  assert.equal(isSvgFile(""), false);
  assert.equal(isSvgFile(null), false);
});

test("prepareSvgPreview - scales the root to a crisp intrinsic size", () => {
  // Icon with only a viewBox: width/height are added from the viewBox ratio.
  const icon = '<svg viewBox="0 0 24 24" fill="none"><path d="M0 0h24v24H0z"/></svg>';
  assert.equal(
    prepareSvgPreview(icon, 240),
    '<svg width="240" height="240" viewBox="0 0 24 24" fill="none"><path d="M0 0h24v24H0z"/></svg>'
  );

  // Non-square viewBox keeps its aspect ratio.
  const wide = '<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>';
  assert.match(prepareSvgPreview(wide, 400), /^<svg width="400" height="200" viewBox="0 0 200 100">/);

  // Existing width/height (including units) are replaced, not duplicated.
  const sized = '<svg width="24px" height="12" viewBox="0 0 24 12"></svg>';
  assert.equal(prepareSvgPreview(sized, 240), '<svg width="240" height="120" viewBox="0 0 24 12"></svg>');

  // No viewBox: existing width/height define the aspect ratio.
  const sizedOnly = '<svg width="320" height="180"></svg>';
  assert.match(prepareSvgPreview(sizedOnly, 640), /^<svg width="640" height="360">/);

  // No size information: use the SVG default 300×150 viewport.
  const bare = "<svg></svg>";
  assert.equal(prepareSvgPreview(bare, 300), '<svg width="300" height="150"></svg>');

  // Percentages are ignored in favor of the default viewport.
  const percent = '<svg width="100%" height="100%"></svg>';
  assert.equal(prepareSvgPreview(percent, 300), '<svg width="300" height="150"></svg>');

  // Leading XML/doctype content is preserved.
  const xml = '<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"></svg>';
  assert.match(prepareSvgPreview(xml, 100), /^<\?xml version="1.0"\?>\n<svg width="100" height="100"/);

  // Not an SVG, empty, or non-string input.
  assert.equal(prepareSvgPreview("<html></html>"), null);
  assert.equal(prepareSvgPreview(""), null);
  assert.equal(prepareSvgPreview(null), null);
});

test("prepareSvgPreviewInfo - reports the rewritten intrinsic size", () => {
  const wide = '<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>';
  const info = prepareSvgPreviewInfo(wide, 400);
  assert.equal(info.width, 400);
  assert.equal(info.height, 200);
  assert.equal(info.text, prepareSvgPreview(wide, 400));

  const icon = '<svg viewBox="0 0 24 24"></svg>';
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(prepareSvgPreviewInfo(icon, 240)),
    { width: 240, height: 240 }
  );

  assert.equal(prepareSvgPreviewInfo("<html></html>"), null);
  assert.equal(prepareSvgPreviewInfo(null), null);
});

test("defaultViewMode - markdown and svg default to preview, others to code", () => {
  // Markdown
  assert.equal(defaultViewMode("README.md"), "preview");
  assert.equal(defaultViewMode("README.md", "preview"), "preview");
  assert.equal(defaultViewMode("README.md", "code"), "code");

  // SVG
  assert.equal(defaultViewMode("diagram.svg"), "preview");
  assert.equal(defaultViewMode("diagram.svg", "preview"), "preview");
  assert.equal(defaultViewMode("diagram.svg", "code"), "code");
  assert.equal(defaultViewMode("DIAGRAM.SVG"), "preview");

  // Non-previewable (always code)
  assert.equal(defaultViewMode("main.js"), "code");
  assert.equal(defaultViewMode("main.js", "preview"), "code");
  assert.equal(defaultViewMode("style.css", "code"), "code");
  assert.equal(defaultViewMode("data.json"), "code");
});

test("prepareFileText - handles missing, binary, normal, trailing newlines, and truncated text", () => {
  // Missing file
  const missingNull = prepareFileText(null);
  assert.equal(missingNull.error, "This file is no longer available");
  assert.equal(missingNull.text, null);

  const missingUndef = prepareFileText(undefined);
  assert.equal(missingUndef.error, "This file is no longer available");

  // Non-string input
  const nonString = prepareFileText(12345);
  assert.equal(nonString.error, "Cannot preview this file (binary, too large, or unreadable)");

  // Binary file
  const binary = prepareFileText("hello\0world");
  assert.equal(binary.error, "Binary file · no text preview");
  assert.equal(binary.isBinary, true);
  assert.equal(binary.text, null);

  // Empty file
  const empty = prepareFileText("");
  assert.equal(empty.error, null);
  assert.equal(empty.text, "");
  assert.equal(empty.lineCount, 0);
  assert.equal(empty.isTruncated, false);

  // Normal text without trailing newline
  const normalNoTrailing = prepareFileText("line 1\nline 2\nline 3");
  assert.equal(normalNoTrailing.error, null);
  assert.equal(normalNoTrailing.text, "line 1\nline 2\nline 3");
  assert.equal(normalNoTrailing.lineCount, 3);

  // Trailing newline subtraction (matching Editor gutter)
  const singleTrailing = prepareFileText("hello\n");
  assert.equal(singleTrailing.lineCount, 1);

  const multiTrailing = prepareFileText("a\nb\n");
  assert.equal(multiTrailing.lineCount, 2);

  const justNewline = prepareFileText("\n");
  assert.equal(justNewline.lineCount, 1);

  // Truncated text
  const longText = "a".repeat(100);
  const truncated = prepareFileText(longText, 50);
  assert.equal(truncated.error, null);
  assert.equal(truncated.isTruncated, true);
  assert.equal(truncated.text, "a".repeat(50) + "\n… (file truncated)");
});

test("countLines - computes lines matching editor gutter", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("hello"), 1);
  assert.equal(countLines("hello\n"), 1);
  assert.equal(countLines("hello\nworld"), 2);
  assert.equal(countLines("hello\nworld\n"), 2);
  assert.equal(countLines("\n"), 1);
  assert.equal(countLines(null), 0);
  assert.equal(countLines(undefined), 0);
});

test("isContentDirty - detects unsaved edits accurately", () => {
  assert.equal(isContentDirty("const a = 1;", "const a = 1;"), false);
  assert.equal(isContentDirty("const a = 2;", "const a = 1;"), true);
  assert.equal(isContentDirty("", ""), false);
  assert.equal(isContentDirty("something", ""), true);
  assert.equal(isContentDirty(null, null), false);
  assert.equal(isContentDirty(undefined, undefined), false);
  assert.equal(isContentDirty("text", null), true);
});

test("isFileReadonly & readonlyReason - identifies uneditable files with descriptive reasons", () => {
  // Normal local file -> editable
  assert.equal(isFileReadonly({}), false);
  assert.equal(isFileReadonly(null), false);
  assert.equal(isFileReadonly({ isBinary: false, isImage: false, isTruncated: false, on: null, fileError: null }), false);
  assert.equal(readonlyReason({}), "Read-only");

  // Binary file
  assert.equal(isFileReadonly({ isBinary: true }), true);
  assert.equal(readonlyReason({ isBinary: true }), "Binary file cannot be edited");

  // Image file
  assert.equal(isFileReadonly({ isImage: true }), true);
  assert.equal(readonlyReason({ isImage: true }), "Image file cannot be edited");

  // Truncated large file
  assert.equal(isFileReadonly({ isTruncated: true }), true);
  assert.equal(readonlyReason({ isTruncated: true }), "File exceeds maximum size and cannot be safely edited");

  // Remote files over SSH are editable
  assert.equal(isFileReadonly({ on: "server-1" }), false);
  assert.equal(isFileReadonly({ on: "server-1", isBinary: true }), true);

  // File error
  assert.equal(isFileReadonly({ fileError: "Not found" }), true);
  assert.equal(readonlyReason({ fileError: "Not found" }), "Not found");
});

test("encodeBase64Chunks - encodes text into bounded base64 chunks", () => {
  assert.deepEqual(encodeBase64Chunks(""), [""]);
  assert.deepEqual(encodeBase64Chunks(null), []);
  assert.deepEqual(encodeBase64Chunks(undefined), []);

  const simple = encodeBase64Chunks("hello world");
  assert.equal(Buffer.from(simple.join(""), "base64").toString("utf-8"), "hello world");

  const text = "A".repeat(120);
  const chunks = encodeBase64Chunks(text, 50);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 50));
  assert.equal(Buffer.from(chunks.join(""), "base64").toString("utf-8"), text);

  // Unicode text
  const unicode = "Hello, 世界! 🚀\nLine 2 with special chars: ' \" ` $";
  const uniChunks = encodeBase64Chunks(unicode, 16);
  assert.equal(Buffer.from(uniChunks.join(""), "base64").toString("utf-8"), unicode);
});

test("shouldReloadWatchedFile - filters batch change events accurately", () => {
  const root = "/work/repo";
  const file = "src/main.js";

  // Batch overflow or empty/null signal -> always reloads
  assert.equal(shouldReloadWatchedFile(null, root, file), true);
  assert.equal(shouldReloadWatchedFile([], root, file), true);
  assert.equal(shouldReloadWatchedFile([root], root, file), true);

  // Exact file match
  assert.equal(shouldReloadWatchedFile([`${root}/${file}`], root, file), true);

  // Parent directory of the file changed
  assert.equal(shouldReloadWatchedFile([`${root}/src`], root, file), true);

  // Unrelated file changed -> do not reload
  assert.equal(shouldReloadWatchedFile([`${root}/package.json`, `${root}/README.md`], root, file), false);

  // Multiple changes with one relevant
  assert.equal(shouldReloadWatchedFile([`${root}/package.json`, `${root}/${file}`], root, file), true);

  // Relative path match
  assert.equal(shouldReloadWatchedFile(["src/main.js"], root, file), true);
  assert.equal(shouldReloadWatchedFile(["./src/main.js"], root, file), true);

  // Relative directory match
  assert.equal(shouldReloadWatchedFile(["src"], root, file), true);

  // Atomic/temp file write
  assert.equal(shouldReloadWatchedFile([`${root}/src/main.js.tmp.123`], root, file), true);
  assert.equal(shouldReloadWatchedFile(["src/main.js~"], root, file), true);

  // Suffix/symlinked path match
  assert.equal(shouldReloadWatchedFile([`/private${root}/${file}`], root, file), true);
});

test("buildSyntaxTheme - maps ANSI colors correctly with fallbacks", () => {
  const theme = {
    ansi1: "#bf616a",
    ansi2: "#a3be8c",
    ansi3: "#ebcb8b",
    ansi4: "#81a1c1",
    ansi5: "#b48ead",
    ansi6: "#88c0d0",
    dim: "#616e88",
  };

  const syntax = buildSyntaxTheme(theme);
  assert.equal(syntax.keyword, "#b48ead");
  assert.equal(syntax.string, "#a3be8c");
  assert.equal(syntax.comment, "#616e88");
  assert.equal(syntax.function, "#81a1c1");
  assert.equal(syntax.type, "#ebcb8b");
  assert.equal(syntax.number, "#bf616a");
  assert.equal(syntax.constant, "#88c0d0");

  // Fallbacks
  const fallback = buildSyntaxTheme({});
  assert.equal(typeof fallback.keyword, "string");
  assert.equal(typeof fallback.string, "string");
});

test("resolveLocationState - honors precedence, machine on, and previousCwd rules", () => {
  const spaces = [
    { id: "space-1", folder: "/spaces/space-1", machine: null, active: true },
    { id: "space-2", folder: "/spaces/space-2", machine: "server1", active: false },
  ];

  // 1. props.folder / props.cwd takes top precedence
  const rProps = resolveLocationState({
    props: { folder: "/custom/folder" },
    spaces,
    focused: { space: "space-1", cwd: "/focused/dir" },
    pinnedLocations: { "space-1": "/pinned/space-1" },
  });
  assert.equal(rProps.cwd, "/custom/folder");

  // 2. pinnedLocations takes second precedence
  const rPinned = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-1", cwd: "/focused/dir" },
    pinnedLocations: { "space-1": "/pinned/space-1" },
  });
  assert.equal(rPinned.cwd, "/pinned/space-1");

  // 3. focused pane cwd when focused.space === space.id
  const panes = [
    { pane: "p1", cwd: "/pane/cwd", terminal: "t1" },
    { pane: "p_mod", cwd: null, terminal: null },
  ];
  const rFocused = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-1", pane: "p1", cwd: "/focused/fallback" },
    panes,
    pinnedLocations: {},
  });
  assert.equal(rFocused.cwd, "/pane/cwd");

  // 4. Fallback to f.cwd when f.pane is not found in panes
  const rPaneNotFound = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-1", pane: "unknown_p", cwd: "/focused/direct" },
    panes,
  });
  assert.equal(rPaneNotFound.cwd, "/focused/direct");

  // 5. Preserving previousCwd when focusing a mod tab in the same space
  const rModPane = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-1", pane: "p_mod", cwd: null },
    panes,
    previousCwd: "/remembered/project",
    previousSpace: "space-1",
  });
  assert.equal(rModPane.cwd, "/remembered/project");

  // 6. previousCwd ignored if space has changed
  const rModPaneOtherSpace = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-1", pane: "p_mod", cwd: null },
    panes,
    previousCwd: "/remembered/project",
    previousSpace: "space-2",
  });
  assert.equal(rModPaneOtherSpace.cwd, "/spaces/space-1");

  // 7. focused cwd ignored when focused.space !== space.id -> falls back to space.folder
  const rInactiveFocus = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-2", cwd: "/other/cwd" },
    panes: [],
    pinnedLocations: {},
  });
  assert.equal(rInactiveFocus.cwd, "/spaces/space-1");

  // 8. Remote "on" machine leaks prevented:
  // f in inactive space with terminal prefix must NOT leak to active space
  const rInactiveTerminalLeak = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-2", pane: null, terminal: "remoteA/t1" },
  });
  assert.equal(rInactiveTerminalLeak.on, null);

  // Local terminal on remote space active -> space.machine
  const remoteSpaces = [
    { id: "space-rem", folder: "/remote/dir", machine: "remoteB", active: true },
  ];
  const rLocalTerminalOnRemote = resolveLocationState({
    props: {},
    spaces: remoteSpaces,
    focused: { space: "space-rem", pane: null, terminal: "t1" },
  });
  assert.equal(rLocalTerminalOnRemote.on, "remoteB");

  // Active space remote terminal prefix used when valid
  const rActiveRemoteTerminal = resolveLocationState({
    props: {},
    spaces: remoteSpaces,
    focused: { space: "space-rem", pane: null, terminal: "remoteC/t1" },
  });
  assert.equal(rActiveRemoteTerminal.on, "remoteC");

  // Explicit props.on overrides all
  const rExplicitOn = resolveLocationState({
    props: { on: "custom-host" },
    spaces,
    focused: null,
  });
  assert.equal(rExplicitOn.on, "custom-host");
});

test("resolveFileTab - manages cross-space tabs, strict tabId matching, and iterative disambiguation", () => {
  const rootA = "/work/repoA";
  const rootB = "/work/repoB";

  // Case 1: First file open -> creates tab with basename
  const r1 = resolveFileTab("src/index.js", rootA, [], {});
  assert.equal(r1.existingTabId, null);
  assert.equal(r1.tabName, "index.js");
  assert.equal(r1.updatedOpenTabs[`${rootA}/src/index.js`].tabName, "index.js");

  // Case 2: Cross-space tab preservation during pruning:
  // Entries from rootB must NOT be pruned when resolveFileTab is called with rootA and activeTabs from spaceA
  const openTabsMultiSpace = {
    [`${rootA}/src/index.js`]: { root: rootA, file: "src/index.js", tabName: "index.js", tabId: "tab-A1" },
    [`${rootB}/src/index.js`]: { root: rootB, file: "src/index.js", tabName: "index.js", tabId: "tab-B1" },
  };
  const activeTabsA = [{ id: "tab-A1", name: "index.js", settled: false, active: true }];
  const rCross = resolveFileTab("src/index.js", rootA, activeTabsA, openTabsMultiSpace);
  assert.equal(rCross.existingTabId, "tab-A1");
  // rootB entry is preserved intact!
  assert.equal(Boolean(rCross.updatedOpenTabs[`${rootB}/src/index.js`]), true);
  assert.equal(rCross.updatedOpenTabs[`${rootB}/src/index.js`].tabId, "tab-B1");

  // Case 3: Strict tabId matching:
  // If tabId is recorded as tab-1, but tab-1 was closed and a new unrelated tab is named "index.js" (tab-99),
  // it must NOT match tab-99!
  const staleTabMap = {
    [`${rootA}/src/index.js`]: { root: rootA, file: "src/index.js", tabName: "index.js", tabId: "tab-old" },
  };
  const activeTabsNew = [{ id: "tab-99", name: "index.js", settled: false, active: true }];
  const rStrict = resolveFileTab("src/index.js", rootA, activeTabsNew, staleTabMap);
  assert.equal(rStrict.existingTabId, null);
  // Disambiguates because tab-99 has name "index.js"
  assert.equal(rStrict.tabName, "src/index.js");

  // Case 4: Iterative disambiguation with counters:
  // When both base ("index.js") and dir/base ("lib/index.js") collide with live tabs
  const collidingTabs = [
    { id: "t1", name: "index.js", settled: false },
    { id: "t2", name: "lib/index.js", settled: false },
    { id: "t3", name: "lib/index.js (2)", settled: false },
  ];
  const rCounter = resolveFileTab("lib/index.js", rootA, collidingTabs, {});
  assert.equal(rCounter.existingTabId, null);
  assert.equal(rCounter.tabName, "lib/index.js (3)");

  // Case 5: Settled tabs are not treated as active matches
  const settledTabs = [{ id: "tab-1", name: "index.js", settled: true, active: false }];
  const rSettled = resolveFileTab("src/index.js", rootA, settledTabs, {
    [`${rootA}/src/index.js`]: { root: rootA, file: "src/index.js", tabName: "index.js", tabId: "tab-1" },
  });
  assert.equal(rSettled.existingTabId, null);
  assert.equal(rSettled.tabName, "index.js");
});

test("mergeOpenTabEntry - keeps recorded tabName and tabId when opened without a pane (R2-1)", () => {
  const existing = { root: "/r", file: "lib/index.js", tabName: "lib/index.js", tabId: "tab-7" };
  const merged = mergeOpenTabEntry(existing, { root: "/r", file: "lib/index.js", tabName: null, tabId: null });
  assert.deepEqual(merged, { root: "/r", file: "lib/index.js", tabName: "lib/index.js", tabId: "tab-7" });
});

test("mergeOpenTabEntry - fresh pane-derived name and tabId win over recorded values", () => {
  const existing = { root: "/r", file: "a.js", tabName: "old", tabId: "tab-1" };
  const merged = mergeOpenTabEntry(existing, { root: "/r", file: "a.js", tabName: "new", tabId: "tab-2" });
  assert.deepEqual(merged, { root: "/r", file: "a.js", tabName: "new", tabId: "tab-2" });
});

test("mergeOpenTabEntry - falls back to basename and omits tabId when nothing is known", () => {
  const merged = mergeOpenTabEntry(undefined, { root: "/r", file: "src/main.js", tabName: null, tabId: null });
  assert.deepEqual(merged, { root: "/r", file: "src/main.js", tabName: "main.js" });
  assert.equal("tabId" in merged, false);
});

test("resolveLocationState - focusing a mod pane does not borrow its cwd (new-space regression)", () => {
  const spaces = [
    { id: "space-new", folder: "/Users/me", machine: null, active: true, tabs: [{ id: "tab-new" }] },
  ];
  const panes = [
    { pane: "p_files", tab: "tab-new", terminal: null, cwd: "/stale/from/elsewhere" },
    { pane: "p_term", tab: "tab-new", terminal: "t1", cwd: "/Users/me/repo" },
  ];
  // Focus on the Files mod pane in a new space: the live terminal folder wins over space.folder.
  const rModNew = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-new", tab: "tab-new", pane: "p_files", cwd: "/stale/from/elsewhere" },
    panes,
    previousSpace: "space-old",
    previousCwd: "/old/project",
  });
  assert.equal(rModNew.cwd, "/Users/me/repo");

  // Same space, mod pane focused: previous cwd is still retained, not the mod pane's stale cwd.
  const rModSame = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-new", tab: "tab-new", pane: "p_files", cwd: "/stale/from/elsewhere" },
    panes,
    previousSpace: "space-new",
    previousCwd: "/remembered/project",
  });
  assert.equal(rModSame.cwd, "/remembered/project");

  // No terminal anywhere in the space: falls back to the stored folder.
  const rNoTerm = resolveLocationState({
    props: {},
    spaces,
    focused: { space: "space-new", tab: "tab-new", pane: "p_files", cwd: null },
    panes: [{ pane: "p_files", tab: "tab-new", terminal: null, cwd: null }],
    previousSpace: "space-old",
  });
  assert.equal(rNoTerm.cwd, "/Users/me");
});

test("parseMarkdownBlocks - headings, paragraphs, rules and quotes", () => {
  const blocks = parseMarkdownBlocks("# Title\n\nSome *soft* text\nwrapped.\n\n---\n\n> quoted\n> more");
  assert.deepEqual(blocks[0], { type: "heading", level: 1, text: "Title" });
  assert.deepEqual(blocks[1], { type: "paragraph", text: "Some *soft* text wrapped." });
  assert.deepEqual(blocks[2], { type: "hr" });
  assert.equal(blocks[3].type, "quote");
  assert.deepEqual(blocks[3].blocks, [{ type: "paragraph", text: "quoted more" }]);
});

test("parseMarkdownBlocks - fenced code keeps its body verbatim and ignores markdown inside", () => {
  const blocks = parseMarkdownBlocks("```js\n# not a heading\n  indented **x**\n```\nafter");
  assert.deepEqual(blocks[0], { type: "code", lang: "js", text: "# not a heading\n  indented **x**" });
  assert.equal(blocks[1].type, "paragraph");
});

test("parseMarkdownBlocks - unclosed fence runs to end of document", () => {
  const blocks = parseMarkdownBlocks("~~~\ncode");
  assert.deepEqual(blocks, [{ type: "code", lang: "", text: "code" }]);
});

test("parseMarkdownBlocks - nested and task lists", () => {
  const blocks = parseMarkdownBlocks("- [x] done\n  - child\n- [ ] todo\n\n1. first\n2. second");
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[0].items[0].checked, true);
  assert.equal(blocks[0].items[1].checked, false);
  assert.equal(blocks[0].items[0].blocks[1].type, "list");
  assert.equal(blocks[1].type, "list");
  assert.equal(blocks[1].ordered, true);
  assert.equal(blocks[1].start, 1);
  assert.equal(blocks[1].items.length, 2);
});

test("parseMarkdownBlocks - tables with alignment and escaped pipes", () => {
  const blocks = parseMarkdownBlocks("| a | b |\n|:-|-:|\n| 1 | x \\| y |");
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].align, ["left", "right"]);
  assert.equal(blocks[0].header.length, 2);
  assert.equal(blocks[0].rows[0][1], "x | y");
});

test("parseMarkdownBlocks - a line of pipes without a delimiter row is a paragraph", () => {
  const blocks = parseMarkdownBlocks("a | b\nc");
  assert.equal(blocks[0].type, "paragraph");
});

test("parseMarkdownBlocks - empty and non-string input", () => {
  assert.deepEqual(parseMarkdownBlocks(""), []);
  assert.deepEqual(parseMarkdownBlocks(null), []);
});


const MOD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "file-editor");

test("file icons - every mapped icon has an SVG and its light variant when declared", () => {
  const names = new Set([...Object.values(FILE_ICON_BY_EXT), ...Object.values(FILE_ICON_BY_NAME), FILE_ICON_DEFAULT, "folder-base", "tune"]);
  for (const name of names) {
    assert.ok(existsSync(join(MOD_DIR, "icons", `${name}.svg`)), `missing icons/${name}.svg`);
  }
  for (const light of ["bun_light", "pnpm_light", "toml_light"]) {
    assert.ok(existsSync(join(MOD_DIR, "icons", `${light}.svg`)), `missing icons/${light}.svg`);
  }
});

test("fileIconPath - each extension resolves to its own themed icon", () => {
  const expected = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react", ts: "typescript", tsx: "react_ts",
    py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "h",
    cpp: "cpp", hpp: "hpp", cs: "csharp", php: "php", lua: "lua", dart: "dart", ex: "elixir", zig: "zig",
    css: "css", scss: "sass", less: "less", html: "html", vue: "vue", svelte: "svelte",
    md: "markdown", mdx: "mdx", markdown: "markdown", txt: "document", log: "log",
    json: "json", xml: "xml", csv: "table", yaml: "yaml", yml: "yaml", toml: "toml", ini: "settings",
    sh: "console", ps1: "powershell", png: "image", jpg: "image", svg: "svg", mp4: "video", mp3: "audio",
    ogg: "audio", zip: "zip", pdf: "pdf", doc: "word", xls: "table", sql: "database", db: "database",
    pem: "key", crt: "certificate", exe: "exe", dll: "dll", wasm: "webassembly", class: "javaclass", jar: "jar",
  };
  for (const [ext, icon] of Object.entries(expected)) {
    assert.equal(fileIconPath(`file.${ext}`), `mods/file-editor/icons/${icon}.svg`, `.${ext}`);
  }
});

test("fileIconPath - exact names, env files, light variant and generic fallback", () => {
  assert.equal(fileIconPath(".gitignore"), "mods/file-editor/icons/git.svg");
  assert.equal(fileIconPath("package-lock.json"), "mods/file-editor/icons/nodejs.svg");
  assert.equal(fileIconPath("yarn.lock"), "mods/file-editor/icons/yarn.svg");
  assert.equal(fileIconPath("Cargo.lock"), "mods/file-editor/icons/lock.svg");
  assert.equal(fileIconPath(".env"), "mods/file-editor/icons/tune.svg");
  assert.equal(fileIconPath(".env.local"), "mods/file-editor/icons/tune.svg");
  assert.equal(fileIconPath("PKG.JS"), "mods/file-editor/icons/javascript.svg");
  assert.equal(fileIconPath("bun.lockb"), "mods/file-editor/icons/bun.svg");
  assert.equal(fileIconPath("bun.lockb", true), "mods/file-editor/icons/bun_light.svg");
  assert.equal(fileIconPath("main.js", true), "mods/file-editor/icons/javascript.svg");
  assert.equal(fileIconPath("notes.unknownext"), `mods/file-editor/icons/${FILE_ICON_DEFAULT}.svg`);
  assert.equal(fileIconPath("Dockerfile"), "mods/file-editor/icons/docker.svg");
  assert.equal(fileIconPath(".dockerignore"), "mods/file-editor/icons/docker.svg");
  assert.equal(fileIconPath("Makefile"), "mods/file-editor/icons/makefile.svg");
  assert.equal(fileIconPath(".hidden"), `mods/file-editor/icons/${FILE_ICON_DEFAULT}.svg`);
  assert.equal(fileIconPath(""), `mods/file-editor/icons/${FILE_ICON_DEFAULT}.svg`);
});

test("isLightColor - classifies hex backgrounds by luminance", () => {
  assert.equal(isLightColor("#ffffff"), true);
  assert.equal(isLightColor("#fff"), true);
  assert.equal(isLightColor("#1e1e2e"), false);
  assert.equal(isLightColor("000000"), false);
  assert.equal(isLightColor(undefined), false);
  assert.equal(isLightColor("not a color"), false);
});

test("isImageFile - raster images are pictures, SVG and text are not", () => {
  assert.equal(isImageFile("preview.PNG"), true);
  assert.equal(isImageFile("photo.jpeg"), true);
  assert.equal(isImageFile("anim.gif"), true);
  assert.equal(isImageFile("icon.svg"), false);
  assert.equal(isImageFile("main.js"), false);
  assert.equal(isImageFile("png"), false);
  assert.equal(isImageFile(".png"), false);
  assert.equal(isImageFile(""), false);
});

test("imageHeaderSize - reads dimensions without decoding pixels", () => {
  const bytes = (length) => new Uint8Array(length);
  const view = (data) => new DataView(data.buffer);
  const ascii = (data, offset, text) => {
    for (let i = 0; i < text.length; i += 1) data[offset + i] = text.charCodeAt(i);
  };

  const png = bytes(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  ascii(png, 12, "IHDR");
  view(png).setUint32(16, 640);
  view(png).setUint32(20, 480);
  assert.deepEqual(imageHeaderSize(png), { width: 640, height: 480 });

  const gif = bytes(16);
  ascii(gif, 0, "GIF89a");
  view(gif).setUint16(6, 320, true);
  view(gif).setUint16(8, 200, true);
  assert.deepEqual(imageHeaderSize(gif), { width: 320, height: 200 });

  const bmp = bytes(26);
  ascii(bmp, 0, "BM");
  view(bmp).setInt32(18, 1024, true);
  view(bmp).setInt32(22, -768, true);
  assert.deepEqual(imageHeaderSize(bmp), { width: 1024, height: 768 });

  const jpeg = bytes(24);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  view(jpeg).setUint16(7, 300, false);
  view(jpeg).setUint16(9, 500, false);
  assert.deepEqual(imageHeaderSize(jpeg), { width: 500, height: 300 });

  const webp = bytes(30);
  ascii(webp, 0, "RIFF");
  ascii(webp, 8, "WEBP");
  ascii(webp, 12, "VP8X");
  view(webp).setUint32(16, 10, true);
  webp[24] = 799 & 0xff;
  webp[25] = (799 >> 8) & 0xff;
  webp[26] = (799 >> 16) & 0xff;
  webp[27] = 449 & 0xff;
  webp[28] = (449 >> 8) & 0xff;
  webp[29] = (449 >> 16) & 0xff;
  assert.deepEqual(imageHeaderSize(webp), { width: 800, height: 450 });

  const ico = bytes(22);
  ico.set([0, 0, 1, 0, 1, 0, 32, 24], 0);
  assert.deepEqual(imageHeaderSize(ico), { width: 32, height: 24 });

  // Minimal AVIF: ftyp + meta/iprp/ipco/ispe.
  const avif = bytes(68);
  const dv = view(avif);
  let o = 0;
  const box = (size, type) => {
    dv.setUint32(o, size, false);
    ascii(avif, o + 4, type);
    o += 8;
  };
  box(20, "ftyp");
  ascii(avif, o, "avif");
  o += 4;
  dv.setUint32(o, 0, false);
  o += 4;
  ascii(avif, o, "mif1");
  o += 4;
  box(48, "meta");
  dv.setUint32(o, 0, false);
  o += 4;
  box(36, "iprp");
  box(28, "ipco");
  box(20, "ispe");
  dv.setUint32(o, 0, false);
  o += 4;
  dv.setUint32(o, 640, false);
  o += 4;
  dv.setUint32(o, 480, false);
  o += 4;
  assert.deepEqual(imageHeaderSize(avif), { width: 640, height: 480 });

  assert.equal(imageHeaderSize(new Uint8Array([0, 1, 2, 3])), null);
  assert.equal(imageHeaderSize(new Uint8Array(32)), null);
  assert.equal(imageHeaderSize(null), null);
  assert.equal(imageHeaderSize(undefined), null);
});

test("normalizeImageZoom - clamps to the supported range and defaults to fit", () => {
  assert.equal(normalizeImageZoom(1), 1);
  assert.equal(normalizeImageZoom(0.1), IMAGE_ZOOM_MIN);
  assert.equal(normalizeImageZoom(99), IMAGE_ZOOM_MAX);
  assert.equal(normalizeImageZoom(-2), IMAGE_ZOOM_MIN);
  assert.equal(normalizeImageZoom(Number.NaN), 1);
  assert.equal(normalizeImageZoom(Infinity), 1);
  assert.equal(normalizeImageZoom("2"), 1);
  assert.equal(normalizeImageZoom(undefined), 1);
});

test("stepImageZoom - walks the level ladder and stops at the ends", () => {
  assert.equal(stepImageZoom(1, 1), 1.25);
  assert.equal(stepImageZoom(1, -1), 0.75);
  assert.equal(stepImageZoom(0.25, -1), IMAGE_ZOOM_MIN);
  assert.equal(stepImageZoom(4, 1), IMAGE_ZOOM_MAX);
  assert.equal(stepImageZoom(1, 0), 1);
  assert.equal(stepImageZoom(0.8, 1), 1);
  assert.equal(stepImageZoom(0.8, -1), 0.75);
  assert.equal(stepImageZoom(Number.NaN, 1), 1.25);

  let zoom = IMAGE_ZOOM_MIN;
  const visited = [zoom];
  for (let i = 0; i < IMAGE_ZOOM_LEVELS.length + 3; i += 1) {
    zoom = stepImageZoom(zoom, 1);
    visited.push(zoom);
  }
  assert.deepEqual(visited, [...IMAGE_ZOOM_LEVELS, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MAX]);
});

test("imageZoomPercent - formats a canvas width and toolbar label", () => {
  assert.equal(imageZoomPercent(1), "100%");
  assert.equal(imageZoomPercent(1.25), "125%");
  assert.equal(imageZoomPercent(0.25), "25%");
  assert.equal(imageZoomPercent(4), "400%");
  assert.equal(imageZoomPercent(99), "400%");
  assert.equal(imageZoomPercent(Number.NaN), "100%");
});

test("getAncestorFolders - generates ordered list of ancestor folders", () => {
  assert.deepEqual(getAncestorFolders("README.md"), []);
  assert.deepEqual(getAncestorFolders("src/index.js"), ["src"]);
  assert.deepEqual(getAncestorFolders("mods/file-editor/main.js"), ["mods", "mods/file-editor"]);
  assert.deepEqual(getAncestorFolders("a/b/c/d/e.txt"), ["a", "a/b", "a/b/c", "a/b/c/d"]);
  assert.deepEqual(getAncestorFolders(""), []);
  assert.deepEqual(getAncestorFolders(null), []);
  assert.deepEqual(getAncestorFolders(undefined), []);
  assert.deepEqual(getAncestorFolders("   "), []);
  assert.deepEqual(getAncestorFolders("src\\components\\Button.tsx"), ["src", "src/components"]);
});

test("normalizeFileToRoot - resolves files within target root and rejects outside paths", () => {
  // Matching relative file with fileRoot
  assert.equal(
    normalizeFileToRoot("src/index.js", "/Users/me/project", "/Users/me/project"),
    "src/index.js"
  );
  // Matching absolute file
  assert.equal(
    normalizeFileToRoot("/Users/me/project/README.md", null, "/Users/me/project"),
    "README.md"
  );
  // Matching nested absolute file
  assert.equal(
    normalizeFileToRoot("/Users/me/project/mods/file-editor/main.js", null, "/Users/me/project"),
    "mods/file-editor/main.js"
  );
  // File outside target root
  assert.equal(
    normalizeFileToRoot("/Users/me/other-project/src/index.js", null, "/Users/me/project"),
    null
  );
  assert.equal(
    normalizeFileToRoot("src/index.js", "/Users/me/other-project", "/Users/me/project"),
    null
  );
  // Target root equals file path exactly (directory, not file)
  assert.equal(
    normalizeFileToRoot("/Users/me/project", null, "/Users/me/project"),
    null
  );
  // Relative file without fileRoot inside currentRoot
  assert.equal(
    normalizeFileToRoot("package.json", null, "/Users/me/project"),
    "package.json"
  );
  // Escaping relative path
  assert.equal(
    normalizeFileToRoot("../other/file.js", null, "/Users/me/project"),
    null
  );
  // Windows-style paths
  assert.equal(
    normalizeFileToRoot("C:\\Users\\me\\project\\src\\App.tsx", null, "C:/Users/me/project"),
    "src/App.tsx"
  );
  // macOS symlinked path alias (e.g. /Documents/Workspaces vs /workspaces)
  assert.equal(
    normalizeFileToRoot(
      "mods/file-editor/file-logic.js",
      "/Users/me/workspaces/herdr/herdr-file-editor",
      "/Users/me/Documents/Workspaces/herdr/herdr-file-editor"
    ),
    "mods/file-editor/file-logic.js"
  );
  assert.equal(
    normalizeFileToRoot(
      "/Users/me/workspaces/herdr/herdr-file-editor/mods/file-editor/file-logic.js",
      null,
      "/Users/me/Documents/Workspaces/herdr/herdr-file-editor"
    ),
    "mods/file-editor/file-logic.js"
  );
  // Empty or invalid input
  assert.equal(normalizeFileToRoot("", "/repo", "/repo"), null);
  assert.equal(normalizeFileToRoot(null, "/repo", "/repo"), null);
});

test("resolveActiveOpenedFile - detects active file from focused pane, active tab, openTabs, and activeFile", () => {
  const currentRoot = "/Users/me/project";

  // 1. Matches from focused pane
  const focusedPaneResult = resolveActiveOpenedFile({
    focused: { pane: "p1", tab: "t1" },
    panes: [{ pane: "p1", tab: "t1", mod: "file-editor", props: { folder: currentRoot, file: "src/main.js" } }],
    currentRoot,
  });
  assert.equal(focusedPaneResult, "src/main.js");

  // 2. Matches from active tab in active space via pane
  const activeTabPaneResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t2", active: true, name: "README.md" }] }],
    panes: [{ pane: "p2", tab: "t2", mod: "file-editor", props: { folder: currentRoot, file: "README.md" } }],
    currentRoot,
  });
  assert.equal(activeTabPaneResult, "README.md");

  // 3. Matches from active tab via openTabs map by tabId
  const openTabsIdResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t3", active: true, name: "tab-custom" }] }],
    openTabs: {
      "key-1": { tabId: "t3", root: currentRoot, file: "mods/file-editor/main.js" },
    },
    currentRoot,
  });
  assert.equal(openTabsIdResult, "mods/file-editor/main.js");

  // 4. Matches from active tab via openTabs map by tabName
  const openTabsNameResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t4", active: true, name: "file-logic.js" }] }],
    openTabs: {
      "key-2": { tabName: "file-logic.js", root: currentRoot, file: "mods/file-editor/file-logic.js" },
    },
    currentRoot,
  });
  assert.equal(openTabsNameResult, "mods/file-editor/file-logic.js");

  // 5. Matches from shared activeFile
  const activeFileResult = resolveActiveOpenedFile({
    activeFile: { root: currentRoot, file: "package.json" },
    currentRoot,
  });
  assert.equal(activeFileResult, "package.json");

  // 6. Active file from a different root returns null
  const otherRootResult = resolveActiveOpenedFile({
    activeFile: { root: "/Users/me/other-repo", file: "package.json" },
    currentRoot,
  });
  assert.equal(otherRootResult, null);

  // 7. Nothing open or matching returns null
  const noneResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t_term", active: true, name: "Terminal" }] }],
    panes: [{ pane: "p_term", tab: "t_term", terminal: "term_1" }],
    currentRoot,
  });
  assert.equal(noneResult, null);

  // 8. Matches from active Diff tab (e.g. "Diff · AGENTS.md" in git-graph or changes)
  const diffTabResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t_diff", active: true, name: "Diff · AGENTS.md" }] }],
    entries: new Map([["", [{ name: "AGENTS.md", dir: false }, { name: "README.md", dir: false }]]]),
    currentRoot,
  });
  assert.equal(diffTabResult, "AGENTS.md");

  // 9. Matches from active Diff tab with git working-tree marks for nested file
  const diffNestedResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t_diff2", active: true, name: "Diff · file-logic.js" }] }],
    marks: {
      [`${currentRoot}/mods/file-editor/file-logic.js`]: "M",
    },
    currentRoot,
  });
  assert.equal(diffNestedResult, "mods/file-editor/file-logic.js");

  // 10. Active tab wins over background shared activeFile
  const activeTabPrecedenceResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t_diff3", active: true, name: "Diff · AGENTS.md" }] }],
    activeFile: { root: currentRoot, file: "stale-background-file.js" },
    entries: new Map([["", [{ name: "AGENTS.md", dir: false }]]]),
    currentRoot,
  });
  assert.equal(activeTabPrecedenceResult, "AGENTS.md");

  // 11. Active tab "file-logic.js" resolves to subfolder via openTabs entry
  const subfolderFromOpenTabsResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t_fl", active: true, name: "file-logic.js" }] }],
    openTabs: {
      "key_fl": {
        root: "/Users/me/workspaces/herdr/herdr-file-editor",
        file: "mods/file-editor/file-logic.js",
        tabName: "file-logic.js",
      },
    },
    entries: new Map([["", [{ name: "AGENTS.md", dir: false }]]]),
    currentRoot: "/Users/me/Documents/Workspaces/herdr/herdr-file-editor",
  });
  assert.equal(subfolderFromOpenTabsResult, "mods/file-editor/file-logic.js");

  // 12. Active Diff tab "Diff · file-logic.js" resolves to subfolder via activeFile
  const diffSubfolderFromActiveFileResult = resolveActiveOpenedFile({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t_diff_fl", active: true, name: "Diff · file-logic.js" }] }],
    activeFile: {
      root: "/Users/me/workspaces/herdr/herdr-file-editor",
      file: "mods/file-editor/file-logic.js",
    },
    entries: new Map([["", [{ name: "AGENTS.md", dir: false }]]]),
    currentRoot: "/Users/me/Documents/Workspaces/herdr/herdr-file-editor",
  });
  assert.equal(diffSubfolderFromActiveFileResult, "mods/file-editor/file-logic.js");
});

test("parseTabFileName - extracts candidate filename from various tab titles", () => {
  assert.equal(parseTabFileName("Diff · AGENTS.md"), "AGENTS.md");
  assert.equal(parseTabFileName("Diff · AGENTS.md (working tree)"), "AGENTS.md");
  assert.equal(parseTabFileName("Diff · AGENTS.md (9f3c2a1)"), "AGENTS.md");
  assert.equal(parseTabFileName("Diff - AGENTS.md"), "AGENTS.md");
  assert.equal(parseTabFileName("Diff: AGENTS.md"), "AGENTS.md");
  assert.equal(parseTabFileName("AGENTS.md"), "AGENTS.md");
  assert.equal(parseTabFileName("main.js (mods/file-editor)"), "mods/file-editor/main.js");
  assert.equal(parseTabFileName("Diff · main.js (mods/file-editor)"), "mods/file-editor/main.js");
  assert.equal(parseTabFileName("file-logic.js (2)"), "file-logic.js");
  assert.equal(parseTabFileName("Terminal"), "Terminal");
  assert.equal(parseTabFileName(""), null);
  assert.equal(parseTabFileName(null), null);
});

test("matchCandidateFile - verifies candidate against root entries, marks, and paths", () => {
  const root = "/Users/me/project";
  const entries = new Map([
    ["", [{ name: "AGENTS.md", dir: false }, { name: "mods", dir: true }]],
    ["mods", [{ name: "file-editor", dir: true }]],
    ["mods/file-editor", [{ name: "main.js", dir: false }]],
  ]);
  const marks = {
    [`${root}/mods/file-editor/file-logic.js`]: "M",
  };

  // Direct root match
  assert.equal(matchCandidateFile("AGENTS.md", root, entries, marks), "AGENTS.md");

  // Explicit relative path
  assert.equal(matchCandidateFile("mods/file-editor/main.js", root, entries, marks), "mods/file-editor/main.js");

  // Match in marks
  assert.equal(matchCandidateFile("file-logic.js", root, entries, marks), "mods/file-editor/file-logic.js");

  // Match in openTabs
  const openTabs = {
    key1: { file: "mods/file-editor/file-logic.js", tabName: "file-logic.js", root },
  };
  assert.equal(matchCandidateFile("file-logic.js", root, entries, {}, openTabs), "mods/file-editor/file-logic.js");

  // Match in activeFile
  const activeFile = { file: "mods/file-editor/file-logic.js", root };
  assert.equal(matchCandidateFile("file-logic.js", root, entries, {}, {}, activeFile), "mods/file-editor/file-logic.js");

  // Non-file label without extension
  assert.equal(matchCandidateFile("Terminal", root, entries, marks), null);
  assert.equal(matchCandidateFile("Git Graph", root, entries, marks), null);
});
