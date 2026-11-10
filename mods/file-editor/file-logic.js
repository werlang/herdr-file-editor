/**
 * Pure, deterministic logic helpers for herdr-file-editor.
 * No imports from "herdr", "gpui-kit", or "gpui-base" so this module
 * can be tested directly in Node.js test runners.
 */

/**
 * Splits a file path into its base filename, parent directory, and extension.
 * Normalizes backslashes to forward slashes.
 *
 * @param {string} [filePath]
 * @returns {{ base: string, dir: string, ext: string }}
 */
export function splitPathInfo(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { base: "", dir: "", ext: "" };
  }
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const base = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";

  let ext = "";
  if (base === "." || base === "..") {
    return { base, dir, ext: "" };
  }

  const lastDot = base.lastIndexOf(".");
  if (lastDot > 0 && lastDot < base.length - 1) {
    ext = base.slice(lastDot + 1).toLowerCase();
  } else if (lastDot === 0 && base.length > 1) {
    // Dotfile without additional extension, e.g. .gitignore
    ext = base.slice(1).toLowerCase();
  }

  return { base, dir, ext };
}

/**
 * Normalizes root and file path parameters for tab mode initialization.
 * Strips redundant leading/trailing slashes and extracts root when an absolute file is passed.
 *
 * @param {Record<string, any>} [props]
 * @returns {{ root: string, file: string }}
 */
export function normalizeTabTarget(props) {
  const p = props || {};
  let rawRoot = typeof p.folder === "string" ? p.folder : typeof p.cwd === "string" ? p.cwd : "";
  let rawFile = typeof p.file === "string" ? p.file : "";

  rawRoot = rawRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  rawFile = rawFile.replace(/\\/g, "/");

  if (!rawRoot && rawFile.startsWith("/")) {
    const lastSlash = rawFile.lastIndexOf("/");
    if (lastSlash > 0) {
      rawRoot = rawFile.slice(0, lastSlash);
      rawFile = rawFile.slice(lastSlash + 1);
    }
  }

  if (rawRoot && rawFile.startsWith(rawRoot + "/")) {
    rawFile = rawFile.slice(rawRoot.length + 1);
  }

  rawFile = rawFile.replace(/^\/+/, "");

  return { root: rawRoot, file: rawFile };
}

/**
 * Resolves the absolute filesystem path for an entry relative to the workspace root.
 *
 * @param {string} [root]
 * @param {string} [relativePath]
 * @returns {string}
 */
export function resolveAbsolutePath(root, relativePath) {
  const cleanRel = (relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!root) return cleanRel;
  const cleanRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return cleanRel ? `${cleanRoot}/${cleanRel}` : cleanRoot;
}

/**
 * Language mapping table for EditorState syntax highlighting.
 * @type {Record<string, { language: string, label: string }>}
 */
const EXTENSION_MAP = {
  js: { language: "js", label: "JavaScript" },
  mjs: { language: "js", label: "JavaScript" },
  cjs: { language: "js", label: "JavaScript" },
  ts: { language: "js", label: "TypeScript" },
  mts: { language: "js", label: "TypeScript" },
  cts: { language: "js", label: "TypeScript" },
  jsx: { language: "js", label: "JSX" },
  tsx: { language: "js", label: "TSX" },
  json: { language: "json", label: "JSON" },
  jsonc: { language: "json", label: "JSON" },
  html: { language: "html", label: "HTML" },
  htm: { language: "html", label: "HTML" },
  css: { language: "css", label: "CSS" },
  scss: { language: "css", label: "SCSS" },
  sass: { language: "css", label: "SASS" },
  less: { language: "css", label: "LESS" },
  md: { language: "markdown", label: "Markdown" },
  markdown: { language: "markdown", label: "Markdown" },
  mdx: { language: "markdown", label: "MDX" },
  rs: { language: "rust", label: "Rust" },
  py: { language: "python", label: "Python" },
  go: { language: "go", label: "Go" },
  c: { language: "c", label: "C" },
  h: { language: "c", label: "C Header" },
  cpp: { language: "cpp", label: "C++" },
  cc: { language: "cpp", label: "C++" },
  cxx: { language: "cpp", label: "C++" },
  hpp: { language: "cpp", label: "C++ Header" },
  sh: { language: "bash", label: "Shell" },
  bash: { language: "bash", label: "Bash" },
  zsh: { language: "bash", label: "Zsh" },
  yaml: { language: "yaml", label: "YAML" },
  yml: { language: "yaml", label: "YAML" },
  toml: { language: "yaml", label: "TOML" },
  xml: { language: "xml", label: "XML" },
  svg: { language: "xml", label: "SVG" },
  sql: { language: "sql", label: "SQL" },
  vue: { language: "html", label: "Vue" },
  svelte: { language: "html", label: "Svelte" },
  java: { language: "java", label: "Java" },
  rb: { language: "ruby", label: "Ruby" },
  php: { language: "php", label: "PHP" },
  lua: { language: "lua", label: "Lua" },
  swift: { language: "swift", label: "Swift" },
  kt: { language: "kotlin", label: "Kotlin" },
  kts: { language: "kotlin", label: "Kotlin" },
  txt: { language: "text", label: "Text" },
};

/**
 * Exact filename mapping for special build and configuration files.
 * @type {Record<string, { language: string, label: string }>}
 */
const SPECIAL_FILE_MAP = {
  dockerfile: { language: "dockerfile", label: "Dockerfile" },
  containerfile: { language: "dockerfile", label: "Containerfile" },
  makefile: { language: "makefile", label: "Makefile" },
  gnumakefile: { language: "makefile", label: "Makefile" },
  "cmakelists.txt": { language: "cmake", label: "CMake" },
  gemfile: { language: "ruby", label: "Ruby" },
  rakefile: { language: "ruby", label: "Ruby" },
  "cargo.lock": { language: "yaml", label: "TOML" },
  "package.json": { language: "json", label: "JSON" },
  ".gitignore": { language: "text", label: "Gitignore" },
  ".npmignore": { language: "text", label: "Ignore" },
  ".dockerignore": { language: "text", label: "Ignore" },
};

/**
 * Detects the programming language and human-readable label for a given file path.
 *
 * @param {string} filePath
 * @returns {{ language: string, label: string }}
 */
export function detectLanguage(filePath) {
  const { base, ext } = splitPathInfo(filePath);
  const lowerBase = base.toLowerCase();

  if (SPECIAL_FILE_MAP[lowerBase]) {
    return SPECIAL_FILE_MAP[lowerBase];
  }

  if (ext && EXTENSION_MAP[ext]) {
    return EXTENSION_MAP[ext];
  }

  return {
    language: ext || "text",
    label: ext ? ext.toUpperCase() : "Text",
  };
}

/**
 * Checks if a given file path is a Markdown document.
 *
 * @param {string} [filePath]
 * @returns {boolean}
 */
export function isMarkdownFile(filePath) {
  const { ext } = splitPathInfo(filePath);
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

/**
 * Checks if a given file path is an SVG document.
 *
 * @param {string} [filePath]
 * @returns {boolean}
 */
export function isSvgFile(filePath) {
  const { ext } = splitPathInfo(filePath);
  return ext === "svg";
}

/** Longest intrinsic side of a generated SVG preview, in pixels. */
export const SVG_PREVIEW_SIZE = 1600;

/**
 * Rewrites an SVG root's width/height so the host rasterizes a crisp preview.
 *
 * The host image loader rasterizes an SVG at the intrinsic width/height in its
 * root element and then scales that bitmap to the layout bounds. Icon SVGs are
 * commonly 24×24 and turn blurry when enlarged, so the preview copy gets a
 * large intrinsic size while its viewBox (and therefore its aspect ratio) is
 * left untouched.
 *
 * @param {string} text SVG source
 * @param {number} [maxSize=SVG_PREVIEW_SIZE] Longest side of the generated preview
 * @returns {{ text: string, width: number, height: number } | null}
 *   Rewritten SVG and its intrinsic size, or null when no root `<svg>` tag was found
 */
export function prepareSvgPreviewInfo(text, maxSize = SVG_PREVIEW_SIZE) {
  if (typeof text !== "string") return null;
  const root = /<svg\b[^>]*>/i.exec(text);
  if (!root) return null;
  const tag = root[0];

  /** Reads a single length attribute, ignoring percentages and other units. */
  const readLength = (name) => {
    const attr = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(tag);
    if (!attr) return null;
    const value = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(attr[2]);
    return value ? Number(value[1]) : null;
  };

  const viewBoxAttr = /\sviewBox\s*=\s*(["'])([^"']*)\1/i.exec(tag);
  const viewBox = viewBoxAttr ? viewBoxAttr[2].trim().split(/[\s,]+/).map(Number) : null;
  const hasViewBox =
    Array.isArray(viewBox) &&
    viewBox.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0;

  let width = hasViewBox ? viewBox[2] : readLength("width");
  let height = hasViewBox ? viewBox[3] : readLength("height");
  if (!width && !height) {
    // The SVG specification's default viewport for a root without a size.
    width = 300;
    height = 150;
  } else if (!width) {
    width = height;
  } else if (!height) {
    height = width;
  }

  const target = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : SVG_PREVIEW_SIZE;
  const scale = target / Math.max(width, height);
  const pxWidth = Math.max(1, Math.round(width * scale));
  const pxHeight = Math.max(1, Math.round(height * scale));

  const rewritten = tag
    .replace(/\swidth\s*=\s*(["'])[^"']*\1/gi, "")
    .replace(/\sheight\s*=\s*(["'])[^"']*\1/gi, "")
    .replace(/^<svg/i, `<svg width="${pxWidth}" height="${pxHeight}"`);

  return {
    text: text.slice(0, root.index) + rewritten + text.slice(root.index + tag.length),
    width: pxWidth,
    height: pxHeight,
  };
}

/**
 * Rewrites an SVG root so the host rasterizes a crisp preview.
 *
 * @param {string} text SVG source
 * @param {number} [maxSize=SVG_PREVIEW_SIZE] Longest side of the generated preview
 * @returns {string | null} Rewritten SVG, or null when no root `<svg>` tag was found
 */
export function prepareSvgPreview(text, maxSize = SVG_PREVIEW_SIZE) {
  return prepareSvgPreviewInfo(text, maxSize)?.text ?? null;
}

/**
 * Determines the default view mode for a file ("preview" or "code").
 * Markdown and SVG files default to "preview" unless explicitly set to "code".
 * All other files always use "code".
 *
 * @param {string} filePath
 * @param {string} [requestedMode]
 * @returns {"preview" | "code"}
 */
export function defaultViewMode(filePath, requestedMode) {
  if (isMarkdownFile(filePath) || isSvgFile(filePath)) {
    return requestedMode === "code" ? "code" : "preview";
  }
  return "code";
}

/**
 * Maximum character threshold before text truncation.
 */
export const DEFAULT_MAX_CHARS = 400000;

/**
 * Computes the line count of text to match the editor gutter count.
 * Trailing newline is subtracted to align with standard line numbering.
 *
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function countLines(text) {
  if (typeof text !== "string" || text === "") return 0;
  return text.split("\n").length - Number(text.endsWith("\n"));
}

/**
 * Checks whether edited text differs from the saved original text.
 *
 * @param {string | null | undefined} current
 * @param {string | null | undefined} original
 * @returns {boolean}
 */
export function isContentDirty(current, original) {
  if (typeof current !== "string" && typeof original !== "string") return false;
  return (current ?? "") !== (original ?? "");
}

/**
 * Chunks a string into an array of base64 chunks, each within size limits.
 * Used for safely transferring file text to remote machines over SSH without
 * exceeding per-argument command line bounds (MAX_ARG_STRLEN).
 *
 * @param {string} text - UTF-8 string to encode.
 * @param {number} [chunkSize=50000] - Maximum character size per base64 chunk.
 * @returns {string[]}
 */
export function encodeBase64Chunks(text, chunkSize = 50000) {
  if (typeof text !== "string") return [];
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  if (b64.length === 0) return [""];
  const size = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : 50000;
  const chunks = [];
  for (let i = 0; i < b64.length; i += size) {
    chunks.push(b64.slice(i, i + size));
  }
  return chunks;
}

/**
 * Determines whether a file tab is in read-only mode.
 * Remote files over SSH are editable via remote execution.
 *
 * @param {{
 *   isBinary?: boolean,
 *   isImage?: boolean,
 *   isTruncated?: boolean,
 *   on?: string | null,
 *   fileError?: string | null
 * } | null | undefined} [state]
 * @returns {boolean}
 */
export function isFileReadonly(state) {
  if (!state) return false;
  return Boolean(
    state.isBinary ||
    state.isImage ||
    state.isTruncated ||
    state.fileError
  );
}

/**
 * Explains why a file is read-only.
 *
 * @param {{
 *   isBinary?: boolean,
 *   isImage?: boolean,
 *   isTruncated?: boolean,
 *   on?: string | null,
 *   fileError?: string | null
 * } | null | undefined} [state]
 * @returns {string}
 */
export function readonlyReason(state) {
  if (!state) return "Read-only";
  if (state.fileError) return state.fileError;
  if (state.isBinary) return "Binary file cannot be edited";
  if (state.isImage) return "Image file cannot be edited";
  if (state.isTruncated) return "File exceeds maximum size and cannot be safely edited";
  return "Read-only";
}

/**
 * Prepares file text for rendering: checks for missing file, binary null bytes,
 * line count (subtracting trailing newline to match Editor gutter count), and truncates large files.
 *
 * @param {string | null | undefined} rawText
 * @param {number} [maxChars=400000]
 * @returns {{
 *   error: string | null,
 *   text: string | null,
 *   lineCount: number,
 *   isBinary: boolean,
 *   isTruncated: boolean
 * }}
 */
export function prepareFileText(rawText, maxChars = DEFAULT_MAX_CHARS) {
  if (rawText === null || rawText === undefined) {
    return {
      error: "This file is no longer available",
      text: null,
      lineCount: 0,
      isBinary: false,
      isTruncated: false,
    };
  }

  if (typeof rawText !== "string") {
    return {
      error: "Cannot preview this file (binary, too large, or unreadable)",
      text: null,
      lineCount: 0,
      isBinary: false,
      isTruncated: false,
    };
  }

  if (rawText.includes("\0")) {
    return {
      error: "Binary file · no text preview",
      text: null,
      lineCount: 0,
      isBinary: true,
      isTruncated: false,
    };
  }

  const lineCount = countLines(rawText);
  const isTruncated = rawText.length > maxChars;
  const text = isTruncated
    ? `${rawText.slice(0, maxChars)}\n… (file truncated)`
    : rawText;

  return {
    error: null,
    text,
    lineCount,
    isBinary: false,
    isTruncated,
  };
}

/**
 * Evaluates whether a batch of changed filesystem paths requires reloading an open file tab.
 *
 * @param {string[] | null | undefined} changedPaths
 * @param {string | null | undefined} root
 * @param {string | null | undefined} file
 * @returns {boolean}
 */
export function shouldReloadWatchedFile(changedPaths, root, file) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return true;
  }
  const normRoot = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const normFile = typeof file === "string" ? file.replace(/\\/g, "/").replace(/^\/+/, "") : "";
  const normFull = normRoot ? `${normRoot}/${normFile}` : normFile;

  for (const p of changedPaths) {
    if (typeof p !== "string") continue;
    let normP = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normP.startsWith("./")) normP = normP.slice(2);

    // Batch overflow or root change:
    if (normP === normRoot || (normRoot && normRoot.startsWith(normP + "/"))) return true;
    // Exact file match (full or relative):
    if (normP === normFull || normP === normFile) return true;
    // Suffix match (e.g. symlinked, container or realpath prefixes):
    if (normFile && normP.endsWith("/" + normFile)) return true;
    // Parent directory of the file was modified:
    if (normFull && normFull.startsWith(normP + "/")) return true;
    if (normFile && normFile.startsWith(normP + "/")) return true;
    // Changed path is inside the file:
    if (normP.startsWith(normFull + "/")) return true;
    // Atomic/temp file write for this file (e.g. main.js.tmp.123 or main.js~):
    if (normP.startsWith(normFull + ".") || normP.startsWith(normFull + "~")) return true;
    if (normP.startsWith(normFile + ".") || normP.startsWith(normFile + "~")) return true;
  }
  return false;
}

/** A list item marker: indent, bullet or number, then whitespace. */
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;

/** A code fence opener: up to 3 spaces of indent, then 3+ backticks or tildes, then an info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** ATX heading: 1-6 hashes, then text, with an optional closing sequence. */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/** Thematic break: three or more of the same rule character. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Block quote marker. */
const QUOTE = /^ {0,3}>/;

/** Table delimiter row: pipes, colons and dashes, with at least one dash. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Parses Markdown source into a block tree for a GitHub-style renderer.
 * Blocks: heading, paragraph, code, quote (nested blocks), list (items with nested
 * blocks and task state), table, hr. Inline Markdown stays raw in `text` fields.
 *
 * @param {string} text
 * @returns {MarkdownBlock[]}
 */
export function parseMarkdownBlocks(text) {
  const source = typeof text === "string" ? text : "";
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

/**
 * @typedef {{ type: "heading", level: number, text: string }
 *   | { type: "paragraph", text: string }
 *   | { type: "code", lang: string, text: string }
 *   | { type: "quote", blocks: MarkdownBlock[] }
 *   | { type: "list", ordered: boolean, start: number, items: Array<{ checked: boolean | null, blocks: MarkdownBlock[] }> }
 *   | { type: "table", align: string[], header: string[], rows: string[][] }
 *   | { type: "hr" }} MarkdownBlock
 */

/**
*/

/** @returns {number} Count of leading spaces (tabs count as 4). */
function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * Splits one table row into trimmed cell sources.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * True when a line starts a block that interrupts a paragraph.
 *
 * @param {string} line
 * @returns {boolean}
 */
function startsBlock(line) {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    (LIST_ITEM.test(line) && line.trim() !== "")
  );
}

/**
 * Parses a list of source lines into blocks.
 *
 * @param {string[]} lines
 * @returns {MarkdownBlock[]}
 */
function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1];
      const closer = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] || "" });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const align = splitRow(lines[i + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"
      );
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item && indentOf(line) < 4) {
      const indent = indentOf(line);
      const ordered = /\d/.test(item[2][0]);
      const list = { type: "list", ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: [] };
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || indentOf(lines[i]) !== indent || /\d/.test(m[2][0]) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + m[3].length;
        const body = [m[4]];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (next.trim() === "") {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === "") j++;
            if (j < lines.length && indentOf(lines[j]) > indent) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(next) <= indent) break;
          body.push(next.slice(Math.min(indentOf(next), contentIndent)));
          i++;
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body[0]);
        if (task) body[0] = task[2];
        list.items.push({ checked: task ? task[1].toLowerCase() === "x" : null, blocks: parseBlocks(body) });
      }
      blocks.push(list);
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

/**
 * Maps Herdr theme ANSI and semantic colors to EditorState syntax theme tokens.
 *
 * @param {Record<string, string>} [themeObj={}]
 * @returns {Record<string, string>}
 */
export function buildSyntaxTheme(themeObj = {}) {
  const t = themeObj || {};
  return {
    keyword: t.ansi5 || "#b48ead",
    string: t.ansi2 || "#a3be8c",
    comment: t.dim || "#616e88",
    function: t.ansi4 || "#81a1c1",
    type: t.ansi3 || "#ebcb8b",
    number: t.ansi1 || "#bf616a",
    constant: t.ansi6 || "#88c0d0",
  };
}

/**
 * Resolves the workspace location honoring active space, pinned location, focused cwd
 * strictly when focused space matches active space, and space folder fallback.
 * Retains previousCwd when focusing a mod tab in the same space. Mod panes never supply a cwd;
 * a live terminal cwd in the active space is preferred over the stored space folder.
 *
 * @param {{
 *   props?: Record<string, any>,
 *   spaces?: Array<{ id: string, folder?: string, machine?: string | null, active?: boolean, tabs?: Array<{ id: string }> }>,
 *   focused?: { space?: string, pane?: string | null, terminal?: string | null, cwd?: string | null } | null,
 *   panes?: Array<{ pane: string, tab?: string, cwd?: string | null, terminal?: string | null }>,
 *   pinnedLocations?: Record<string, string>,
 *   previousCwd?: string | null,
 *   previousSpace?: string | null
 * }} options
 * @returns {{ cwd: string | null, on: string | null, space: string | null }}
 */
export function resolveLocationState({
  props,
  spaces,
  focused,
  panes,
  pinnedLocations,
  previousCwd = null,
  previousSpace = null,
}) {
  const p = props || {};
  const spaceList = Array.isArray(spaces) ? spaces : [];
  const space = spaceList.find((s) => s.active) || null;
  const spaceId = space?.id ?? null;

  const pinned = spaceId && pinnedLocations ? pinnedLocations[spaceId] : null;
  const f = focused || null;
  const isFocusedInActiveSpace = Boolean(f && spaceId && f.space === spaceId);

  // A mod pane has no folder of its own, so focusing one must not borrow a cwd.
  let focusedCwd = null;
  let isModPane = false;
  if (isFocusedInActiveSpace) {
    const matchedPane = f.pane && Array.isArray(panes) ? panes.find((item) => item.pane === f.pane) : null;
    isModPane = Boolean(matchedPane && !matchedPane.terminal);
    if (!isModPane) {
      focusedCwd = matchedPane?.cwd || f.cwd || null;
    }
  }

  // Preserve previousCwd when focusing a mod pane or pane with no cwd in the same active space
  let retainedCwd = null;
  if (isFocusedInActiveSpace && (!focusedCwd || isModPane)) {
    if (previousSpace && spaceId && previousSpace === spaceId && previousCwd) {
      retainedCwd = previousCwd;
    }
  }

  // Live folder of a terminal in the active space, before the stored space folder, which
  // herdr can leave at $HOME or another space's repo for a freshly created space.
  const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
  const spaceTerminals = (Array.isArray(panes) ? panes : []).filter(
    (pn) => pn.terminal && pn.cwd && spaceTabIds.has(pn.tab)
  );
  const spaceTerminalCwd = (spaceTerminals.find((pn) => pn.tab === f?.tab) || spaceTerminals[0])?.cwd || null;

  const cwd =
    p.folder || p.cwd || pinned || focusedCwd || retainedCwd || spaceTerminalCwd || space?.folder || null;

  const remoteFromTerminal =
    isFocusedInActiveSpace && f?.pane === null && typeof f?.terminal === "string" && f.terminal.includes("/")
      ? f.terminal.split("/")[0]
      : null;
  const on = p.on !== undefined ? p.on : remoteFromTerminal || (space?.machine ?? null);

  return { cwd, on, space: spaceId };
}

/**
 * Resolves or generates the target tab for a given file.
 * Preserves tabs belonging to other roots/spaces during pruning.
 * Matches strictly by tabId once tabId is known.
 * Disambiguates colliding tab names iteratively with counters.
 *
 * @param {string} filePath
 * @param {string | null} root
 * @param {Array<{ id: string, name: string, settled?: boolean }>} activeTabs
 * @param {Record<string, { tabId?: string, tabName?: string, root?: string | null, file?: string }>} [openTabsMap={}]
 * @param {Array<{ id: string, name: string, settled?: boolean }>} [allTabs=activeTabs] - Tabs from every space, used only to preserve entries that are still alive elsewhere.
 * @returns {{
 *   existingTabId: string | null,
 *   tabName: string,
 *   updatedOpenTabs: Record<string, { tabId?: string, tabName?: string, root?: string | null, file?: string }>
 * }}
 */
export function resolveFileTab(filePath, root, activeTabs, openTabsMap = {}, allTabs = activeTabs) {
  const normFile = typeof filePath === "string" ? filePath.replace(/\\/g, "/") : "";
  const normRoot = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : null;
  const fileKey = normRoot ? `${normRoot}/${normFile}` : normFile;

  const tabs = Array.isArray(activeTabs) ? activeTabs : [];
  const liveTabs = tabs.filter((t) => t && !t.settled);
  const everyTab = Array.isArray(allTabs) ? allTabs : tabs;
  const everyLiveTab = everyTab.filter((t) => t && !t.settled);

  // Prune openTabsMap entries whose tab is no longer live in any space.
  // Preserve entries from other roots/spaces untouched!
  const updatedOpenTabs = {};
  if (openTabsMap && typeof openTabsMap === "object") {
    for (const [key, val] of Object.entries(openTabsMap)) {
      if (val && typeof val === "object") {
        const valRoot = typeof val.root === "string" ? val.root.replace(/\\/g, "/").replace(/\/+$/, "") : null;
        const isDifferentRoot = valRoot && normRoot && valRoot !== normRoot;
        if (isDifferentRoot) {
          updatedOpenTabs[key] = { ...val };
          continue;
        }

        // Check if recorded tabName/tabId was poisoned and clean it
        let cleanTabName = val.tabName;
        let cleanTabId = val.tabId;
        if (val.file && cleanTabName && !isTabMatchingFile(cleanTabName, val.file, valRoot || normRoot)) {
          cleanTabName = splitPathInfo(val.file).base || "File";
          cleanTabId = null;
        }

        // Strict tabId matching when tabId is known
        const isStillLive = everyLiveTab.some((t) => {
          if (typeof cleanTabId === "string" && cleanTabId.length > 0) {
            return t.id === cleanTabId && (!val.file || isTabMatchingFile(t.name, val.file, valRoot || normRoot));
          }
          return (
            typeof cleanTabName === "string" &&
            cleanTabName.length > 0 &&
            t.name === cleanTabName &&
            (!val.file || isTabMatchingFile(t.name, val.file, valRoot || normRoot))
          );
        });

        if (isStillLive) {
          const entry = { ...val, tabName: cleanTabName };
          if (cleanTabId) {
            entry.tabId = cleanTabId;
          } else {
            delete entry.tabId;
          }
          updatedOpenTabs[key] = entry;
        }
      }
    }
  }

  // Collect all tabIds that are ALREADY claimed by OTHER files in updatedOpenTabs
  const claimedTabIds = new Set();
  for (const [key, entry] of Object.entries(updatedOpenTabs)) {
    if (key !== fileKey && entry && typeof entry === "object" && entry.tabId) {
      claimedTabIds.add(entry.tabId);
    }
  }

  // Check if our file already has a live recorded tab
  const recorded = updatedOpenTabs[fileKey];
  if (recorded) {
    const matchedLiveTab = liveTabs.find((t) => {
      if (typeof recorded.tabId === "string" && recorded.tabId.length > 0) {
        return t.id === recorded.tabId && isTabMatchingFile(t.name, normFile, normRoot);
      }
      // Never match a tab that is already claimed by a different file
      if (claimedTabIds.has(t.id)) {
        return false;
      }
      return (
        typeof recorded.tabName === "string" &&
        recorded.tabName.length > 0 &&
        t.name === recorded.tabName &&
        isTabMatchingFile(t.name, normFile, normRoot)
      );
    });

    if (matchedLiveTab) {
      updatedOpenTabs[fileKey] = {
        ...recorded,
        tabId: matchedLiveTab.id,
        tabName: matchedLiveTab.name,
      };
      return {
        existingTabId: matchedLiveTab.id,
        tabName: matchedLiveTab.name,
        updatedOpenTabs,
      };
    }
  }

  // Deduce tab title
  const { base, dir } = splitPathInfo(normFile);
  const defaultTitle = base || "File";

  const hasCollision = (name) => liveTabs.some((t) => t.name === name);
  let tabName = defaultTitle;

  if (hasCollision(tabName)) {
    let candidate = "";
    if (dir) {
      candidate = `${dir}/${base}`;
    } else if (normRoot) {
      const rootBase = normRoot.split("/").filter(Boolean).pop() || "";
      candidate = rootBase ? `${rootBase}/${base}` : base;
    } else {
      candidate = base;
    }

    if (!hasCollision(candidate)) {
      tabName = candidate;
    } else {
      let n = 2;
      while (hasCollision(`${candidate} (${n})`)) {
        n++;
      }
      tabName = `${candidate} (${n})`;
    }
  }

  // Record into updatedOpenTabs
  updatedOpenTabs[fileKey] = {
    root: normRoot,
    file: normFile,
    tabName,
  };

  return {
    existingTabId: null,
    tabName,
    updatedOpenTabs,
  };
}

/**
 * Whether a recorded open tab is a VS Code-style preview (temporary) tab.
 *
 * @param {{ preview?: boolean } | null | undefined} entry
 * @returns {boolean}
 */
export function isPreviewOpenTab(entry) {
  return Boolean(entry && typeof entry === "object" && entry.preview === true);
}

/**
 * Returns a copy of the openTabs map with one file's preview flag set or
 * cleared. Clearing removes the field instead of storing `false`, so permanent
 * tabs keep the same shape they had before preview tabs existed.
 *
 * @param {Record<string, any>} openTabs
 * @param {string} fileKey
 * @param {boolean} preview
 * @returns {Record<string, any>}
 */
export function setOpenTabPreview(openTabs, fileKey, preview) {
  const map = openTabs && typeof openTabs === "object" ? openTabs : {};
  const entry = map[fileKey];
  if (!entry || typeof entry !== "object") return { ...map };
  const updated = { ...map };
  if (preview) {
    updated[fileKey] = { ...entry, preview: true };
  } else {
    const { preview: _preview, ...rest } = entry;
    updated[fileKey] = rest;
  }
  return updated;
}

/**
 * Promotes one file's preview entry to permanent. Kept separate from the view
 * so the promotion write can be tested without a GPUI harness.
 *
 * @param {Record<string, any>} openTabs
 * @param {string} fileKey
 * @returns {{ next: Record<string, any>, promoted: boolean }}
 */
export function promotePreviewEntry(openTabs, fileKey) {
  const map = openTabs && typeof openTabs === "object" ? openTabs : {};
  if (!isPreviewOpenTab(map[fileKey])) {
    return { next: { ...map }, promoted: false };
  }
  return { next: setOpenTabPreview(map, fileKey, false), promoted: true };
}

/**
 * Collects live preview tabs in a space, resolving each to its real tab id.
 * Used to replace the previous temporary tab when another file is opened in
 * preview mode, and to italicize the file in the Files pane.
 *
 * A recorded tab id is authoritative: when it is present but stale, the entry
 * is never matched by name (a different tab could own that name). The name
 * fallback exists only for the first frames of a freshly created tab, before
 * its view has registered the id.
 *
 * @param {Record<string, any>} openTabs
 * @param {Array<{ id: string, name: string, settled?: boolean, panes?: number, index?: number }>} activeTabs
 * @param {string | null} root
 * @param {string | null} [excludeKey=null]
 * @param {{ matchRoot?: boolean, editorTabIds?: Set<string> | string[] | null }} [options={}]
 * @returns {Array<{ key: string, tabId: string, tabName: string, entry: Record<string, any> }>}
 */
export function collectPreviewTabs(openTabs, activeTabs, root, excludeKey = null, options = {}) {
  const map = openTabs && typeof openTabs === "object" ? openTabs : {};
  const tabs = (Array.isArray(activeTabs) ? activeTabs : []).filter((tab) => tab && !tab.settled);
  const normRoot = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : null;
  const matchRoot = options?.matchRoot !== false;
  const hasEditorFilter = options?.editorTabIds !== undefined && options?.editorTabIds !== null;
  const editorTabIds =
    options?.editorTabIds instanceof Set
      ? options.editorTabIds
      : new Set(Array.isArray(options?.editorTabIds) ? options.editorTabIds : []);
  const found = [];

  for (const [key, entry] of Object.entries(map)) {
    if (excludeKey && key === excludeKey) continue;
    if (!isPreviewOpenTab(entry)) continue;

    const entryRoot = typeof entry.root === "string" ? entry.root.replace(/\\/g, "/").replace(/\/+$/, "") : null;
    if (matchRoot && normRoot && entryRoot && entryRoot !== normRoot) continue;

    const hasId = typeof entry.tabId === "string" && entry.tabId.length > 0;
    const byId = hasId ? tabs.find((tab) => tab.id === entry.tabId) : null;
    const byName = hasId
      ? null
      : tabs.find(
          (tab) =>
            entry.tabName &&
            tab.name === entry.tabName &&
            (!entry.file || isTabMatchingFile(tab.name, entry.file, entry.root || normRoot))
        );
    const tab = byId || byName;
    if (!tab) continue;
    if (hasEditorFilter && !editorTabIds.has(tab.id)) continue;

    found.push({ key, tabId: tab.id, tabName: tab.name, entry });
  }

  return found;
}

/**
 * Plans the replacement of the previous preview tab when another file is opened
 * as a preview in the same space. Pinned previews and previews whose tab has
 * extra panes (a split terminal or another file) are promoted instead of
 * closed: closing those would destroy unrelated work, which VS Code never does
 * for a preview editor.
 *
 * The returned `nextOpenTabs` already drops the entries that will be closed and
 * clears the flag of the ones promoted, so the caller writes it once.
 *
 * @param {Record<string, any>} openTabs
 * @param {Array<{ id: string, name: string, settled?: boolean, panes?: number, index?: number }>} activeTabs
 * @param {string | null} root
 * @param {string} fileKey
 * @param {Set<string> | string[]} [pinnedTabIds=[]]
 * @param {Set<string> | string[] | null} [editorTabIds=null]
 * @returns {{
 *   nextOpenTabs: Record<string, any>,
 *   closeTabIds: string[],
 *   deferredCloseTabIds: string[],
 *   replaceIndex: number | null,
 * }}
 */
export function planPreviewOpen(
  openTabs,
  activeTabs,
  root,
  fileKey,
  pinnedTabIds = [],
  editorTabIds = null
) {
  const tabs = Array.isArray(activeTabs) ? activeTabs : [];
  const pinned = pinnedTabIds instanceof Set ? pinnedTabIds : new Set(pinnedTabIds ?? []);
  let nextOpenTabs = openTabs && typeof openTabs === "object" ? { ...openTabs } : {};
  const replaceable = [];

  // One preview per space, regardless of which folder the Explorer is showing.
  const previews = collectPreviewTabs(openTabs, tabs, root, fileKey, {
    matchRoot: false,
    editorTabIds,
  });

  for (const preview of previews) {
    const tab = tabs.find((candidate) => candidate.id === preview.tabId);
    const hasExtraPanes = typeof tab?.panes === "number" && tab.panes > 1;
    if (pinned.has(preview.tabId) || hasExtraPanes) {
      nextOpenTabs = setOpenTabPreview(nextOpenTabs, preview.key, false);
    } else {
      replaceable.push(preview);
    }
  }

  let replaceIndex = null;
  if (replaceable.length > 0) {
    const first = tabs.find((tab) => tab.id === replaceable[0].tabId);
    replaceIndex = typeof first?.index === "number" ? first.index : null;
  }

  const closeTabIds = [];
  const deferredCloseTabIds = [];
  const liveTabCount = tabs.filter((tab) => tab && !tab.settled).length;
  // Closing every live tab before the replacement exists would close the whole
  // space (Herdr asks for confirmation when the last tab goes).
  const deferred = replaceable.length > 0 && liveTabCount <= replaceable.length;
  for (const preview of replaceable) {
    delete nextOpenTabs[preview.key];
    (deferred ? deferredCloseTabIds : closeTabIds).push(preview.tabId);
  }

  return { nextOpenTabs, closeTabIds, deferredCloseTabIds, replaceIndex };
}

/**
 * Builds the shared openTabs entry for a file tab being registered.
 * Keeps a previously recorded tabName/tabId unless the incoming values supply
 * a fresher one, so a tab opened without a pane (e.g. via `tab.new`) cannot
 * overwrite a disambiguated name such as "lib/index.js" with its basename.
 *
 * @param {{ tabId?: string, tabName?: string, preview?: boolean } | null | undefined} existing - Current entry for this file, if any.
 * @param {{ root: string | null, file: string, tabName?: string | null, tabId?: string | null, preview?: boolean }} incoming - Values known for this open.
 * @returns {{ root: string | null, file: string, tabName: string, tabId?: string, preview?: boolean }}
 */
export function mergeOpenTabEntry(existing, incoming) {
  const prev = existing && typeof existing === "object" ? existing : {};
  const tabId = incoming.tabId || prev.tabId;
  const tabName = incoming.tabName || prev.tabName || splitPathInfo(incoming.file).base || "File";
  const preview = incoming.preview === undefined ? prev.preview === true : incoming.preview === true;

  return {
    root: incoming.root,
    file: incoming.file,
    tabName,
    ...(tabId ? { tabId } : {}),
    ...(preview ? { preview: true } : {}),
  };
}

/**
 * Icons by exact file name (Git, lock and tool files), keyed by lowercase name.
 * Values are icon names from Material Icon Theme; the SVGs live in `icons/`.
 */
export const FILE_ICON_BY_NAME = {
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  "bun.lockb": "bun",
  "cargo.lock": "lock",
  "gemfile.lock": "ruby",
  "go.sum": "go-mod",
  dockerfile: "docker",
  ".dockerignore": "docker",
  makefile: "makefile",
  "package-lock.json": "nodejs",
  "pnpm-lock.yaml": "pnpm",
  "poetry.lock": "poetry",
  "yarn.lock": "yarn",
};

/**
 * Icons by lowercase extension, without the dot. Values are icon names from
 * Material Icon Theme; the SVGs live in `icons/`.
 */
export const FILE_ICON_BY_EXT = {
  "7z": "zip",
  a: "lib",
  avi: "video",
  avif: "image",
  bash: "console",
  bat: "console",
  bin: "hex",
  bmp: "image",
  bz2: "zip",
  c: "c",
  cc: "cpp",
  cer: "certificate",
  cfg: "settings",
  cjs: "javascript",
  class: "javaclass",
  clj: "clojure",
  cmd: "console",
  conf: "settings",
  config: "settings",
  cpp: "cpp",
  crt: "certificate",
  cs: "csharp",
  css: "css",
  csv: "table",
  cxx: "cpp",
  dart: "dart",
  db: "database",
  dll: "dll",
  doc: "word",
  docx: "word",
  dylib: "dll",
  editorconfig: "settings",
  erl: "erlang",
  ex: "elixir",
  exe: "exe",
  exs: "elixir",
  fish: "console",
  flac: "audio",
  gif: "image",
  go: "go",
  gz: "zip",
  h: "h",
  hpp: "hpp",
  hs: "haskell",
  htm: "html",
  html: "html",
  ico: "image",
  ini: "settings",
  jar: "jar",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "react",
  key: "key",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lock: "lock",
  log: "log",
  lua: "lua",
  m4a: "audio",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  o: "exe",
  odt: "word",
  ogg: "audio",
  pages: "document",
  pdf: "pdf",
  pem: "key",
  php: "php",
  pl: "prolog",
  png: "image",
  properties: "settings",
  ps1: "powershell",
  py: "python",
  pyc: "python-misc",
  r: "r",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  rst: "markdown",
  rtf: "word",
  sass: "sass",
  scala: "scala",
  scss: "sass",
  sh: "console",
  so: "dll",
  sql: "database",
  sqlite: "database",
  sqlite3: "database",
  styl: "stylus",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  text: "document",
  tgz: "zip",
  tif: "image",
  tiff: "image",
  toml: "toml",
  ts: "typescript",
  tsv: "table",
  tsx: "react_ts",
  txt: "document",
  vue: "vue",
  wasm: "webassembly",
  wav: "audio",
  webm: "video",
  webp: "image",
  xhtml: "html",
  xls: "table",
  xlsx: "table",
  xml: "xml",
  xz: "zip",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zip: "zip",
  zsh: "console",
};

/** Icons that have a light-background variant (`<name>_light.svg`). */
const FILE_ICON_LIGHT = new Set(["bun", "pnpm", "toml"]);

/** Generic icon for files whose type is unknown. */
export const FILE_ICON_DEFAULT = "document";

/** Icon for folders, relative to the Herdr app folder. */
export const FOLDER_ICON_PATH = "mods/file-editor/icons/folder-base.svg";

/**
 * True when a color (hex like "#1e1e2e" or "#fff") is light, by perceived luminance.
 *
 * @param {string | undefined} color
 * @returns {boolean}
 */
export function isLightColor(color) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? "").trim());
  if (!m) return false;
  const hex = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

/**
 * Chooses the icon for a file by its name: exact names first (Git and lock files,
 * `.env` variants), then the extension. Unknown files get the generic icon. On a
 * light background the `_light` variant is used when the theme provides one.
 *
 * @param {string} fileName Base name only.
 * @param {boolean} [light=false] True when the theme background is light.
 * @returns {string} Path to the SVG, relative to the Herdr app folder.
 */
export function fileIconPath(fileName, light = false) {
  const name = typeof fileName === "string" ? fileName : "";
  const lower = name.toLowerCase();
  let icon = FILE_ICON_DEFAULT;
  if (lower === ".env" || lower.startsWith(".env.")) {
    icon = "tune";
  } else if (FILE_ICON_BY_NAME[lower]) {
    icon = FILE_ICON_BY_NAME[lower];
  } else {
    const dot = lower.lastIndexOf(".");
    const ext = dot > 0 ? lower.slice(dot + 1) : "";
    if (FILE_ICON_BY_EXT[ext]) icon = FILE_ICON_BY_EXT[ext];
  }
  const variant = light && FILE_ICON_LIGHT.has(icon) ? `${icon}_light` : icon;
  return `mods/file-editor/icons/${variant}.svg`;
}

/** Raster image extensions, previewed as pictures. (SVG is vector/text and supports both preview and code). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/**
 * True when a file is a raster image to show as a picture instead of text.
 *
 * @param {string} fileName
 * @returns {boolean}
 */
export function isImageFile(fileName) {
  const lower = typeof fileName === "string" ? fileName.toLowerCase() : "";
  const dot = lower.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.has(lower.slice(dot + 1));
}

/**
 * Reads the pixel dimensions of a picture from its file header, without
 * decoding the pixels. Used to lay out picture previews with the right aspect
 * ratio and a zoom level that is relative to the fit-to-pane size.
 *
 * PNG, JPEG, GIF, BMP, WebP, ICO and AVIF are understood. Anything else (a
 * truncated file, an exotic codec) returns null and the preview falls back to
 * the host's natural-size rendering.
 *
 * @param {Uint8Array | ArrayLike<number> | null | undefined} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function imageHeaderSize(bytes) {
  if (!bytes || typeof bytes.length !== "number" || bytes.length < 16) return null;
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  /** Reads an ASCII signature. */
  const ascii = (start, length) => {
    let out = "";
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(data[start + i]);
    return out;
  };

  const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

  // PNG: 8-byte signature, IHDR width/height as big-endian uint32.
  if (data[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return size(view.getUint32(16, false), view.getUint32(20, false));
  }

  // GIF: logical screen width/height as little-endian uint16.
  if (/^GIF8[79]a$/.test(ascii(0, 6)) && data.length >= 10) {
    return size(view.getUint16(6, true), view.getUint16(8, true));
  }

  // BMP: header width/height, usually bottom-up so the height can be negative.
  if (ascii(0, 2) === "BM" && data.length >= 26) {
    return size(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
  }

  // JPEG: walk the marker segments until a start-of-frame carries the size.
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = data[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = view.getUint16(i + 2, false);
      if (length < 2) break;
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return size(view.getUint16(i + 7, false), view.getUint16(i + 5, false));
      }
      i += 2 + length;
    }
    return null;
  }

  // WebP: RIFF container with VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    let i = 12;
    while (i + 8 <= data.length) {
      const type = ascii(i, 4);
      const length = view.getUint32(i + 4, true);
      const payload = i + 8;
      if (type === "VP8X" && payload + 10 <= data.length) {
        const width = 1 + data[payload + 4] + (data[payload + 5] << 8) + (data[payload + 6] << 16);
        const height = 1 + data[payload + 7] + (data[payload + 8] << 8) + (data[payload + 9] << 16);
        return size(width, height);
      }
      if (type === "VP8 " && payload + 10 <= data.length) {
        return size(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff);
      }
      if (type === "VP8L" && payload + 5 <= data.length && data[payload] === 0x2f) {
        const bits = view.getUint32(payload + 1, true);
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      i = payload + length + (length & 1);
    }
    return null;
  }

  // AVIF: ISO BMFF boxes. Find the still-image size in meta/iprp/ipco/ispe,
  // taking the largest one when a file carries several.
  if (ascii(4, 4) === "ftyp") {
    let best = null;
    /** Walks the boxes in [start, end), calling visit(type, payloadStart, boxEnd). */
    const walk = (start, end, visit) => {
      let i = start;
      while (i + 8 <= end) {
        let boxSize = view.getUint32(i, false);
        const type = ascii(i + 4, 4);
        let header = 8;
        if (boxSize === 1 && i + 16 <= end) {
          // 64-bit size: two big-endian uint32 halves, no BigInt required.
          const high = view.getUint32(i + 8, false);
          const low = view.getUint32(i + 12, false);
          boxSize = high * 2 ** 32 + low;
          header = 16;
        } else if (boxSize === 0) {
          boxSize = end - i;
        }
        if (boxSize < header || i + boxSize > end) break;
        visit(type, i + header, i + boxSize);
        i += boxSize;
      }
    };

    walk(0, data.length, (type, payload, end) => {
      if (type !== "meta") return;
      walk(payload + 4, end, (child, childPayload, childEnd) => {
        if (child !== "iprp") return;
        walk(childPayload, childEnd, (iprpChild, ipcoPayload, ipcoEnd) => {
          if (iprpChild !== "ipco") return;
          walk(ipcoPayload, ipcoEnd, (property, ispePayload, ispeEnd) => {
            if (property !== "ispe" || ispePayload + 12 > ispeEnd) return;
            const width = view.getUint32(ispePayload + 4, false);
            const height = view.getUint32(ispePayload + 8, false);
            if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
              best = { width, height };
            }
          });
        });
      });
    });
    return best;
  }

  // ICO/CUR: 16-byte directory entry; a zero dimension means 256.
  if (data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
    return size(data[6] || 256, data[7] || 256);
  }

  return null;
}

/**
 * Zoom steps for picture previews, as scale factors where 1 means "fit the
 * pane". The steps are uneven on purpose: small adjustments around 100%, then
 * larger jumps toward the extremes.
 *
 * @type {readonly number[]}
 */
export const IMAGE_ZOOM_LEVELS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);

/** Smallest selectable picture preview zoom. */
export const IMAGE_ZOOM_MIN = IMAGE_ZOOM_LEVELS[0];

/** Largest selectable picture preview zoom. */
export const IMAGE_ZOOM_MAX = IMAGE_ZOOM_LEVELS[IMAGE_ZOOM_LEVELS.length - 1];

/**
 * Coerces an arbitrary value into a supported picture preview zoom.
 * Invalid or non-finite input falls back to 100% (fit to pane).
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeImageZoom(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, value));
}

/**
 * Moves to the next zoom level in the given direction.
 *
 * @param {unknown} current Current zoom, already clamped or not.
 * @param {number} direction Positive zooms in, negative zooms out, 0 is a no-op.
 * @returns {number}
 */
export function stepImageZoom(current, direction) {
  const zoom = normalizeImageZoom(current);
  if (!Number.isFinite(direction) || direction === 0) return zoom;

  if (direction > 0) {
    for (const level of IMAGE_ZOOM_LEVELS) {
      if (level > zoom) return level;
    }
    return IMAGE_ZOOM_MAX;
  }

  for (let i = IMAGE_ZOOM_LEVELS.length - 1; i >= 0; i -= 1) {
    if (IMAGE_ZOOM_LEVELS[i] < zoom) return IMAGE_ZOOM_LEVELS[i];
  }
  return IMAGE_ZOOM_MIN;
}

/**
 * Formats a zoom factor as the width used by the preview canvas and as the
 * label in the toolbar ("125%").
 *
 * @param {unknown} zoom
 * @returns {`${number}%`}
 */
export function imageZoomPercent(zoom) {
  return /** @type {`${number}%`} */ (`${Math.round(normalizeImageZoom(zoom) * 100)}%`);
}

/**
 * Splits a relative file path into an ordered list of its ancestor directory paths.
 * E.g. "a/b/c/file.txt" -> ["a", "a/b", "a/b/c"]
 *
 * @param {string} [filePath]
 * @returns {string[]}
 */
export function getAncestorFolders(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return [];
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (parts.length <= 1) return [];

  const ancestors = [];
  let current = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    ancestors.push(current);
  }
  return ancestors;
}

/**
 * Normalizes a file and its root relative to a target workspace root.
 * Returns the relative file path if it resides within currentRoot, or null if outside.
 * Handles macOS symlinks and path aliases (e.g. /Documents/Workspaces vs /workspaces).
 *
 * @param {string | null} file
 * @param {string | null} [fileRoot]
 * @param {string | null} [currentRoot]
 * @returns {string | null}
 */
export function normalizeFileToRoot(file, fileRoot, currentRoot) {
  if (typeof file !== "string" || !file.trim()) return null;
  const normFile = file.replace(/\\/g, "/").trim();
  const normFileRoot = typeof fileRoot === "string" ? fileRoot.replace(/\\/g, "/").replace(/\/+$/, "").trim() : null;
  const normCurrentRoot =
    typeof currentRoot === "string" ? currentRoot.replace(/\\/g, "/").replace(/\/+$/, "").trim() : null;

  const isAbsolute = normFile.startsWith("/") || /^[a-zA-Z]:\//.test(normFile);

  // If already relative without escaping "../"
  if (!isAbsolute && !normFile.startsWith("../")) {
    const cleanRel = normFile.replace(/^\/+/, "");
    if (!normFileRoot || !normCurrentRoot || normFileRoot === normCurrentRoot) {
      return cleanRel;
    }
    const currentBase = normCurrentRoot.split("/").filter(Boolean).pop();
    const fileRootBase = normFileRoot.split("/").filter(Boolean).pop();
    if (currentBase && fileRootBase && currentBase === fileRootBase) {
      return cleanRel;
    }
  }

  // Handle absolute path
  const fullPath = isAbsolute
    ? normFile
    : normFileRoot
      ? `${normFileRoot}/${normFile.replace(/^\/+/, "")}`
      : null;

  if (normCurrentRoot && fullPath) {
    if (fullPath === normCurrentRoot) return null;
    if (fullPath.startsWith(normCurrentRoot + "/")) {
      return fullPath.slice(normCurrentRoot.length + 1);
    }
    // Handle symlink / path alias where currentRoot's repo folder name matches
    const currentBase = normCurrentRoot.split("/").filter(Boolean).pop();
    if (currentBase) {
      const marker = `/${currentBase}/`;
      const idx = fullPath.lastIndexOf(marker);
      if (idx >= 0) {
        return fullPath.slice(idx + marker.length);
      }
    }
    return null;
  }

  if (fullPath) return fullPath;
  return !isAbsolute && !normFile.startsWith("../") ? normFile.replace(/^\/+/, "") : null;
}

/**
 * Attempts to parse a candidate file name or relative path from a tab name.
 * Handles patterns such as:
 * - "Diff · AGENTS.md"
 * - "Diff · AGENTS.md (working tree)"
 * - "Diff · AGENTS.md (9f3c2a1)"
 * - "Diff - AGENTS.md"
 * - "Diff: AGENTS.md"
 * - "main.js (mods/file-editor)"
 * - "AGENTS.md"
 *
 * @param {string} [tabName]
 * @returns {string | null}
 */
export function parseTabFileName(tabName) {
  if (typeof tabName !== "string" || !tabName.trim()) return null;
  let raw = tabName.trim();

  // Strip diff prefixes like "Diff · ", "Diff - ", "Diff: "
  raw = raw.replace(/^Diff\s*[\u00B7\-\:]\s*/i, "").trim();
  if (!raw) return null;

  // Check for trailing parentheses like "(working tree)", "(9f3c2a1)", "(mods/file-editor)", or "(2)"
  const parenMatch = /\s*\(([^)]+)\)$/.exec(raw);
  if (parenMatch) {
    const inner = parenMatch[1].trim();
    const beforeParen = raw.slice(0, parenMatch.index).trim();

    // If inner contains slashes, it's a directory disambiguator (e.g. "main.js (mods/file-editor)")
    if (inner.includes("/")) {
      const normInner = inner.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      return beforeParen ? `${normInner}/${beforeParen}` : normInner;
    }

    // If inner is just a counter, commit hash, or "working tree", the filename is beforeParen
    if (beforeParen) {
      raw = beforeParen;
    }
  }

  return raw || null;
}

/**
 * Checks whether a tab name matches a file path.
 * Tab names can be the basename ("main.js"), a relative path ("src/main.js"),
 * disambiguated with folder ("main.js (src)"), counter ("main.js (2)"),
 * diff prefix ("Diff · main.js"), or root prefix ("repo/main.js").
 *
 * @param {string | null | undefined} tabName
 * @param {string | null | undefined} filePath
 * @param {string | null | undefined} [root]
 * @returns {boolean}
 */
export function isTabMatchingFile(tabName, filePath, root) {
  if (typeof tabName !== "string" || !tabName.trim()) return false;
  if (typeof filePath !== "string" || !filePath.trim()) return false;

  const normFile = filePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const { base, dir } = splitPathInfo(normFile);
  if (!base) return false;

  const parsed = parseTabFileName(tabName);
  if (!parsed) return false;

  const normParsed = parsed.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  // 1. Direct equality with file basename or relative file path
  if (normParsed === base || normParsed === normFile) return true;

  // 2. Disambiguated with root folder prefix (e.g. "myrepo/index.js" or "myrepo/src/index.js")
  if (root && typeof root === "string") {
    const rootBase = root.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    if (rootBase && normParsed === `${rootBase}/${normFile}`) return true;
  }

  // 3. Tab name has directory path matching normFile (e.g. dir is "src", normParsed is "src/index.js")
  if (dir) {
    if (normParsed.endsWith("/" + normFile) || normFile.endsWith("/" + normParsed)) return true;
  }

  return false;
}

/**
 * Resolves a candidate filename or relative path against the current workspace tree, open tabs, and git marks.
 * Returns the matched relative path if verified, or null if the candidate does not represent a file.
 *
 * @param {string | null} candidate
 * @param {string | null} currentRoot
 * @param {Map<string, Array<{ name: string, dir: boolean }>>} [entries]
 * @param {Record<string, string>} [marks]
 * @param {Record<string, any>} [openTabs]
 * @param {{ root?: string | null, file?: string | null }} [activeFile]
 * @returns {string | null}
 */
export function matchCandidateFile(candidate, currentRoot, entries, marks, openTabs, activeFile) {
  if (!candidate || typeof candidate !== "string") return null;
  const clean = candidate.trim().replace(/\\/g, "/");
  if (!clean) return null;

  // 1. Explicit path with slashes (e.g. "mods/file-editor/main.js")
  if (clean.includes("/")) {
    return normalizeFileToRoot(clean, currentRoot, currentRoot);
  }

  // 2. Direct match in root directory entries
  const rootList = entries?.get?.("") || [];
  if (rootList.some((e) => !e.dir && e.name === clean)) {
    return clean;
  }

  // 3. Match from activeFile if its base matches candidate
  if (activeFile && typeof activeFile === "object" && activeFile.file) {
    const { base } = splitPathInfo(activeFile.file);
    if (base === clean || activeFile.file === clean) {
      const norm = normalizeFileToRoot(activeFile.file, activeFile.root, currentRoot);
      if (norm) return norm;
    }
  }

  // 4. Match from openTabs map if an entry's base matches candidate
  if (openTabs && typeof openTabs === "object") {
    for (const entry of Object.values(openTabs)) {
      if (!entry || typeof entry !== "object" || !entry.file) continue;
      const { base } = splitPathInfo(entry.file);
      if (base === clean || entry.tabName === clean || entry.file === clean) {
        if (!isTabMatchingFile(clean, entry.file, entry.root || currentRoot)) continue;
        const norm = normalizeFileToRoot(entry.file, entry.root, currentRoot);
        if (norm) return norm;
      }
    }
  }

  // 5. Match in git status marks (modified/staged/untracked files in repo)
  if (marks && typeof marks === "object") {
    for (const markPath of Object.keys(marks)) {
      if (markPath.endsWith(`/${clean}`) || markPath === clean) {
        const norm = normalizeFileToRoot(markPath, null, currentRoot);
        if (norm) return norm;
      }
    }
  }

  // 6. Match in any loaded subfolder in entries
  if (entries && typeof entries.entries === "function") {
    for (const [folder, list] of entries.entries()) {
      if (Array.isArray(list) && list.some((e) => !e.dir && e.name === clean)) {
        return folder ? `${folder}/${clean}` : clean;
      }
    }
  }

  return null;
}

/**
 * Resolves the active opened file relative to the current workspace root.
 * Checks focused tab/pane, active tab in active space (including diff and file tabs),
 * openTabs map, and shared activeFile.
 *
 * @param {{
 *   spaces?: Array<Record<string, any>>,
 *   focused?: Record<string, any>,
 *   panes?: Array<Record<string, any>>,
 *   openTabs?: Record<string, any>,
 *   activeFile?: { root?: string | null, file?: string | null },
 *   currentRoot?: string | null,
 *   entries?: Map<string, Array<{ name: string, dir: boolean }>>,
 *   marks?: Record<string, string>,
 * }} options
 * @returns {string | null}
 */
export function resolveActiveOpenedFile({
  spaces,
  focused,
  panes,
  openTabs,
  activeFile,
  currentRoot,
  entries,
  marks,
}) {
  const spaceList = Array.isArray(spaces) ? spaces : [];
  const paneList = Array.isArray(panes) ? panes : [];
  const activeSpace = spaceList.find((s) => s.active) || null;
  const activeTabs = activeSpace?.tabs || [];
  const focusedTabId = focused?.tab || null;
  const activeTab = activeTabs.find((t) => t.id === focusedTabId) || activeTabs.find((t) => t.active) || null;

  // 1. Check focused pane props if any
  if (focused?.pane) {
    const fp = paneList.find((p) => p.pane === focused.pane);
    if (fp?.props) {
      const file = fp.props.file || fp.props.diffFile;
      if (file) {
        const norm = normalizeFileToRoot(file, fp.props.folder || fp.props.cwd, currentRoot);
        if (norm) return norm;
      }
    }
  }

  // 2. Check active tab
  if (activeTab) {
    // 2a. Panes in active tab
    const activeTabPanes = paneList.filter((p) => p.tab === activeTab.id);
    for (const p of activeTabPanes) {
      if (p.props) {
        const file = p.props.file || p.props.diffFile;
        if (file) {
          const norm = normalizeFileToRoot(file, p.props.folder || p.props.cwd, currentRoot);
          if (norm) return norm;
        }
      }
    }

    // 2b. Match active tab against openTabs map
    if (openTabs && typeof openTabs === "object") {
      for (const entry of Object.values(openTabs)) {
        if (!entry || typeof entry !== "object" || !entry.file) continue;
        // Ignore poisoned openTabs entries where recorded tabName does not match the file
        if (entry.tabName && !isTabMatchingFile(entry.tabName, entry.file, entry.root || currentRoot)) {
          continue;
        }
        const matchesId = entry.tabId && entry.tabId === activeTab.id;
        const matchesName = entry.tabName && entry.tabName === activeTab.name;
        if (matchesId || matchesName) {
          const norm = normalizeFileToRoot(entry.file, entry.root, currentRoot);
          if (norm) return norm;
        }
      }
    }

    // 2c. Check active tab name (handles Diff tabs, direct file tabs, etc.)
    if (activeTab.name) {
      const candidate = parseTabFileName(activeTab.name);
      if (candidate) {
        const matched = matchCandidateFile(candidate, currentRoot, entries, marks, openTabs, activeFile);
        if (matched) return matched;
      }
    }
  }

  // 3. Check shared activeFile (fallback when active tab is not a file/diff)
  if (activeFile && typeof activeFile === "object" && activeFile.file) {
    const norm = normalizeFileToRoot(activeFile.file, activeFile.root, currentRoot);
    if (norm) return norm;
  }

  return null;
}

/**
 * Resolves the final renamed entry name, preserving the original file extension
 * if the user provided a name without an extension.
 *
 * @param {string} newName - Proposed new name from user input.
 * @param {string} oldName - Current entry name.
 * @param {boolean} [isDir=false] - Whether the entry is a directory.
 * @returns {string}
 */
export function resolveRenamedName(newName, oldName, isDir = false) {
  const clean = String(newName || "").trim();
  if (!clean || isDir || !oldName) return clean;

  const safeOld = String(oldName).trim();
  const oldInfo = splitPathInfo(safeOld);
  // Dotfiles without secondary extension (e.g. .gitignore, .env): treat as complete name
  const isDotfile = safeOld.startsWith(".") && !safeOld.slice(1).includes(".");
  if (!oldInfo.ext || isDotfile) {
    return clean;
  }

  // If user explicitly typed a trailing dot (e.g. "name."), user explicitly wanted no extension
  if (clean.endsWith(".")) {
    return clean.slice(0, -1);
  }

  // Check if clean already has an extension
  const newInfo = splitPathInfo(clean);
  if (newInfo.ext) {
    return clean;
  }

  // Preserve the original extension
  return `${clean}.${oldInfo.ext}`;
}

/**
 * Validates a proposed filename or folder name.
 *
 * @param {string} newName - Proposed new name.
 * @param {string} [currentName] - Current name to check for unchanged input.
 * @param {boolean} [isDir=false] - Whether the entry is a directory.
 * @returns {{ valid: boolean, error: string | null }}
 */
export function validateEntryName(newName, currentName, isDir = false) {
  if (typeof newName !== "string") {
    return { valid: false, error: "Name cannot be empty" };
  }
  const trimmed = newName.trim();
  if (!trimmed) {
    return { valid: false, error: "Name cannot be empty" };
  }
  if (trimmed === "." || trimmed === "..") {
    return { valid: false, error: "Invalid name" };
  }
  if (/[/\\:*?"<>|\0]/.test(trimmed)) {
    return { valid: false, error: "Name contains invalid characters" };
  }
  const resolved = resolveRenamedName(trimmed, currentName, isDir);
  if (!resolved) {
    return { valid: false, error: "Name cannot be empty" };
  }
  if (currentName && resolved === currentName.trim()) {
    return { valid: false, error: "Name is unchanged" };
  }
  return { valid: true, error: null };
}

/**
 * Computes the new relative path when renaming an existing relative path.
 *
 * @param {string} oldPath - Existing relative path.
 * @param {string} newName - New base name.
 * @param {boolean} [isDir=false] - Whether the entry is a directory.
 * @returns {string}
 */
export function getRenamedPath(oldPath, newName, isDir = false) {
  const { dir, base } = splitPathInfo(oldPath);
  const resolvedName = resolveRenamedName(newName, base, isDir);
  return dir ? `${dir}/${resolvedName}` : resolvedName;
}

/**
 * Updates an expanded folders Set when a directory is renamed.
 *
 * @param {Set<string>} folders - Current expanded folder paths.
 * @param {string} oldPath - Old directory path.
 * @param {string} newPath - New directory path.
 * @returns {Set<string>}
 */
export function remapRenamedFolderSet(folders, oldPath, newPath) {
  const next = new Set();
  const prefix = oldPath + "/";
  for (const folder of folders) {
    if (folder === oldPath) {
      next.add(newPath);
    } else if (folder.startsWith(prefix)) {
      next.add(newPath + "/" + folder.slice(prefix.length));
    } else {
      next.add(folder);
    }
  }
  return next;
}

/**
 * Updates a directory entries Map when a directory is renamed.
 *
 * @param {Map<string, Array<{ name: string, dir: boolean }>>} entries
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {Map<string, Array<{ name: string, dir: boolean }>>}
 */
export function remapRenamedFolderEntries(entries, oldPath, newPath) {
  const next = new Map();
  const prefix = oldPath + "/";
  for (const [key, val] of entries.entries()) {
    if (key === oldPath) {
      next.set(newPath, val);
    } else if (key.startsWith(prefix)) {
      next.set(newPath + "/" + key.slice(prefix.length), val);
    } else {
      next.set(key, val);
    }
  }
  return next;
}

/**
 * Removes a directory and all its descendants from an expanded folders Set.
 *
 * @param {Set<string>} folders
 * @param {string} deletedPath
 * @returns {Set<string>}
 */
export function removeDeletedFolderSet(folders, deletedPath) {
  const next = new Set();
  const prefix = deletedPath + "/";
  for (const folder of folders) {
    if (folder !== deletedPath && !folder.startsWith(prefix)) {
      next.add(folder);
    }
  }
  return next;
}

/**
 * Removes a directory and all its descendants from a directory entries Map.
 *
 * @param {Map<string, Array<{ name: string, dir: boolean }>>} entries
 * @param {string} deletedPath
 * @returns {Map<string, Array<{ name: string, dir: boolean }>>}
 */
export function removeDeletedFolderEntries(entries, deletedPath) {
  const next = new Map();
  const prefix = deletedPath + "/";
  for (const [key, val] of entries.entries()) {
    if (key !== deletedPath && !key.startsWith(prefix)) {
      next.set(key, val);
    }
  }
  return next;
}

/**
 * Normalizes root and file into a canonical file key.
 *
 * @param {string | null | undefined} root
 * @param {string | null | undefined} file
 * @returns {string}
 */
export function toFileKey(root, file) {
  let normRoot = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  let normFile = typeof file === "string" ? file.replace(/\\/g, "/") : "";

  if (normRoot && normFile.startsWith(normRoot + "/")) {
    return normFile;
  }
  normFile = normFile.replace(/^\/+/, "");
  if (normRoot && normFile) {
    if (normRoot.replace(/^\/+/, "") && normFile.startsWith(normRoot.replace(/^\/+/, "") + "/")) {
      return normRoot.startsWith("/") ? `/${normFile}` : normFile;
    }
    return `${normRoot}/${normFile}`;
  }
  return normFile || normRoot;
}

/**
 * Constructs a safe, deterministic GPUI element identifier for a given file.
 * Replaces non-alphanumeric characters with hyphens to guarantee valid element naming.
 *
 * @param {string} prefix - Component namespace (e.g. "editor-code", "editor-markdown")
 * @param {string} fileKey - Canonical file key or path
 * @returns {string}
 */
export function fileElementId(prefix, fileKey) {
  const cleanKey = String(fileKey || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${prefix}-${cleanKey || "default"}`;
}

/**
 * Prunes the file tab state cache down to maxEntries using LRU (least recently accessed first).
 * Never prunes the currently active file tab.
 * Returns an array of evicted entries so callers can release resources (e.g. EditorState handles).
 *
 * @param {Map<string, any>} statesMap
 * @param {number} [maxEntries=15]
 * @param {string | null} [activeKey=null]
 * @returns {Array<{ key: string, entry: any }>}
 */
export function pruneFileTabStates(statesMap, maxEntries = 15, activeKey = null) {
  if (!statesMap || statesMap.size <= maxEntries) return [];

  const candidates = [];
  for (const [key, entry] of statesMap.entries()) {
    if (key !== activeKey) {
      candidates.push({ key, entry, lastAccess: entry?.lastAccess ?? 0 });
    }
  }

  candidates.sort((a, b) => a.lastAccess - b.lastAccess);

  const evicted = [];
  while (statesMap.size > maxEntries && candidates.length > 0) {
    const item = candidates.shift();
    if (item && statesMap.has(item.key)) {
      statesMap.delete(item.key);
      evicted.push({ key: item.key, entry: item.entry });
    }
  }

  return evicted;
}

/**
 * Remaps file state cache keys when a file or directory is renamed.
 *
 * @param {Map<string, any>} statesMap
 * @param {string} oldPath
 * @param {string} newPath
 * @param {string} [root=""]
 * @returns {Map<string, any>}
 */
export function remapRenamedFileStates(statesMap, oldPath, newPath, root = "") {
  if (!statesMap) return statesMap;
  const oldKey = toFileKey(root, oldPath);
  const newKey = toFileKey(root, newPath);
  const oldPrefix = oldKey + "/";

  for (const [key, entry] of [...statesMap.entries()]) {
    if (key === oldKey) {
      statesMap.delete(key);
      statesMap.set(newKey, entry);
    } else if (key.startsWith(oldPrefix)) {
      statesMap.delete(key);
      statesMap.set(newKey + key.slice(oldKey.length), entry);
    }
  }
  return statesMap;
}

/**
 * Removes file states for a deleted file or folder from the cache.
 * Returns array of removed entries so callers can release resources.
 *
 * @param {Map<string, any>} statesMap
 * @param {string} deletedPath
 * @param {string} [root=""]
 * @returns {Array<{ key: string, entry: any }>}
 */
export function removeDeletedFileStates(statesMap, deletedPath, root = "") {
  if (!statesMap) return [];
  const targetKey = toFileKey(root, deletedPath);
  const prefix = targetKey + "/";
  const removed = [];

  for (const [key, entry] of [...statesMap.entries()]) {
    if (key === targetKey || key.startsWith(prefix)) {
      statesMap.delete(key);
      removed.push({ key, entry });
    }
  }
  return removed;
}
