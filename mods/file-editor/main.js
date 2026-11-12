/**
 * Herdr File Explorer & Editor Mod (Dual-Mode: Files Pane Tree & Dedicated File Viewer Tab).
 *
 * Mode 1 (Files Pane): When props().file is not set, renders the directory browser tree.
 * Clicking a file opens it in its own Herdr tab via run("tab.new", { mod: "file-editor", ... }).
 *
 * Mode 2 (File Editor Tab): When props().file is set, renders a full-pane editor tab with:
 * - Syntax highlighting (Editor / EditorState) for code and configuration files.
 * - GitHub-style Markdown preview (markdown-view.js) for .md / .markdown / .mdx.
 * - Rendered SVG preview for .svg, with a Code view toggle.
 * - Zoomable, pannable raster image and SVG previews (25%–400%).
 * - Soft-wrap toggle, copy button, file reload, and live disk watching.
 */

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { readFile as readBinaryFile } from "fs/promises";
import {
  spaces,
  panes,
  focused,
  appHome,
  exec,
  readTextFile,
  watchFolder,
  writeTextFile,
  theme,
  settings,
  window,
  run,
  shared,
  setShared,
  notify,
  props,
} from "herdr";
import {
  splitPathInfo,
  normalizeTabTarget,
  resolveAbsolutePath,
  detectLanguage,
  isMarkdownFile,
  isSvgFile,
  prepareSvgPreviewInfo,
  defaultViewMode,
  prepareFileText,
  countLines,
  isContentDirty,
  encodeBase64Chunks,
  isFileReadonly,
  readonlyReason,
  shouldReloadWatchedFile,
  buildSyntaxTheme,
  resolveLocationState,
  resolveFileTab,
  isTabMatchingFile,
  mergeOpenTabEntry,
  isPreviewOpenTab,
  setOpenTabPreview,
  promotePreviewEntry,
  shouldCoalescePendingOpen,
  collectPreviewTabs,
  planPreviewOpen,
  fileIconPath,
  isLightColor,
  isImageFile,
  imageHeaderSize,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  normalizeImageZoom,
  stepImageZoom,
  imageZoomPercent,
  getAncestorFolders,
  parseTabFileName,
  resolveActiveOpenedFile,
  FOLDER_ICON_PATH,
  validateEntryName,
  resolveRenamedName,
  getRenamedPath,
  remapRenamedFolderSet,
  remapRenamedFolderEntries,
  removeDeletedFolderSet,
  removeDeletedFolderEntries,
  toFileKey,
  fileElementId,
  pruneFileTabStates,
  remapRenamedFileStates,
  removeDeletedFileStates,
  isEmptyPane,
  findTargetEmptyPane,
  planFilePlacement,
  estimateMarkdownHeight,
  buildSplitPaneRequest,
  resolveFilesMenuPosition,
} from "./file-logic.js";
import {
  FIND_MATCH_CAP,
  REPLACE_MAX_BYTES,
  SEARCH_FILE_CAP,
  SEARCH_MATCH_CAP,
  SEARCH_ROW_HEIGHT,
  applyReplacements,
  buildFindRegExp,
  buildGrepArgs,
  buildRipgrepArgs,
  classifyReplacementRead,
  classifySearchResult,
  collectReplaceTargets,
  expandGrepRows,
  expandSearchReplacement,
  filterSearchRowsByGlobs,
  findHorizontalOffset,
  findMatchIndexAtLine,
  findMatches,
  findPropSignature,
  flattenSearchRows,
  formatReplaceAllConfirmation,
  formatSearchError,
  groupSearchRows,
  isDirtyFileState,
  normalizeFindPrefs,
  normalizeFindProp,
  normalizeReplacePrefs,
  normalizeSections,
  parseGlobList,
  parseGrepOutput,
  parseRgJson,
  planFileReplacements,
  replacementDiffSegments,
  replaceSingleMatch,
  shouldConsumePendingFind,
  shouldPromoteSearchClick,
  stepMatchIndex,
  PENDING_FIND_TTL_MS,
} from "./find-logic.js";
import {
  renderFindBar,
  renderFindCodeView,
  renderSearchSection,
  renderSidebarSectionHeader,
} from "./find-view.js";
import { renderMarkdownDocument } from "./markdown-view.js";

/** In-memory cache for open and recent file tab states (scroll, cursor, text, view mode, EditorState). */
const fileTabStates = new Map();

/**
 * File keys with unsaved editor edits. Kept outside the bounded LRU cache so
 * a dirty tab cannot be evicted and then overwritten by a Files-pane replace.
 */
const dirtyFileKeys = new Set();

/** Max number of file editor instances to retain in the LRU cache. */
const MAX_CACHED_FILE_STATES = 15;

/**
 * Installs the mod's app-wide key bindings exactly once per process. They are
 * app state, not view state: binding them from every tab/pane init would grow
 * the keymap with duplicate chords for the life of the process.
 *
 * @param {import("gpui-kit").ViewContext} cx
 */
function ensureFileEditorKeyBindings(cx) {
  if (globalThis.__fileEditorFindKeyBindingsInstalled === true) return;
  try {
    cx.bind_keys([
      { keystroke: "cmd-f", action: "file-editor.find", context: "FileEditor" },
      { keystroke: "ctrl-f", action: "file-editor.find", context: "FileEditor" },
      { keystroke: "cmd-g", action: "file-editor.find-next", context: "FileEditor" },
      { keystroke: "ctrl-g", action: "file-editor.find-next", context: "FileEditor" },
      { keystroke: "cmd-shift-g", action: "file-editor.find-prev", context: "FileEditor" },
      { keystroke: "ctrl-shift-g", action: "file-editor.find-prev", context: "FileEditor" },
      { keystroke: "f3", action: "file-editor.find-next", context: "FileEditor" },
      { keystroke: "shift-f3", action: "file-editor.find-prev", context: "FileEditor" },
      { keystroke: "cmd-alt-f", action: "file-editor.replace", context: "FileEditor" },
      { keystroke: "ctrl-h", action: "file-editor.replace", context: "FileEditor" },
      { keystroke: "escape", action: "file-editor.find-close", context: "FileEditorFind" },
      { keystroke: "cmd-shift-f", action: "file-editor.search", context: "FilesPane" },
      { keystroke: "ctrl-shift-f", action: "file-editor.search", context: "FilesPane" },
    ]);
    globalThis.__fileEditorFindKeyBindingsInstalled = true;
  } catch {}
}

/**
 * Storage key prefix for persisted file tab state.
 *
 * @param {string} key
 * @returns {string}
 */
function getStorageKey(key) {
  return `file-editor.tabState.${key}`;
}

/**
 * Loads persisted tab state from sessionStorage if available.
 *
 * @param {string} fileKey
 * @returns {Record<string, any> | null}
 */
function loadPersistedTabState(fileKey) {
  try {
    const raw = sessionStorage.getItem(getStorageKey(fileKey));
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

/**
 * Saves tab state attributes to sessionStorage.
 *
 * @param {string} fileKey
 * @param {Record<string, any>} state
 */
function savePersistedTabState(fileKey, state) {
  try {
    sessionStorage.setItem(getStorageKey(fileKey), JSON.stringify(state));
  } catch {}
}

/** Max entries displayed per directory and total tree bounds. */
const PER_FOLDER = 500;
const TOTAL = 5000;

/** Height of the file tab's header toolbar, in pixels. */
const HEADER_HEIGHT = 38;

/** Padding around a picture preview inside its scroll area, in pixels. */
const PICTURE_PADDING = 24;

/**
 * Lists the contents of a directory using PowerShell on Windows and POSIX sh on Unix/macOS.
 *
 * @param {string} path - Absolute directory path.
 * @param {string | null} on - Remote machine target if applicable.
 * @returns {Promise<Array<{ name: string, dir: boolean }>>}
 */
async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses console code page; exec decodes UTF-8.
    const r = await exec(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" +
          path.replace(/['‘’‚‛]/g, "$&$&") +
          "'",
      ],
      { on }
    );
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };

  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "files", path], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  }
  return out;
}

/**
 * Writes UTF-8 text to a file on a remote machine over SSH via herdr-core exec.
 * Uses base64 chunking to respect MAX_ARG_STRLEN on remote kernels, and writes
 * through a temporary file for atomic updates.
 *
 * @param {string} fullPath - Absolute destination path on the remote machine.
 * @param {string} text - Text to write.
 * @param {string} on - Remote machine identifier.
 * @param {string | null} expected - Expected existing file content snapshot.
 * @returns {Promise<void>}
 */
async function writeRemoteTextFile(fullPath, text, on, expected) {
  if (expected !== null && expected !== undefined) {
    const current = await readTextFile(fullPath, { on });
    if (current !== null && current !== expected) {
      throw new Error("File was modified externally on disk (stale snapshot)");
    }
  }

  const chunks = encodeBase64Chunks(text);
  const unixScript =
    'target="$1"; dir=$(dirname "$target"); mkdir -p "$dir" && tmp="$target.tmp.$$" && shift && (for c in "$@"; do printf "%s" "$c"; done | (base64 -d 2>/dev/null || base64 -D) > "$tmp") && mv -f "$tmp" "$target"';

  try {
    const r = await exec("sh", ["-c", unixScript, "write", fullPath, ...chunks], { on });
    if (r.code !== 0) {
      throw new Error(r.stderr || `Failed to write file on remote machine (${r.code})`);
    }
  } catch (err) {
    if (String(err).includes("cannot start sh: program not found")) {
      const psScript =
        '$target = $args[0]; $dir = [System.IO.Path]::GetDirectoryName($target); if ($dir -and -not [System.IO.Directory]::Exists($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }; $chunks = $args[1..($args.Length - 1)]; $b64 = [string]::Join("", $chunks); $bytes = [System.Convert]::FromBase64String($b64); [System.IO.File]::WriteAllBytes($target, $bytes)';
      const psRes = await exec(
        "powershell",
        ["-NoProfile", "-Command", psScript, fullPath, ...chunks],
        { on }
      );
      if (psRes.code !== 0) {
        throw new Error(psRes.stderr || `Failed to write file on remote machine (${psRes.code})`);
      }
      return;
    }
    throw err;
  }
}

/**
 * Reads a file's size in bytes on the local machine or a remote one.
 *
 * `readTextFile` caps reads at 1 MiB, so a Files-pane replace must know the
 * real size before trusting the text it read. Returns null when the size
 * cannot be determined; callers skip the file rather than risk a truncated
 * write.
 *
 * @param {string} fullPath
 * @param {string | null} on
 * @returns {Promise<number | null>}
 */
async function fileByteSize(fullPath, on) {
  const parse = (value) => {
    const size = Number(String(value ?? "").trim());
    return Number.isFinite(size) && size >= 0 ? size : null;
  };
  const powershell = async () => {
    const result = await exec(
      "powershell",
      ["-NoProfile", "-Command", "(Get-Item -LiteralPath $args[0]).Length", fullPath],
      { on }
    ).catch(() => null);
    return result && result.code === 0 ? parse(result.stdout) : null;
  };

  if (!on && window()?.platform === "windows") return powershell();
  const result = await exec("sh", ["-c", 'wc -c < "$1"', "size", fullPath], { on }).catch(() => null);
  if (result && result.code === 0) return parse(result.stdout);
  // A remote Windows machine or a shell without wc.
  return powershell();
}

/**
 * Renames a file or directory on local or remote machine.
 *
 * @param {string | null} root - Workspace root.
 * @param {string} oldRelPath - Current relative path.
 * @param {string} newRelPath - New relative path.
 * @param {string | null} on - Remote machine target if applicable.
 * @returns {Promise<void>}
 */
async function renamePath(root, oldRelPath, newRelPath, on) {
  const oldFull = root ? `${root}/${oldRelPath}` : oldRelPath;
  const newFull = root ? `${root}/${newRelPath}` : newRelPath;
  const isWindows = !on && window()?.platform === "windows";

  if (isWindows) {
    const r = await exec(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Move-Item -LiteralPath $args[0] -Destination $args[1] -ErrorAction Stop",
        oldFull,
        newFull,
      ],
      { on }
    );
    if (r.code !== 0) throw new Error(r.stderr?.trim() || `Rename failed with code ${r.code}`);
    return;
  }

  const script = 'mv "$1" "$2"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "rename", oldFull, newFull], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) {
      const psRes = await exec(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Move-Item -LiteralPath $args[0] -Destination $args[1] -ErrorAction Stop",
          oldFull,
          newFull,
        ],
        { on }
      );
      if (psRes.code !== 0) throw new Error(psRes.stderr?.trim() || `Rename failed`);
      return;
    }
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr?.trim() || `Rename failed with code ${r.code}`);
}

/**
 * Deletes a file or directory on local or remote machine.
 *
 * @param {string | null} root - Workspace root.
 * @param {string} relPath - Relative path to delete.
 * @param {boolean} isDir - Whether target is a directory.
 * @param {string | null} on - Remote machine target if applicable.
 * @returns {Promise<void>}
 */
async function deletePath(root, relPath, isDir, on) {
  if (!relPath || relPath === "." || relPath === "/") {
    throw new Error("Cannot delete root directory");
  }
  const full = root ? `${root}/${relPath}` : relPath;
  const isWindows = !on && window()?.platform === "windows";

  if (isWindows) {
    const cmd = isDir
      ? "Remove-Item -LiteralPath $args[0] -Recurse -Force -ErrorAction Stop"
      : "Remove-Item -LiteralPath $args[0] -Force -ErrorAction Stop";
    const r = await exec("powershell", ["-NoProfile", "-Command", cmd, full], { on });
    if (r.code !== 0) throw new Error(r.stderr?.trim() || `Delete failed with code ${r.code}`);
    return;
  }

  const script = isDir ? 'rm -rf "$1"' : 'rm -f "$1"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "delete", full], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) {
      const cmd = isDir
        ? "Remove-Item -LiteralPath $args[0] -Recurse -Force -ErrorAction Stop"
        : "Remove-Item -LiteralPath $args[0] -Force -ErrorAction Stop";
      const psRes = await exec("powershell", ["-NoProfile", "-Command", cmd, full], { on });
      if (psRes.code !== 0) throw new Error(psRes.stderr?.trim() || `Delete failed`);
      return;
    }
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr?.trim() || `Delete failed with code ${r.code}`);
}

export default class FileEditor extends View {
  /**
   * Initializes the view based on whether props().file is provided.
   *
   * @param {Record<string, any>} _props
   * @param {import("gpui-kit").ViewContext} cx
   */
  init(_props, cx) {
    this.closed = false;
    const p = props() || {};
    this.tabMode = typeof p.file === "string" && p.file.length > 0;
    ensureFileEditorKeyBindings(cx);

    if (this.tabMode) {
      this.initTabMode(p, cx);
    } else {
      this.initPaneMode(p, cx);
    }
  }

  /**
   * Lifecycle cleanup: marks view closed, caches active tab state, and invalidates active watchers.
   *
   * @param {import("gpui-kit").AsyncContext} _cx
   */
  async close(_cx) {
    this.closed = true;
    this.watched = null;
    this.watchToken = null;
    this.hoveredPath = null;
    this.focusHandle = null;
    this.saving = false;
    this.searchToken = null;
    try {
      this.findInput?.release();
    } catch {}
    this.findInput = null;
    try {
      this.replaceInput?.release();
    } catch {}
    this.replaceInput = null;
    try {
      this.findScrollHandle?.release();
    } catch {}
    this.findScrollHandle = null;
    this.findUndo = [];
    for (const input of [this.searchInput, this.searchReplaceInput, this.includeInput, this.excludeInput]) {
      try {
        input?.release();
      } catch {}
    }
    this.searchInput = null;
    this.searchReplaceInput = null;
    this.includeInput = null;
    this.excludeInput = null;

    // Cache the tab state before closing so returning to it preserves cursor, scroll and settings
    if (this.fileKey) {
      this.updateCachedTabState({
        code: this.code,
        editorInputs: this.editorInputs,
        mdScrollY: this.mdScrollY,
        pictureScrollX: this.pictureScrollX,
        pictureScrollY: this.pictureScrollY,
        imageSrc: this.imageSrc,
        pictureViewport: this.pictureViewport,
        tabViewport: this.tabViewport,
        lastAccess: Date.now(),
      });
    }

    // Do NOT release this.code immediately here; pruneFileTabStates manages the bounded LRU entity cache
    this.code = null;
    this.editorInputs = null;
    this.dirty = false;
    this.lastSavedText = null;

    this.closeModals();
    this.contextMenu = null;
    const active = shared("file-editor.activeFile");
    if (active && active.file === this.file && active.root === this.root) {
      setShared("file-editor.activeFile", null);
    }
    const openTabsMap = shared("file-editor.openTabs");
    if (openTabsMap && this.file) {
      const fileKey = this.fileKey || (this.root ? `${this.root}/${this.file}` : this.file);
      const tabStillExists = (spaces() || []).some((sp) =>
        (sp.tabs || []).some((t) =>
          this.tabId ? t.id === this.tabId : isTabMatchingFile(t.name, this.file, this.root)
        )
      );
      if (!tabStillExists && openTabsMap[fileKey]) {
        const next = { ...openTabsMap };
        delete next[fileKey];
        setShared("file-editor.openTabs", next);
      }
    }
  }

  /* ========================================================================
   * Tab Mode Implementation
   * ======================================================================== */

  /**
   * Sets up state and listeners for dedicated file viewer tab mode.
   *
   * @param {Record<string, any>} p
   * @param {import("gpui-kit").ViewContext} cx
   */
  initTabMode(p, cx) {
    const { root, file } = normalizeTabTarget(p);
    this.file = file;
    this.root = root;
    this.on = typeof p.on === "string" ? p.on : null;
    this.fileKey = toFileKey(this.root, this.file);

    // Look up cached state (in-memory LRU or sessionStorage) to restore where the user was
    const cached = fileTabStates.get(this.fileKey) || loadPersistedTabState(this.fileKey);

    const requestedMode = typeof p.viewMode === "string" ? p.viewMode : (cached?.viewMode ?? null);
    this.viewMode = defaultViewMode(this.file, requestedMode);

    this.explicitWrap = typeof p.wrap === "boolean";
    const savedWrap = shared("file-editor.wrap");
    this.wrap = this.explicitWrap ? p.wrap : typeof cached?.wrap === "boolean" ? cached.wrap : savedWrap === true;

    this.rawText = cached?.rawText ?? null;
    this.preparedText = cached?.preparedText ?? null;
    this.fileError = null;
    this.lineCount = cached?.lineCount ?? 0;
    this.isBinary = cached?.isBinary ?? false;
    this.isImage = isImageFile(this.file);
    this.isSvg = isSvgFile(this.file);
    this.imageSrc = cached?.imageSrc ?? null;
    this.imageLoading = false;
    this.imageSize = cached?.imageSize ?? null;
    const initialZoom = typeof p.zoom === "number" ? p.zoom : (cached?.imageZoom ?? 1);
    this.imageZoom = normalizeImageZoom(initialZoom);
    this.pictureViewport = cached?.pictureViewport ?? null;
    this.tabViewport = cached?.tabViewport ?? null;
    this.isTruncated = cached?.isTruncated ?? false;
    this.loading = false;
    this.reloadPending = false;
    this.code = cached?.code ?? null;
    this.editorInputs = cached?.editorInputs ?? null;
    const initialScrollY = typeof p.scrollY === "number" ? p.scrollY : (cached?.mdScrollY ?? 0);
    this.mdScrollY = initialScrollY;
    this.pictureScrollX = cached?.pictureScrollX ?? 0;
    this.pictureScrollY = cached?.pictureScrollY ?? 0;
    this.watched = null;
    this.watchToken = null;
    this.focusHandle = cx.focus_handle();
    this.dirty = cached?.dirty ?? false;
    this.saving = false;
    this.lastSavedText = null;

    // In-editor Find: the native EditorState exposes no selection or cursor
    // API, so this state owns the query, matches and current index. While the
    // widget is open the tab renders a read-only, highlighted virtual list
    // instead of the native Editor (see find-view.js).
    const persistedFind = normalizeFindPrefs(shared("file-editor.find"));
    const persistedReplace = normalizeReplacePrefs(shared("file-editor.find"));
    const propFind = normalizeFindProp(p.find);
    const propSignature = findPropSignature(p.find);
    const consumedFindSignature = cached?.findPropSignature ?? null;
    // Apply a find prop once per file tab. Tab switches remount the view with
    // the same props; without this record find would reopen and jump back to
    // the original line every time.
    const shouldOpenPropFind =
      Boolean(propFind?.query) && Boolean(propSignature) && propSignature !== consumedFindSignature;
    const activePropFind = shouldOpenPropFind ? propFind : null;
    this.findPropSignature = shouldOpenPropFind ? propSignature : consumedFindSignature;
    this.find = {
      open: shouldOpenPropFind,
      query: activePropFind?.query ?? persistedFind.query,
      caseSensitive: activePropFind?.caseSensitive ?? persistedFind.caseSensitive,
      wholeWord: activePropFind?.wholeWord ?? persistedFind.wholeWord,
      regex: activePropFind?.regex ?? persistedFind.regex,
      replace: activePropFind?.replace ?? persistedReplace.replace,
      replaceOpen: activePropFind?.replaceOpen ?? persistedReplace.replaceOpen,
      preserveCase: activePropFind?.preserveCase ?? persistedReplace.preserveCase,
      valid: true,
      error: null,
      matches: [],
      current: -1,
      limited: false,
      scrollColumn: 0,
    };
    this.pendingFindLine = activePropFind?.line ?? null;
    this.findScrollHandle = VirtualListScrollHandle.new();
    this.findInput = InputState.new({ placeholder: "Find", value: this.find.query });
    this.findInput.on("change", (_event, eventCx) => this.handleFindInputChange(eventCx));
    this.findInput.on("submit", (event, eventCx) => this.stepFind(event?.shift ? -1 : 1, eventCx));
    this.findInput.on("focus", () => {
      this.findFocusTarget = "find";
    });
    this.replaceInput = InputState.new({ placeholder: "Replace", value: this.find.replace });
    this.replaceInput.on("change", (_event, eventCx) => this.handleReplaceInputChange(eventCx));
    this.replaceInput.on("submit", (event, eventCx) => {
      if (event?.secondary) this.replaceAllInEditor(eventCx);
      else this.replaceCurrentMatch(eventCx);
    });
    this.replaceInput.on("focus", () => {
      this.findFocusTarget = "replace";
    });
    this.findFocusTarget = "find";
    this.findUndo = [];
    this.lastReplaceActionAt = 0;
    this.lastPendingFindTimestamp = null;
    if (this.find.open) {
      // A find prop wins over the preview default: the read-only match view is
      // the only surface that can bring a line into view.
      this.viewMode = "code";
      cx.timer.after(120, () => {
        if (!this.closed && this.find.open) this.findInput?.focus();
      });
    }

    if (fileTabStates.has(this.fileKey)) {
      fileTabStates.get(this.fileKey).lastAccess = Date.now();
    } else if (cached) {
      fileTabStates.set(this.fileKey, { ...cached, lastAccess: Date.now() });
    }
    if (shouldOpenPropFind) {
      this.persistFindPrefs();
      this.updateCachedTabState();
    }

    // Register this open tab in shared state
    this.registerOpenTab(p);
    if (this.dirty) this.promotePreviewTab();

    this.withChooser = false;
    this.probeChooser(cx);

    this.loadFile(cx);
    this.watchTab(this.root, cx);

    // Sync theme, font, and shared wrap setting periodically
    cx.timer.every(500, (cx) => this.syncTabConfig(cx));
    // Poll for external file modifications as a safety net (e.g. agent edits, remote SSH, missed watcher events)
    cx.timer.every(1500, (cx) => this.checkDiskChanges(cx));
    // Probe optional new-pane mod periodically
    cx.timer.every(15000, (cx) => this.probeChooser(cx));
  }

  /**
   * Updates cached file state in memory and persists view preferences.
   *
   * @param {Record<string, any>} [patch={}]
   */
  updateCachedTabState(patch = {}) {
    if (!this.fileKey || this.closed) return;
    const existing = fileTabStates.get(this.fileKey) || {};
    const updated = {
      ...existing,
      rawText: this.rawText ?? existing.rawText,
      preparedText: this.preparedText ?? existing.preparedText,
      lineCount: this.lineCount,
      isBinary: this.isBinary,
      isTruncated: this.isTruncated,
      viewMode: this.viewMode,
      imageZoom: this.imageZoom,
      imageSize: this.imageSize,
      imageSrc: this.imageSrc ?? existing.imageSrc,
      pictureViewport: this.pictureViewport ?? existing.pictureViewport,
      tabViewport: this.tabViewport ?? existing.tabViewport,
      wrap: this.wrap,
      code: this.code ?? existing.code,
      editorInputs: this.editorInputs ?? existing.editorInputs,
      mdScrollY: this.mdScrollY ?? existing.mdScrollY ?? 0,
      pictureScrollX: this.pictureScrollX ?? existing.pictureScrollX ?? 0,
      pictureScrollY: this.pictureScrollY ?? existing.pictureScrollY ?? 0,
      findPropSignature: this.findPropSignature ?? existing.findPropSignature ?? null,
      dirty: this.dirty,
      lastAccess: Date.now(),
      ...patch,
    };
    fileTabStates.set(this.fileKey, updated);
    if (updated.dirty) dirtyFileKeys.add(this.fileKey);
    else dirtyFileKeys.delete(this.fileKey);
    savePersistedTabState(this.fileKey, {
      viewMode: updated.viewMode,
      imageZoom: updated.imageZoom,
      wrap: updated.wrap,
      mdScrollY: updated.mdScrollY,
      pictureScrollX: updated.pictureScrollX,
      pictureScrollY: updated.pictureScrollY,
      findPropSignature: updated.findPropSignature,
      dirty: updated.dirty === true,
    });
    const evicted = pruneFileTabStates(fileTabStates, MAX_CACHED_FILE_STATES, this.fileKey);
    for (const { entry } of evicted) {
      entry.code?.release();
      if (entry?.imageSrc) {
        const name = entry.imageSrc.slice(entry.imageSrc.lastIndexOf("/") + 1);
        const prefix = name.replace(/-\d+\.[^.]+$/, "");
        exec("sh", ["-c", 'rm -f "$1/$2"-*', "rm", `${appHome()}/cache/file-editor`, prefix]).catch(() => null);
      }
    }
  }

  /**
   * Records this open tab in shared("file-editor.openTabs").
   *
   * @param {Record<string, any>} p
   */
  registerOpenTab(p) {
    const fileKey = this.fileKey || (this.root ? `${this.root}/${this.file}` : this.file);
    const openTabsMap = shared("file-editor.openTabs") || {};
    let tabId = null;
    let tabName = null;

    if (p.pane) {
      const matchedPane = (panes() || []).find((pn) => pn.pane === p.pane);
      if (matchedPane?.tab) {
        const allTabs = (spaces() || []).flatMap((sp) => sp.tabs || []);
        const foundTab = allTabs.find((t) => t.id === matchedPane.tab);
        if (foundTab && isTabMatchingFile(foundTab.name, this.file, this.root)) {
          tabId = foundTab.id;
          tabName = foundTab.name;
        }
      }
    }

    if (!tabId) {
      const allTabs = (spaces() || []).flatMap((sp) => sp.tabs || []);
      const focusedTabId = focused()?.tab;
      const focusedTab = focusedTabId ? allTabs.find((t) => t.id === focusedTabId) : null;
      if (focusedTab && isTabMatchingFile(focusedTab.name, this.file, this.root)) {
        tabId = focusedTab.id;
        tabName = focusedTab.name;
      } else {
        const activeSpace = (spaces() || []).find((s) => s.active);
        const activeTab = activeSpace?.tabs?.find((t) => t.active);
        if (activeTab && isTabMatchingFile(activeTab.name, this.file, this.root)) {
          tabId = activeTab.id;
          tabName = activeTab.name;
        }
      }
    }

    this.tabId = tabId;

    const updatedOpenTabs = {
      ...openTabsMap,
      [fileKey]: mergeOpenTabEntry(openTabsMap[fileKey], {
        root: this.root,
        file: this.file,
        tabName,
        tabId,
      }),
    };
    setShared("file-editor.openTabs", updatedOpenTabs);
  }

  /**
   * Whether this file tab is currently a disposable preview tab.
   *
   * The flag lives in shared("file-editor.openTabs") so the tab bar and the
   * Files pane can style the same state. Reading it on demand keeps this view
   * correct when the tab bar promotes the tab.
   *
   * @returns {boolean}
   */
  isPreviewTab() {
    if (!this.fileKey) return false;
    return isPreviewOpenTab((shared("file-editor.openTabs") || {})[this.fileKey]);
  }

  /**
   * Whether another pane was split into this file's tab. A preview with a
   * split terminal or a second editor must become permanent: closing the tab
   * would take that unrelated work with it.
   *
   * @returns {boolean}
   */
  hasExtraPanes() {
    if (!this.tabId) return false;
    const tab = (spaces() || [])
      .flatMap((space) => space.tabs || [])
      .find((candidate) => candidate.id === this.tabId);
    return typeof tab?.panes === "number" && tab.panes > 1;
  }

  /**
   * Makes this tab permanent. Called as soon as the file gains edits, matching
   * VS Code: a preview tab never holds unsaved work that another preview could
   * replace.
   */
  promotePreviewTab() {
    if (!this.fileKey) return;
    const openTabsMap = shared("file-editor.openTabs") || {};
    const { next, promoted } = promotePreviewEntry(openTabsMap, this.fileKey);
    if (promoted) setShared("file-editor.openTabs", next);
  }

  /**
   * Synchronizes active EditorState with theme, font settings, and shared wrap.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  syncTabConfig(cx) {
    if (this.closed) return;

    let changed = false;

    // React to file renames performed from the file browser
    const renamed = shared("file-editor.renamedFile");
    if (
      renamed &&
      renamed.timestamp &&
      renamed.timestamp !== this.lastRenamedTimestamp &&
      renamed.root === this.root &&
      renamed.oldPath === this.file
    ) {
      this.lastRenamedTimestamp = renamed.timestamp;
      this.file = renamed.newPath;
      this.fileKey = toFileKey(this.root, this.file);
      this.loadFile(cx);
      changed = true;
    }

    // A Files pane search result can target an already-open tab. Props cannot
    // update in place, so the click leaves a pending record in shared state and
    // the mounted tab picks it up here. Records are single-use and expire, so a
    // stale one cannot re-open find in a later tab of the same file.
    const pendingFind = shared("file-editor.pendingFind");
    if (pendingFind) {
      if (shouldConsumePendingFind(pendingFind, this.fileKey, this.lastPendingFindTimestamp)) {
        this.lastPendingFindTimestamp = pendingFind.timestamp;
        setShared("file-editor.pendingFind", null);
        const find = normalizeFindProp(pendingFind.find);
        if (find) {
          this.applyFindProp(find, cx);
          changed = true;
        }
      } else if (
        Number.isFinite(Number(pendingFind.timestamp)) &&
        Date.now() - Number(pendingFind.timestamp) > PENDING_FIND_TTL_MS
      ) {
        setShared("file-editor.pendingFind", null);
      }
    }

    // Resolve tabId if not discovered at mount time
    if (!this.tabId) {
      const allTabs = (spaces() || []).flatMap((sp) => sp.tabs || []);
      const activeSpace = (spaces() || []).find((s) => s.active);
      const activeSpaceTabs = activeSpace?.tabs ?? [];
      const openTabsMap = shared("file-editor.openTabs") || {};
      // The parent pane records the id a moment after tab.new; recovering it
      // here matters when this view mounts before spaces() lists the tab and
      // the user has already switched away. Restrict the recovery to the
      // active space so a same-file entry owned by another space cannot bind
      // this view to the wrong tab.
      const recordedTabId = openTabsMap[this.fileKey]?.tabId;
      if (recordedTabId && activeSpaceTabs.some((tab) => tab.id === recordedTabId)) {
        this.tabId = recordedTabId;
      }

      if (!this.tabId) {
        const focusedTabId = focused()?.tab;
        const focusedTab = focusedTabId ? allTabs.find((t) => t.id === focusedTabId) : null;
        let matchedTab = null;
        if (focusedTab && isTabMatchingFile(focusedTab.name, this.file, this.root)) {
          matchedTab = focusedTab;
        } else {
          const activeTab = activeSpaceTabs.find((t) => t.active);
          if (activeTab && isTabMatchingFile(activeTab.name, this.file, this.root)) {
            matchedTab = activeTab;
          }
        }
        if (matchedTab) {
          this.tabId = matchedTab.id;
          if (openTabsMap[this.fileKey] && openTabsMap[this.fileKey].tabId !== this.tabId) {
            setShared("file-editor.openTabs", {
              ...openTabsMap,
              [this.fileKey]: {
                ...openTabsMap[this.fileKey],
                tabId: this.tabId,
                tabName: matchedTab.name,
              },
            });
          }
        }
      }
    }

    if (!this.explicitWrap) {
      const sharedWrap = shared("file-editor.wrap") === true;
      if (this.wrap !== sharedWrap) {
        this.wrap = sharedWrap;
        changed = true;
      }
    }

    const hasPreview = isMarkdownFile(this.file) || this.isSvg;
    const isCodeView = !hasPreview || this.viewMode === "code";
    if (isCodeView && this.preparedText !== null && !this.isBinary) {
      const appSettings = settings() || {};
      const syntax = buildSyntaxTheme(theme());

      if (!this.code || this.editorInputsChanged(syntax, appSettings)) {
        this.rebuildEditor();
        changed = true;
      }
    }

    // A preview tab with unsaved edits must survive the next preview open.
    if (this.dirty && this.isPreviewTab()) {
      this.promotePreviewTab();
      changed = true;
    }
    // Splitting another pane into the preview makes the tab a real workspace.
    if (this.isPreviewTab() && this.hasExtraPanes()) {
      this.promotePreviewTab();
      changed = true;
    }

    if (changed) {
      cx.notify();
    }
  }

  /**
   * Reads file contents from disk off the UI thread and prepares display state.
   * Queues concurrent reload requests rather than dropping them.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  loadFile(cx) {
    if (this.isImage) {
      this.loadImage(cx);
      return;
    }
    if (!this.file || this.closed) return;
    if (this.loading) {
      this.reloadPending = true;
      return;
    }
    this.loading = true;
    const root = this.root;
    const file = this.file;
    const on = this.on;
    const fullPath = root ? `${root}/${file}` : file;

    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(fullPath, { on });
        if (this.closed) return;
        const { error, text: preparedText, lineCount, isBinary, isTruncated } = prepareFileText(text);

        const hadUnsavedEdits = this.dirty;
        this.rawText = isBinary ? null : text;
        this.preparedText = preparedText;
        this.findUndo = [];
        this.fileError = error;
        this.lineCount = lineCount;
        this.isBinary = isBinary;
        this.isTruncated = isTruncated;
        if (!hadUnsavedEdits) {
          this.dirty = false;
        }
        if (this.dirty) this.promotePreviewTab();

        if (this.isSvg) this.loadImage(cx);

        if (this.preparedText !== null && !this.isBinary) {
          const hasPreview = isMarkdownFile(this.file) || this.isSvg;
          if (!hasPreview || this.viewMode === "code") {
            if (this.code && this.code.value() === this.preparedText) {
              // Current editor already has the latest text; do not rebuild to preserve cursor and focus.
            } else if (this.code && !hadUnsavedEdits) {
              // External disk change while not dirty: update buffer in place without recreating EditorState.
              this.code.set_value(this.preparedText);
            } else if (!this.code) {
              this.rebuildEditor();
            }
          }
          if (this.find?.open) this.refreshFindMatches(cx, false);
          this.updateCachedTabState();
        } else {
          this.code?.release();
          this.code = null;
          this.editorInputs = null;
          if (this.find) {
            this.find.matches = [];
            this.find.current = -1;
            this.find.valid = true;
            this.find.error = null;
          }
          this.updateCachedTabState();
        }
      } catch {
        this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
        this.rawText = null;
        this.preparedText = null;
        this.lineCount = 0;
        this.isBinary = false;
        this.isTruncated = false;
        this.dirty = false;
        this.code?.release();
        this.code = null;
        this.editorInputs = null;
        if (this.find) {
          this.find.matches = [];
          this.find.current = -1;
        }
        this.updateCachedTabState();
      } finally {
        this.loading = false;
        cx.notify();
        if (this.reloadPending && !this.closed) {
          this.reloadPending = false;
          this.loadFile(cx);
        }
      }
    });
  }

  /**
   * Returns whether the active tab is in read-only mode.
   *
   * @returns {boolean}
   */
  isReadonly() {
    return isFileReadonly({
      isBinary: this.isBinary,
      isImage: this.isImage,
      isTruncated: this.isTruncated,
      on: this.on,
      fileError: this.fileError,
    });
  }

  /**
   * Explains why the active tab is in read-only mode.
   *
   * @returns {string}
   */
  readonlyReason() {
    return readonlyReason({
      isBinary: this.isBinary,
      isImage: this.isImage,
      isTruncated: this.isTruncated,
      on: this.on,
      fileError: this.fileError,
    });
  }

  /**
   * Recreates the EditorState instance outside render() to preserve GPUI invariants.
   * Reuses the current EditorState when its inputs are unchanged, preserving scroll/selection/fold state across identical reloads.
   *
   * @param {boolean} [forceDiskValue=false]
   */
  rebuildEditor(forceDiskValue = false) {
    if (this.preparedText === null || this.isBinary) {
      this.code?.release();
      this.code = null;
      this.editorInputs = null;
      return;
    }

    const hasPreview = isMarkdownFile(this.file) || this.isSvg;
    if (hasPreview && this.viewMode !== "code") {
      return;
    }

    const { language } = detectLanguage(this.file);
    const t = theme();
    const appSettings = settings() || {};
    const syntax = buildSyntaxTheme(t);

    if (this.code && !forceDiskValue && !this.editorInputsChanged(syntax, appSettings)) {
      return;
    }

    const editorValue = forceDiskValue || !this.code ? (this.preparedText ?? "") : this.code.value();

    this.code?.release();
    this.code = null;

    this.code = EditorState.new({
      language,
      value: editorValue,
      readonly: this.isReadonly(),
      line_numbers: true,
      folding: true,
      soft_wrap: this.wrap,
      font_family: appSettings.font_family,
      font_size: 13,
      syntax,
    });
    this.editorInputs = {
      file: this.file,
      wrap: this.wrap,
      font: appSettings.font_family,
      syntax: JSON.stringify(syntax),
    };
    this.setupEditorListeners();
    this.updateCachedTabState({ code: this.code, editorInputs: this.editorInputs });
  }

  /**
   * Subscribes to EditorState change events.
   */
  setupEditorListeners() {
    if (!this.code) return;
    this.code.on("change", (_event, cx) => {
      this.handleEditorChange(cx);
    });
  }

  /**
   * Responds to user text input inside the editor, tracking dirty state and updating line count.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleEditorChange(cx) {
    if (!this.code || this.closed) return;
    const current = this.code.value();
    const newDirty = isContentDirty(current, this.rawText);
    const newLineCount = countLines(current);

    let notifyNeeded = false;
    if (this.dirty !== newDirty) {
      this.dirty = newDirty;
      if (newDirty) this.promotePreviewTab();
      notifyNeeded = true;
    }
    if (this.lineCount !== newLineCount) {
      this.lineCount = newLineCount;
      notifyNeeded = true;
    }
    this.preparedText = current;
    this.updateCachedTabState({ dirty: newDirty, lineCount: newLineCount, preparedText: current });
    if (notifyNeeded) {
      cx.notify();
    }
  }

  /**
   * Probes whether the optional new-pane chooser mod is installed in Herdr.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  probeChooser(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/mods/new-pane/mod.json`);
        this.withChooser = typeof text === "string";
      } catch {
        this.withChooser = false;
      }
      cx.notify();
    });
  }

  /**
   * Resolves the pane ID that hosts this file editor instance.
   *
   * @returns {string | null}
   */
  findCurrentPaneId() {
    const pId = props()?.pane;
    if (pId) return pId;
    const activeSpace = (spaces() || []).find((s) => s.active);
    const activeTab = activeSpace?.tabs?.find((t) => t.active);
    const allPanes = panes() || [];
    const found = allPanes.find((p) => {
      if (p.mod !== "file-editor") return false;
      if (activeTab && p.tab !== activeTab.id) return false;
      return p.props?.file === this.file || p.title === splitPathInfo(this.file).base;
    });
    return found?.pane ?? null;
  }

  /**
   * Splits this file editor pane to the right or down.
   *
   * @param {"right" | "down"} [direction="right"]
   * @param {import("gpui-kit").ViewContext} [cx]
   */
  splitPane(direction = "right", cx) {
    const paneId = this.findCurrentPaneId();
    const activeSpace = (spaces() || []).find((s) => s.active);
    const req = buildSplitPaneRequest(direction, paneId, activeSpace?.id, this.root, this.withChooser);
    run("pane.split", req);
    this.promotePreviewTab();
    if (cx) cx.notify();
  }

  /**
   * Keyboard shortcut listener on the tab container for saving with Cmd+S / Ctrl+S,
   * splitting with Cmd+\ / Ctrl+\, and toggling soft wrap with Alt+Z / Opt+Z.
   *
   * @param {import("gpui-kit").KeyEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleKeyDown(event, cx) {
    const commandOrControl = Boolean(event.modifiers?.platform || event.modifiers?.control);
    const key = String(event.key ?? "").toLowerCase();

    if (this.find?.open && this.handleFindWidgetKeyDown(event, cx)) {
      return;
    }

    const isFindShortcut =
      event.keystroke === "cmd-f" ||
      event.keystroke === "ctrl-f" ||
      (commandOrControl && !event.modifiers?.shift && (key === "f" || key === "F"));

    if (isFindShortcut && !event.is_held) {
      cx.stop_propagation();
      if (!this.isImage) this.openFind(cx);
      return;
    }

    const isSave =
      event.keystroke === "cmd-s" ||
      event.keystroke === "ctrl-s" ||
      ((event.modifiers?.platform || event.modifiers?.control) && (event.key === "s" || event.key === "S"));

    if (isSave && !event.is_held) {
      cx.stop_propagation();
      this.saveFile(cx);
      return;
    }

    const isSplit =
      event.keystroke === "cmd-\\" ||
      event.keystroke === "ctrl-\\" ||
      ((event.modifiers?.platform || event.modifiers?.control) && (event.key === "\\" || event.key === "|"));

    if (isSplit && !event.is_held) {
      cx.stop_propagation();
      this.splitPane("right", cx);
      return;
    }

    const hasPreview = isMarkdownFile(this.file) || this.isSvg;
    const isCodeView = !this.isImage && (!hasPreview || this.viewMode === "code");
    const isToggleWrap =
      event.keystroke === "alt-z" ||
      event.keystroke === "opt-z" ||
      event.keystroke === "option-z" ||
      (Boolean(event.modifiers?.alt) &&
        !event.modifiers?.platform &&
        !event.modifiers?.control &&
        (event.key === "z" || event.key === "Z" || event.key === "Ω" || event.key === "œ"));

    if (isCodeView && isToggleWrap && !event.is_held) {
      cx.stop_propagation();
      this.setWrap(!this.wrap, cx);
    }
  }

  /**
   * Saves the current editor content to disk asynchronously off the UI thread.
   * Employs snapshot matching to prevent overwriting external changes.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  saveFile(cx) {
    if (this.closed || this.saving || this.isReadonly() || !this.file) return;

    const textToSave = this.code ? this.code.value() : (this.preparedText ?? "");
    const root = this.root;
    const file = this.file;
    const on = this.on;
    const fullPath = root ? `${root}/${file}` : file;
    const expectedSnapshot = this.rawText;
    const { base } = splitPathInfo(file);

    this.saving = true;
    this.lastSavedText = textToSave;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        if (on) {
          await writeRemoteTextFile(fullPath, textToSave, on, expectedSnapshot);
        } else {
          await writeTextFile(fullPath, textToSave, expectedSnapshot);
        }
        if (this.closed) return;
        this.rawText = textToSave;
        this.preparedText = textToSave;
        this.dirty = this.code ? isContentDirty(this.code.value(), textToSave) : false;
        this.saving = false;
        this.fileError = null;
        this.lineCount = this.code ? countLines(this.code.value()) : countLines(textToSave);
        this.updateCachedTabState({ dirty: false, rawText: textToSave, preparedText: textToSave });
        notify({
          title: "Saved",
          body: base,
          level: "success",
          timeout: 1500,
        });
      } catch (err) {
        if (this.closed) return;
        this.saving = false;
        const errStr = err?.message || String(err) || "Failed to save file";
        const isConflict =
          errStr.includes("stale") ||
          errStr.includes("mismatch") ||
          errStr.includes("expected");
        notify({
          title: "Save failed",
          body: isConflict
            ? "File was modified externally on disk. Refresh to view latest changes."
            : errStr,
          level: "blocked",
          timeout: 3500,
        });
      } finally {
        if (!this.closed) {
          cx.notify();
        }
      }
    });
  }

  /**
   * Whether the EditorState must be rebuilt for the current inputs. The file
   * text is compared directly: serializing it on every tick (the old
   * signature) costs O(file size) twice a second per open tab.
   *
   * @param {object} syntax the syntax theme the editor would use
   * @param {{ font_family?: string }} appSettings
   * @returns {boolean}
   */
  editorInputsChanged(syntax, appSettings) {
    const prev = this.editorInputs;
    if (!prev) return true;
    return (
      prev.file !== this.file ||
      prev.wrap !== this.wrap ||
      prev.font !== appSettings.font_family ||
      prev.syntax !== JSON.stringify(syntax)
    );
  }

  /**
   * Restores keyboard focus to the editor element without requiring mouse clicks.
   * Focuses the tab container handle and advances focus into the child Editor tab stop.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  focusEditor(cx) {
    if (this.closed || this.isImage || (this.viewMode !== "code" && (isMarkdownFile(this.file) || this.isSvg))) {
      return;
    }
    const attempt = () => {
      try {
        if (this.closed || !this.code) return;
        this.focusHandle?.focus();
        globalThis.window?.focus_next();
      } catch {}
    };
    attempt();
    cx.timer.after(20, attempt);
    cx.timer.after(80, attempt);
  }

  /**
   * Toggles soft wrapping, persists setting in shared state, and rebuilds editor.
   *
   * @param {boolean} wrap
   * @param {import("gpui-kit").ViewContext} cx
   */
  setWrap(wrap, cx) {
    if (this.wrap === wrap) return;
    this.wrap = wrap;
    this.explicitWrap = true;
    setShared("file-editor.wrap", wrap);
    this.updateCachedTabState({ wrap });
    this.rebuildEditor();
    cx.notify();
    this.focusEditor(cx);
  }

  /**
   * Toggles Markdown preview vs. raw code view mode.
   *
   * @param {"preview" | "code"} mode
   * @param {import("gpui-kit").ViewContext} cx
   * @param {{ focus?: boolean }} [options] Pass `focus: false` when another
   *   control (the find input) should keep the keyboard.
   */
  setViewMode(mode, cx, options = {}) {
    if (this.viewMode === mode) return;
    if (mode === "preview" && this.find?.open) this.closeFind(cx, { focus: false });
    if (this.code) {
      const currentText = this.code.value();
      this.preparedText = currentText;
      if (this.isSvg && mode === "preview") {
        this.loadSvgImage(cx);
      }
    }
    this.viewMode = mode;
    if (mode === "code") {
      if (!this.code) {
        this.rebuildEditor();
      }
      if (options.focus !== false) this.focusEditor(cx);
    } else if (mode === "preview" && this.isSvg && !this.imageSrc && !this.imageLoading) {
      this.loadImage(cx);
    }
    this.updateCachedTabState({ viewMode: mode });
    cx.notify();
  }

  /**
   * Whether the active tab shows a picture that can be zoomed: a raster image,
   * or an SVG while its rendered preview (not the code view) is selected.
   * Remote files have no preview at all, so they offer no controls.
   *
   * @returns {boolean}
   */
  showsPicturePreview() {
    return !this.on && (this.isImage || (this.isSvg && this.viewMode === "preview"));
  }

  /**
   * Steps the picture preview zoom through the shared level ladder.
   *
   * @param {number} direction Positive zooms in, negative zooms out.
   * @param {import("gpui-kit").ViewContext} cx
   */
  zoomPicture(direction, cx) {
    const next = stepImageZoom(this.imageZoom, direction);
    if (next === normalizeImageZoom(this.imageZoom)) return;
    this.imageZoom = next;
    this.updateCachedTabState({ imageZoom: next });
    cx.notify();
  }

  /**
   * Returns the picture preview to fit-to-pane (100%).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  resetPictureZoom(cx) {
    if (this.imageZoom === 1) return;
    this.imageZoom = 1;
    this.updateCachedTabState({ imageZoom: 1 });
    cx.notify();
  }

  /**
   * Cmd/Ctrl + wheel zooms the picture instead of scrolling it. Plain wheel
   * scrolling keeps panning the zoomed canvas, which is what overflow_scrollbar
   * owns. The wheel bounds are the preview viewport itself, so they also give
   * the pixel sizing path an exact pane size without waiting for a pointer move.
   *
   * @param {import("gpui-kit").ScrollWheelEvent} event
   * @param {import("gpui-kit").Context} cx
   */
  handlePictureWheel(event, cx) {
    const bounds = event.bounds;
    if (bounds) {
      this.pictureViewport = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
      this.tabViewport = this.pictureViewport;
    }
    const modifiers = event.modifiers || {};
    if (!modifiers.platform && !modifiers.control) {
      if (this.imageZoom > 1) {
        const dx = event.delta?.x || 0;
        const dy = event.delta?.y || 0;
        const nextX = Math.max(0, (this.pictureScrollX || 0) - dx);
        const nextY = Math.max(0, (this.pictureScrollY || 0) - dy);
        if (nextX !== this.pictureScrollX || nextY !== this.pictureScrollY) {
          this.pictureScrollX = nextX;
          this.pictureScrollY = nextY;
          this.updateCachedTabState();
          cx.notify();
        }
      }
      return;
    }
    const delta = event.delta?.y || event.delta?.x || 0;
    if (delta === 0) return;
    this.zoomPicture(delta < 0 ? 1 : -1, cx);
    cx.stop_propagation();
  }

  /**
   * Remembers the tab's bounds as the viewport, so the pixel-based fit and scroll math
   * have the real pane size. Called from pointer events on the tab root.
   *
   * @param {{ width: number, height: number } | undefined} bounds
   * @param {import("gpui-kit").Context} cx
   */
  rememberViewport(bounds, cx) {
    if (!bounds) return;
    const width = Math.round(bounds.width);
    const height = Math.max(1, Math.round(bounds.height - HEADER_HEIGHT));
    const previous = this.tabViewport;
    if (previous && previous.width === width && previous.height === height) return;
    this.tabViewport = { width, height };
    if (this.showsPicturePreview()) {
      this.pictureViewport = { width, height };
    }
    this.updateCachedTabState({ tabViewport: this.tabViewport, pictureViewport: this.pictureViewport });
    if (this.showsPicturePreview() || this.isMarkdown) {
      cx.notify();
    }
  }

  /**
   * Renders the zoom out / percentage / zoom in group shown beside the view
   * switcher for picture previews. The percentage doubles as the reset-to-fit
   * button.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderZoomControls(t) {
    const zoom = normalizeImageZoom(this.imageZoom);

    /**
     * @param {string} id
     * @param {string} label
     * @param {string} tooltip
     * @param {boolean} enabled
     * @param {(cx: import("gpui-kit").ViewContext) => void} onClick
     */
    const button = (id, label, tooltip, enabled, onClick) =>
      div()
        .id(id)
        .w(20)
        .h(20)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .text_size(12)
        .cursor_pointer()
        .when(enabled, (b) => b.text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .when(!enabled, (b) => b.opacity(0.35))
        .tooltip(tooltip)
        .on_click((_e, cx) => {
          if (enabled) onClick(cx);
        })
        .child(label);

    return h_flex()
      .id("file-editor-zoom")
      .flex_none()
      .items_center()
      .gap(1)
      .p(2)
      .rounded(6)
      .bg(t.raised)
      .child(button("file-zoom-out", "−", "Zoom out", zoom > IMAGE_ZOOM_MIN, (cx) => this.zoomPicture(-1, cx)))
      .child(
        div()
          .id("file-zoom-reset")
          .min_w(40)
          .h(20)
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .text_size(10)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Reset zoom to fit")
          .on_click((_e, cx) => this.resetPictureZoom(cx))
          .child(imageZoomPercent(zoom))
      )
      .child(button("file-zoom-in", "+", "Zoom in", zoom < IMAGE_ZOOM_MAX, (cx) => this.zoomPicture(1, cx)));
  }

  /**
   * Watches the root workspace folder to reload the active tab when modified externally.
   * Filters change events using shouldReloadWatchedFile to avoid unnecessary reloads.
   *
   * @param {string} root
   * @param {import("gpui-kit").ViewContext} cx
   */
  watchTab(root, cx) {
    if (this.on || !root || this.watched === root) return;
    this.watched = root;
    const token = (this.watchToken = {});
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token && !this.closed) {
          let changed;
          try {
            changed = await watchFolder(root);
          } catch {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          if (this.watchToken === token && !this.closed) {
            if (shouldReloadWatchedFile(changed, root, this.file)) {
              if (this.dirty) {
                // Do not clobber active unsaved edits with background disk reload
                continue;
              }
              if (this.code && this.lastSavedText !== null && this.code.value() === this.lastSavedText) {
                // Disk event was triggered by our own save; ignore to keep editor cursor intact
                this.lastSavedText = null;
                continue;
              }
              this.loadFile(cx);
            }
          }
        }
      } catch {
        if (this.watchToken === token) {
          this.watched = null;
          this.watchToken = null;
        }
      }
    });
  }

  /**
   * Periodically checks if the open file has changed on disk.
   * Reloads content when modified externally and no local unsaved edits are present.
   * Works across SSH remote machines, Docker containers, and missed watcher events.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  checkDiskChanges(cx) {
    if (this.closed || this.loading || this.saving || this.dirty || !this.file) return;

    const root = this.root;
    const file = this.file;
    const on = this.on;
    const fullPath = root ? `${root}/${file}` : file;

    cx.spawn(async (cx) => {
      if (this.closed || this.loading || this.saving || this.dirty) return;
      try {
        const text = await readTextFile(fullPath, { on });
        if (this.closed || this.loading || this.saving || this.dirty) return;
        if (typeof text !== "string") return;

        // If content on disk matches what we already have, do nothing
        if (text === this.rawText) return;

        // File was updated externally! Reload the file so latest changes appear immediately
        this.loadFile(cx);
      } catch {
        // Silently ignore transient read errors during background polling
      }
    });
  }

  /**
   * Renders the full-size file editor tab (header toolbar + code or markdown view).
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @returns {import("gpui-kit").Element}
   */
  renderFileTab(cx) {
    const t = theme();
    const codeFont = settings()?.font_family ?? "monospace";
    const { base, dir } = splitPathInfo(this.file);
    const isMarkdown = isMarkdownFile(this.file);
    const isSvg = this.isSvg;
    const hasPreview = isMarkdown || isSvg;
    const { label: langLabel } = detectLanguage(this.file);
    const lineLabel = this.isImage
      ? `Image · ${(base.split(".").pop() || "").toUpperCase()}`
      : `${this.lineCount} line${this.lineCount === 1 ? "" : "s"} · ${langLabel}`;
    const isCodeView = !this.isImage && (!hasPreview || this.viewMode === "code");
    const preview = this.isPreviewTab();
    const tabId = fileElementId("file-editor-tab", this.fileKey);

    return v_flex()
      .id(tabId)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.focusHandle)
      .key_context("FileEditor")
      .on_action("file-editor.find", (_event, cx) => this.openFind(cx))
      .on_action("file-editor.replace", (_event, cx) => this.openFindReplace(cx))
      .on_action("file-editor.find-next", (_event, cx) => this.stepFindOrOpen(1, cx))
      .on_action("file-editor.find-prev", (_event, cx) => this.stepFindOrOpen(-1, cx))
      .on_action("file-editor.find-close", (_event, cx) => this.closeFind(cx))
      .on_key_down((event, cx) => this.handleKeyDown(event, cx))
      .on_mouse_move((event, cx) => this.rememberViewport(event?.bounds, cx))
      .on_mouse_down("left", (event, cx) => {
        this.rememberViewport(event?.bounds, cx);
        setShared("file-editor.activeFile", { root: this.root, file: this.file });
        const paneId = this.findCurrentPaneId();
        if (paneId) run("pane.focus", { pane: paneId });
      })
      .child(
        h_flex()
          .h(HEADER_HEIGHT)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(image(fileIconPath(base, isLightColor(t.background))).size(14).flex_none())
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .min_w(0)
              .child(
                div()
                  .min_w(0)
                  .font_semibold()
                  .text_size(12.5)
                  .truncate()
                  .when(preview, (el) => el.italic())
                  .when(preview, (el) => el.text_color(t.dim))
                  .when(preview, (el) => el.tooltip("Preview tab — double-click the file in the Explorer to keep it open"))
                  .child(base)
              )
              .when(this.dirty, (el) =>
                el.child(
                  div()
                    .size(6)
                    .rounded_full()
                    .bg(t.accent)
                    .tooltip("Unsaved changes")
                )
              )
          )
          .when(!this.isImage, (e) =>
            e.child(
              h_flex()
                .id("file-editor-copy")
                .flex_none()
                .w(24)
                .h(24)
                .items_center()
                .justify_center()
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .text_color(t.muted)
                .tooltip("Copy file content")
                .on_click((_e, cx) => {
                  const textToCopy = this.code ? this.code.value() : (this.rawText ?? "");
                  cx.write_to_clipboard(textToCopy);
                  notify({ title: "File copied", body: base, level: "success", timeout: 1500 });
                })
                .child(svg("mods/file-editor/copy.svg").size(12))
            )
          )
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(dir))
          .child(
            h_flex()
              .flex_none()
              .h(24)
              .items_center()
              .px(6)
              .rounded(4)
              .bg(t.raised)
              .text_size(10)
              .text_color(t.muted)
              .child(lineLabel)
          )
          .when(this.isReadonly(), (e) =>
            e.child(
              h_flex()
                .id("file-editor-readonly")
                .flex_none()
                .w(24)
                .h(24)
                .items_center()
                .justify_center()
                .rounded(4)
                .bg(t.raised)
                .text_color(t.dim)
                .tooltip(this.readonlyReason() || "Read-only")
                .child(svg("mods/file-editor/lock.svg").size(12))
            )
          )
          .when(!this.isReadonly(), (e) =>
            e.child(
              h_flex()
                .id("file-editor-save")
                .flex_none()
                .w(24)
                .h(24)
                .items_center()
                .justify_center()
                .rounded(4)
                .when(this.dirty && !this.saving, (btn) =>
                  btn
                    .bg(t.accent)
                    .text_color(t.background)
                    .cursor_pointer()
                    .hover((s) => s.opacity(0.85))
                    .tooltip("Save changes (Cmd+S)")
                    .on_click((_e, cx) => this.saveFile(cx))
                )
                .when(!this.dirty && !this.saving, (btn) =>
                  btn
                    .bg(t.raised)
                    .text_color(t.dim)
                    .cursor_default()
                    .tooltip("No unsaved changes")
                )
                .when(this.saving, (btn) =>
                  btn
                    .bg(t.raised)
                    .text_color(t.dim)
                    .cursor_default()
                    .tooltip("Saving…")
                )
                .child(svg("mods/file-editor/save.svg").size(12))
            )
          )
          .when(hasPreview, (e) =>
            e.child(
              h_flex()
                .flex_none()
                .items_center()
                .gap(1)
                .p(2)
                .rounded(6)
                .bg(t.raised)
                .child(
                  h_flex()
                    .id("file-view-preview")
                    .w(20)
                    .h(20)
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .when(this.viewMode === "preview", (btn) => btn.bg(t.selected).text_color(t.foreground))
                    .when(this.viewMode !== "preview", (btn) => btn.text_color(t.dim))
                    .hover((s) => s.bg(this.viewMode === "preview" ? t.selected : t.hover))
                    .tooltip(isSvg ? "Rendered SVG preview" : "Rendered Markdown preview")
                    .on_click((_e, cx) => this.setViewMode("preview", cx))
                    .child(svg("mods/file-editor/eye.svg").size(12))
                )
                .child(
                  h_flex()
                    .id("file-view-code")
                    .w(20)
                    .h(20)
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .when(this.viewMode === "code", (btn) => btn.bg(t.selected).text_color(t.foreground))
                    .when(this.viewMode !== "code", (btn) => btn.text_color(t.dim))
                    .hover((s) => s.bg(this.viewMode === "code" ? t.selected : t.hover))
                    .tooltip("Raw code and syntax view")
                    .on_click((_e, cx) => this.setViewMode("code", cx))
                    .child(svg("mods/file-editor/code.svg").size(12))
                )
            )
          )
          .when(this.showsPicturePreview(), (e) => e.child(this.renderZoomControls(t)))
          .when(!this.isImage, (e) =>
            e.child(
              h_flex()
                .id("file-editor-find")
                .flex_none()
                .w(24)
                .h(24)
                .items_center()
                .justify_center()
                .rounded(4)
                .cursor_pointer()
                .when(this.find?.open, (btn) => btn.bg(t.selected).text_color(t.foreground))
                .when(!this.find?.open, (btn) => btn.text_color(t.dim))
                .hover((s) => s.bg(this.find?.open ? t.selected : t.hover))
                .tooltip("Find in file (Cmd+F)")
                .on_click((_e, cx) => this.openFind(cx))
                .child(svg("mods/file-editor/search.svg").size(12))
            )
          )
          .when(isCodeView, (e) =>
            e.child(
              h_flex()
                .id("file-editor-wrap")
                .flex_none()
                .w(24)
                .h(24)
                .items_center()
                .justify_center()
                .rounded(4)
                .cursor_pointer()
                .when(this.wrap, (btn) => btn.bg(t.selected).text_color(t.foreground))
                .when(!this.wrap, (btn) => btn.text_color(t.dim))
                .hover((s) => s.bg(this.wrap ? t.selected : t.hover))
                .tooltip(
                  this.wrap
                    ? "Wrap long lines to pane width (Alt+Z)"
                    : "Scroll lines horizontally (Alt+Z)"
                )
                .on_click((_e, cx) => this.setWrap(!this.wrap, cx))
                .child(svg("mods/file-editor/wrap.svg").size(12))
            )
          )
          .child(
            h_flex()
              .id("file-editor-split-right")
              .flex_none()
              .w(24)
              .h(24)
              .items_center()
              .justify_center()
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_color(t.dim)
              .tooltip("Split right (Cmd+\\)")
              .on_click((_e, cx) => this.splitPane("right", cx))
              .child(svg("mods/file-editor/split-right.svg").size(13))
          )
          .child(
            h_flex()
              .id("file-editor-split-down")
              .flex_none()
              .w(24)
              .h(24)
              .items_center()
              .justify_center()
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_color(t.dim)
              .tooltip("Split down")
              .on_click((_e, cx) => this.splitPane("down", cx))
              .child(svg("mods/file-editor/split-down.svg").size(13))
          )
          .child(
            h_flex()
              .id("file-editor-refresh")
              .flex_none()
              .w(24)
              .h(24)
              .items_center()
              .justify_center()
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_color(t.accent)
              .tooltip("Reload file from disk")
              .on_click((_e, cx) => {
                this.dirty = false;
                this.loadFile(cx);
              })
              .child(svg("mods/file-editor/refresh.svg").size(12))
          )
      )
      .child(
        v_flex()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            Boolean(this.fileError)
              ? v_flex()
                  .flex_1()
                  .min_h(0)
                  .p(24)
                  .gap(8)
                  .items_center()
                  .justify_center()
                  .child(
                    div()
                      .max_w(620)
                      .text_size(12)
                      .text_color(t.dim)
                      .child(this.loading ? "Loading file…" : this.fileError)
                  )
              : this.isImage
                ? this.renderImageView(t)
                : !isCodeView
                  ? isMarkdown
                    ? this.renderMarkdownView(t)
                    : this.renderSvgView(t)
                  : this.find?.open
                    ? renderFindCodeView(this, t, codeFont)
                    : this.renderCodeView(t)
          )
          .when(this.find?.open && !this.isImage, (el) => el.child(renderFindBar(this, t)))
      );
  }

  /**
   * Copies the picture into the app's own cache folder, so the host can draw it.
   * The host only reads images under the app folder, so each load writes a new,
   * timestamped copy and removes the previous one. Outside `mods/`, so the copy
   * does not trigger a mod reload.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  loadImage(cx) {
    if (!this.file || this.closed || this.on) return;
    if (this.isSvg) {
      this.loadSvgImage(cx);
      return;
    }
    const src = this.root ? `${this.root}/${this.file}` : this.file;
    const ext = splitPathInfo(this.file).ext;
    const safe = src.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
    const rel = `cache/file-editor/${safe}-${Date.now()}.${ext}`;
    const home = appHome();
    // Copy, then drop every older copy of this same image.
    const script = 'mkdir -p "$1" && cp -f "$4" "$3" && for old in "$1/$2"-*; do [ "$old" = "$3" ] || rm -f "$old"; done';
    this.imageLoading = true;
    cx.spawn(async (cx) => {
      const [r, bytes] = await Promise.all([
        exec("sh", ["-c", script, "copy", `${home}/cache/file-editor`, safe, `${home}/${rel}`, src]).catch(() => null),
        readBinaryFile(src).catch(() => null),
      ]);
      if (this.closed) return;
      this.imageLoading = false;
      if (r?.code === 0) {
        this.imageSize = bytes ? imageHeaderSize(bytes) : null;
        this.imageSrc = rel;
        this.fileError = null;
      } else {
        this.imageSize = null;
        this.imageSrc = null;
        this.fileError = "Could not load this image.";
      }
      cx.notify();
    });
  }

  /**
   * Writes an enlarged copy of the SVG source to the cache and points the
   * preview at it. The host rasterizes SVG at the root width/height, so the
   * copy is scaled up to keep small icon view boxes crisp.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  loadSvgImage(cx) {
    const sourceText = this.code ? this.code.value() : this.rawText;
    if (typeof sourceText !== "string") return;
    const src = this.root ? `${this.root}/${this.file}` : this.file;
    const safe = src.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
    const rel = `cache/file-editor/${safe}-${Date.now()}.svg`;
    const home = appHome();
    const dir = `${home}/cache/file-editor`;
    const fullPath = `${home}/${rel}`;
    const prepared = this.isTruncated ? null : prepareSvgPreviewInfo(sourceText);
    this.imageLoading = true;
    cx.spawn(async (cx) => {
      let ok = false;
      try {
        await exec("sh", ["-c", 'mkdir -p "$1"', "cache", dir]);
        if (prepared === null) {
          // Unrecognized or truncated source: let the host render the original.
          const r = await exec("sh", ["-c", 'cp -f "$1" "$2"', "copy", src, fullPath]);
          ok = r.code === 0;
        } else {
          await writeTextFile(fullPath, prepared.text, null);
          ok = true;
        }
        // Drop every older copy of this same SVG.
        await exec("sh", ["-c", 'for old in "$1/$2"-*; do [ "$old" = "$3" ] || rm -f "$old"; done', "clean", dir, safe, fullPath]).catch(() => null);
      } catch {
        ok = false;
      }
      if (this.closed) return;
      this.imageLoading = false;
      this.imageSize = ok && prepared ? { width: prepared.width, height: prepared.height } : null;
      this.imageSrc = ok ? rel : null;
      cx.notify();
    });
  }

  /**
   * Shows a raster image on a zoomable, pannable canvas. 100% fits the picture
   * to the pane; higher zoom levels overflow and scroll.
   * The host reads images from this machine's disk, so remote files get a notice.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderImageView(t) {
    if (this.on) {
      return v_flex()
        .flex_1()
        .min_h(0)
        .p(24)
        .items_center()
        .justify_center()
        .child(div().max_w(620).text_size(12).text_color(t.dim).child("Image preview works only for files on this machine."));
    }
    const imgId = fileElementId("file-editor-image", this.fileKey);
    return v_flex()
      .id(imgId)
      .flex_1()
      .min_h(0)
      .bg(t.background)
      .when(Boolean(this.imageSrc), (e) => e.child(this.renderPictureCanvas(t)))
      .when(!this.imageSrc && Boolean(this.imageLoading || this.loading), (e) =>
        e.p(24).items_center().justify_center().child(div().max_w(620).text_size(12).text_color(t.dim).child("Loading image…"))
      )
      .when(!this.imageSrc && !this.imageLoading && !this.loading, (e) =>
        e
          .p(24)
          .items_center()
          .justify_center()
          .child(div().max_w(620).text_size(12).text_color(t.dim).child("Could not render image preview."))
      );
  }

  /**
   * Shows an SVG on a light canvas, scaled to fit the pane and zoomable like a
   * raster image.
   *
   * Resvg has no `currentColor` context, so icons that inherit their color are
   * drawn black. A light canvas keeps those visible on dark themes, and sizing
   * the image to the pane makes small icon view boxes readable.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderSvgView(t) {
    if (this.on) {
      return v_flex()
        .flex_1()
        .min_h(0)
        .p(24)
        .items_center()
        .justify_center()
        .child(div().max_w(620).text_size(12).text_color(t.dim).child("Image preview works only for files on this machine."));
    }
    const svgId = fileElementId("file-editor-svg", this.fileKey);
    return v_flex()
      .id(svgId)
      .flex_1()
      .min_h(0)
      .bg(t.background)
      .when(Boolean(this.imageSrc), (e) => e.child(this.renderPictureCanvas(t, { whiteCanvas: true })))
      .when(!this.imageSrc && Boolean(this.imageLoading || this.loading), (e) =>
        e.p(24).items_center().justify_center().child(div().max_w(620).text_size(12).text_color(t.dim).child("Loading image…"))
      )
      .when(!this.imageSrc && !this.imageLoading && !this.loading, (e) =>
        e
          .p(24)
          .items_center()
          .justify_center()
          .child(div().max_w(620).text_size(12).text_color(t.dim).child("Could not render image preview."))
      );
  }

  /**
   * Renders the picture with a zoom-relative size. With the pane size and the
   * image's own dimensions known, the fit scale is computed so 100% is exactly
   * "fit the pane"; larger levels grow from there and scroll. Until the pane
   * has been measured (on the first pointer move), a percentage canvas keeps
   * the 100% view fitting.
   *
   * @param {Record<string, string>} t
   * @param {{ whiteCanvas?: boolean }} [options]
   * @returns {import("gpui-kit").Element}
   */
  renderPictureCanvas(t, options = {}) {
    const zoom = normalizeImageZoom(this.imageZoom);
    const percent = imageZoomPercent(zoom);
    const whiteCanvas = options.whiteCanvas === true;
    const size = this.imageSize;
    const viewport = this.pictureViewport;
    const picId = fileElementId("file-editor-picture", this.fileKey);

    const scrollArea = v_flex()
      .id(picId)
      .size_full()
      .overflow_scroll()
      .bg(t.background)
      .on_scroll_wheel((event, cx) => this.handlePictureWheel(event, cx));

    let content;
    if (!size || !viewport || viewport.width <= 0 || viewport.height <= 0) {
      if (!size) {
        // Dimensions unknown (an unsupported header): fall back to the host's
        // natural-size rendering inside the pane.
        content = scrollArea.items_center().justify_center().child(
          v_flex()
            .flex_none()
            .p(PICTURE_PADDING)
            .items_center()
            .justify_center()
            .when(whiteCanvas, (e) => e.bg("#ffffff").rounded(8).border(1).border_color(t.border))
            .child(image(this.imageSrc).max_w_full().max_h_full())
        );
      } else {
        // Before the pane has been measured, fit by width using a percentage
        // aspect box: the padding-top resolves against the box's own width, so
        // the picture keeps its ratio without knowing the pane in pixels.
        const aspect = size.height > 0 ? size.width / size.height : 1;
        const aspectPadding = Math.min(4000, 100 / aspect);
        content = scrollArea.items_center().child(
          v_flex()
            .w(percent)
            .flex_none()
            .m_auto()
            .p(PICTURE_PADDING)
            .when(zoom === 1, (e) => e.max_w(size.width + PICTURE_PADDING * 2))
            .when(whiteCanvas, (e) => e.bg("#ffffff").rounded(8).border(1).border_color(t.border))
            .child(
              v_flex()
                .relative()
                .w_full()
                .pt(`${Math.round(aspectPadding * 10000) / 10000}%`)
                .child(image(this.imageSrc).absolute().inset_0().w_full().h_full())
            )
        );
      }
    } else {
      // Fit the whole picture inside the pane at 100%, never enlarging it.
      const availableWidth = Math.max(1, viewport.width - PICTURE_PADDING * 2);
      const availableHeight = Math.max(1, viewport.height - PICTURE_PADDING * 2);
      const fitScale = Math.min(1, availableWidth / size.width, availableHeight / size.height);
      const width = Math.max(1, Math.round(size.width * fitScale * zoom));
      const height = Math.max(1, Math.round(size.height * fitScale * zoom));

      content = scrollArea
        .when(zoom <= 1, (e) => e.items_center().justify_center())
        .when(zoom > 1, (e) => e.items_start())
        .child(
          v_flex()
            .relative()
            .when(zoom > 1, (e) => e.left(-this.pictureScrollX).top(-this.pictureScrollY))
            .flex_none()
            .p(PICTURE_PADDING)
            .when(whiteCanvas, (e) => e.bg("#ffffff").rounded(8).border(1).border_color(t.border))
            .child(image(this.imageSrc).w(width).h(height))
        );
    }

    return div()
      .relative()
      .size_full()
      .flex_1()
      .min_h(0)
      .child(content)
      .child(Scrollbar.new(picId).absolute().inset_0());
  }

  /**
   * Renders the Markdown preview as a GitHub-style document, centered in a readable column.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderMarkdownView(t) {
    const codeFont = settings()?.font_family ?? null;
    const mdId = fileElementId("file-editor-markdown", this.fileKey);
    const viewportHeight = this.tabViewport?.height || 600;
    const viewportWidth = this.tabViewport?.width || 800;
    const bottomPadding = Math.max(160, Math.round(viewportHeight * 0.4));
    const estContentHeight = Math.max(
      viewportHeight,
      estimateMarkdownHeight(this.preparedText ?? "", viewportWidth) + bottomPadding
    );
    const maxScroll = Math.max(0, estContentHeight - viewportHeight);
    if (this.preparedText && !this.loading) {
      this.mdScrollY = Math.max(0, Math.min(maxScroll, this.mdScrollY || 0));
    }

    return div()
      .relative()
      .size_full()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_scroll_wheel((event, cx) => {
        const delta =
          event.delta?.y !== 0 && event.delta?.y !== undefined
            ? event.delta.y
            : event.delta_lines?.y
              ? event.delta_lines.y * 24
              : 0;
        if (delta === 0) return;
        const next = Math.max(0, Math.min(maxScroll, (this.mdScrollY || 0) - delta));
        if (next !== this.mdScrollY) {
          this.mdScrollY = next;
          this.updateCachedTabState();
          cx.notify();
        }
      })
      .child(
        v_flex()
          .relative()
          .top(-this.mdScrollY)
          .w_full()
          .bg(t.background)
          .px(32)
          .pt(24)
          .pb(bottomPadding)
          .child(
            v_flex()
              .w_full()
              .items_center()
              .child(
                div()
                  .w_full()
                  .max_w(880)
                  .child(renderMarkdownDocument(this.preparedText ?? "", { t, codeFont, idPrefix: `md-${mdId}` }))
              )
          )
      )
      .when(maxScroll > 0, (e) => {
        const thumbH = Math.max(28, Math.round((viewportHeight / estContentHeight) * viewportHeight));
        const thumbTop = Math.round((this.mdScrollY / maxScroll) * (viewportHeight - thumbH));
        return e.child(
          div()
            .absolute()
            .right(3)
            .top(thumbTop)
            .w(4)
            .h(thumbH)
            .rounded(2)
            .bg(t.dim)
            .opacity(0.6)
        );
      });
  }

  /**
   * Renders syntax-highlighted code editor view.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderCodeView(t) {
    if (this.code) {
      const codeId = fileElementId("file-editor-code", this.fileKey);
      return Editor.new(this.code).id(codeId).flex_1().min_h(0);
    }
    const emptyId = fileElementId("file-editor-code-empty", this.fileKey);
    return v_flex()
      .id(emptyId)
      .flex_1()
      .min_h(0)
      .p(24)
      .items_center()
      .justify_center()
      .child(
        div()
          .text_size(12)
          .text_color(t.dim)
          .child(this.loading ? "Loading file…" : "No content")
      );
  }

  /* ========================================================================
   * In-Editor Find
   * ======================================================================== */

  /**
   * The text the find engine searches. While Code view has an EditorState this
   * is its live buffer (including unsaved edits); otherwise it is the text
   * loaded from disk.
   *
   * @returns {string}
   */
  findSourceText() {
    if (this.code) return this.code.value();
    if (typeof this.preparedText === "string") return this.preparedText;
    if (typeof this.rawText === "string") return this.rawText;
    return "";
  }

  /**
   * Persists the last query and the three match toggles in shared state, so
   * reopening find in any file starts where the user left off.
   */
  persistFindPrefs() {
    if (!this.find) return;
    setShared("file-editor.find", {
      query: this.find.query,
      caseSensitive: this.find.caseSensitive,
      wholeWord: this.find.wholeWord,
      regex: this.find.regex,
      replace: this.find.replace ?? "",
      replaceOpen: this.find.replaceOpen === true,
      preserveCase: this.find.preserveCase === true,
    });
  }

  /**
   * Focuses the find input on the next few frames. Opening the widget and
   * switching a preview to Code view both move the keyboard, so a single
   * synchronous focus can be stolen by focusEditor.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  focusFindInput(cx) {
    const attempt = () => {
      if (this.closed || !this.find?.open) return;
      this.findInput?.focus();
    };
    attempt();
    cx.timer.after(30, attempt);
    cx.timer.after(140, attempt);
  }

  /**
   * Focuses the replace input on the next few frames, mirroring
   * `focusFindInput` so the editor's own focus restoration cannot steal it.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  focusReplaceInput(cx) {
    const attempt = () => {
      if (this.closed || !this.find?.open || !this.find?.replaceOpen) return;
      this.replaceInput?.focus();
    };
    attempt();
    cx.timer.after(30, attempt);
    cx.timer.after(140, attempt);
  }

  /**
   * Opens the find widget, optionally seeded with a query, toggles and a line.
   * Markdown and SVG previews switch to Code view because the read-only match
   * view is the surface that can highlight and scroll to a match.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @param {{
   *   query?: string,
   *   caseSensitive?: boolean,
   *   wholeWord?: boolean,
   *   regex?: boolean,
   *   line?: number,
   *   replace?: string,
   *   replaceOpen?: boolean,
   *   preserveCase?: boolean,
   *   focusReplace?: boolean,
   * }} [options]
   */
  openFind(cx, options = {}) {
    if (this.closed || this.isImage || !this.find || !this.findInput) return;
    const hasPreview = isMarkdownFile(this.file) || this.isSvg;
    if (hasPreview && this.viewMode !== "code") {
      this.setViewMode("code", cx, { focus: false });
    }
    if (!this.code && this.preparedText !== null && !this.isBinary) this.rebuildEditor();
    if (typeof options.query === "string") {
      this.find.query = options.query;
      this.findInput.set_value(options.query);
    }
    for (const key of ["caseSensitive", "wholeWord", "regex"]) {
      if (typeof options[key] === "boolean") this.find[key] = options[key];
    }
    if (typeof options.replace === "string") {
      this.find.replace = options.replace;
      this.replaceInput?.set_value(options.replace);
    }
    if (typeof options.replaceOpen === "boolean") this.find.replaceOpen = options.replaceOpen;
    if (typeof options.preserveCase === "boolean") this.find.preserveCase = options.preserveCase;
    if (Number.isFinite(options.line)) this.pendingFindLine = options.line;
    this.find.open = true;
    this.find.scrollColumn = 0;
    this.refreshFindMatches(cx, false);
    this.persistFindPrefs();
    if (options.focusReplace === true && this.find.replaceOpen) this.focusReplaceInput(cx);
    else this.focusFindInput(cx);
    cx.notify();
  }

  /**
   * Opens find with the replace row expanded (Cmd+Alt+F / Ctrl+H).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  openFindReplace(cx) {
    if (this.closed || this.isImage || !this.find) return;
    this.openFind(cx, { replaceOpen: true, focusReplace: true });
  }

  /**
   * Applies a `find` prop / pending search-result target to this mounted tab.
   *
   * @param {{ query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean, line: number | null }} find
   * @param {import("gpui-kit").ViewContext} cx
   */
  applyFindProp(find, cx) {
    this.openFind(cx, {
      query: find.query,
      caseSensitive: find.caseSensitive,
      wholeWord: find.wholeWord,
      regex: find.regex,
      line: find.line ?? undefined,
      replace: typeof find.replace === "string" ? find.replace : undefined,
      replaceOpen: typeof find.replaceOpen === "boolean" ? find.replaceOpen : undefined,
      preserveCase: typeof find.preserveCase === "boolean" ? find.preserveCase : undefined,
    });
  }

  /**
   * Closes the widget and returns the keyboard to the native Editor. The
   * EditorState is never recreated here, so unsaved edits survive.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @param {{ focus?: boolean }} [options]
   */
  closeFind(cx, options = {}) {
    if (!this.find?.open) return;
    this.find.open = false;
    this.pendingFindLine = null;
    this.findUndo = [];
    if (options.focus !== false) {
      const refocus = (timerCx) => {
        if (!this.closed && !this.find?.open) this.focusEditor(timerCx);
      };
      cx.timer.after(20, refocus);
      cx.timer.after(100, refocus);
    }
    cx.notify();
  }

  /**
   * Handles a change in the find input: re-runs the match engine immediately
   * (it is in-memory and cheap), resets to the first match and persists prefs.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleFindInputChange(cx) {
    if (!this.find) return;
    this.find.query = this.findInput ? this.findInput.value() : "";
    this.pendingFindLine = null;
    this.find.current = -1;
    this.refreshFindMatches(cx, false);
    this.persistFindPrefs();
    cx.notify();
  }

  /**
   * Recomputes matches over the current source and keeps the current index in
   * range. When a line was requested (search-result click), the first match at
   * or after it becomes current.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @param {boolean} [notify=true]
   */
  refreshFindMatches(cx, notify = true) {
    if (!this.find) return;
    const result = findMatches(this.findSourceText(), this.find.query, {
      caseSensitive: this.find.caseSensitive,
      wholeWord: this.find.wholeWord,
      regex: this.find.regex,
      cap: FIND_MATCH_CAP,
    });
    this.find.valid = result.valid;
    this.find.error = result.error;
    this.find.matches = result.matches;
    this.find.limited = result.limited;

    if (!result.valid || result.matches.length === 0) {
      this.find.current = -1;
      this.pendingFindLine = null;
    } else if (this.pendingFindLine !== null && this.pendingFindLine !== undefined) {
      this.find.current = findMatchIndexAtLine(result.matches, this.pendingFindLine - 1);
      this.pendingFindLine = null;
      this.scrollToCurrentFindMatch(cx);
    } else if (this.find.current < 0 || this.find.current >= result.matches.length) {
      this.find.current = 0;
      this.scrollToCurrentFindMatch(cx);
    }

    if (notify) cx.notify();
  }

  /**
   * Brings the current match's line into view in the read-only virtual list.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  scrollToCurrentFindMatch(cx) {
    const match = this.find?.matches?.[this.find.current];
    if (!match) return;
    const line = match.line;
    this.find.scrollColumn = findHorizontalOffset(
      match.column,
      this.tabViewport?.width || this.find?.viewportWidth || 800
    );
    const apply = () => {
      if (this.closed || !this.find?.open) return;
      try {
        this.findScrollHandle?.scroll_to_item(line, "center");
      } catch {}
    };
    apply();
    cx.timer.after(20, apply);
    cx.timer.after(120, apply);
  }

  /**
   * Cmd+G / F3 behaviour: step when find is open, otherwise open it with the
   * last query first (VS Code behaviour). A backward step from a closed widget
   * lands on the last match.
   *
   * @param {1 | -1} direction
   * @param {import("gpui-kit").ViewContext} cx
   */
  stepFindOrOpen(direction, cx) {
    if (!this.find?.open) {
      this.openFind(cx);
      if (direction < 0) this.stepFind(-1, cx);
      return;
    }
    this.stepFind(direction, cx);
  }

  /**
   * Moves to the next or previous match, wrapping around.
   *
   * @param {1 | -1} direction
   * @param {import("gpui-kit").ViewContext} cx
   */
  stepFind(direction, cx) {
    if (!this.find?.open) return;
    const next = stepMatchIndex(this.find.current, this.find.matches.length, direction);
    if (next === this.find.current) return;
    this.find.current = next;
    this.scrollToCurrentFindMatch(cx);
    cx.notify();
  }

  /**
   * Toggles match case, whole word or regex, then recomputes.
   *
   * @param {"caseSensitive" | "wholeWord" | "regex"} name
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleFindOption(name, cx) {
    if (!this.find || !["caseSensitive", "wholeWord", "regex"].includes(name)) return;
    this.find[name] = !this.find[name];
    this.find.current = -1;
    this.pendingFindLine = null;
    this.refreshFindMatches(cx, false);
    this.persistFindPrefs();
    this.focusFindInput(cx);
    cx.notify();
  }

  /**
   * The match options currently shown in the find bar.
   *
   * @returns {{ query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean }}
   */
  findOptions() {
    return {
      query: this.find?.query ?? "",
      caseSensitive: this.find?.caseSensitive === true,
      wholeWord: this.find?.wholeWord === true,
      regex: this.find?.regex === true,
    };
  }

  /**
   * Handles typing in the replace input. The replacement does not affect the
   * match set, so this only persists the value and repaints the bar.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleReplaceInputChange(cx) {
    if (!this.find) return;
    this.find.replace = this.replaceInput ? this.replaceInput.value() : "";
    this.persistFindPrefs();
    cx.notify();
  }

  /**
   * Expands or collapses the replace row and moves focus into it when opening.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleFindReplace(cx) {
    if (!this.find) return;
    this.find.replaceOpen = !this.find.replaceOpen;
    this.persistFindPrefs();
    if (this.find.replaceOpen) this.focusReplaceInput(cx);
    else this.focusFindInput(cx);
    cx.notify();
  }

  /**
   * Toggles preserve-case (AB) and persists it.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  togglePreserveCase(cx) {
    if (!this.find) return;
    this.find.preserveCase = !this.find.preserveCase;
    this.persistFindPrefs();
    this.focusReplaceInput(cx);
    cx.notify();
  }

  /**
   * Whether the replace row can edit the buffer: the file must have an editor
   * and must not be read-only.
   *
   * @returns {boolean}
   */
  canEditWithReplace() {
    return Boolean(this.find?.open && this.find?.replaceOpen && this.code && !this.isReadonly());
  }

  /**
   * Pushes the text before a replace operation onto the small in-memory undo
   * stack. `set_value` may reset the native undo history, so the find bar owns
   * this fallback while it is open.
   *
   * @param {{ text: string, current: number }} entry
   */
  pushFindUndo(entry) {
    if (!this.findUndo) this.findUndo = [];
    this.findUndo.push(entry);
    if (this.findUndo.length > 50) this.findUndo.shift();
  }

  /**
   * Writes replacement text into the editor buffer without touching disk.
   * Updates dirty state, line count and the cached tab state, and promotes a
   * preview tab exactly like a normal edit.
   *
   * @param {string} text
   */
  setEditorText(text) {
    if (!this.code) return;
    this.code.set_value(text);
    this.preparedText = text;
    const dirty = isContentDirty(text, this.rawText);
    if (dirty && !this.dirty) this.promotePreviewTab();
    this.dirty = dirty;
    this.lineCount = countLines(text);
    this.updateCachedTabState({ dirty, lineCount: this.lineCount, preparedText: text });
  }

  /**
   * Replaces the current match, then selects the next match at or after the
   * inserted replacement (wrapping when needed).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  replaceCurrentMatch(cx) {
    if (!this.canEditWithReplace() || !this.find?.matches?.length) return;
    const current = this.find.current;
    if (current < 0 || current >= this.find.matches.length) return;
    const now = Date.now();
    if (this.lastReplaceActionAt && now - this.lastReplaceActionAt < 80) return;
    this.lastReplaceActionAt = now;
    const before = this.findSourceText();
    const result = replaceSingleMatch(before, this.find.matches, current, this.find.replace ?? "", {
      ...this.findOptions(),
      preserveCase: this.find.preserveCase === true,
      cap: FIND_MATCH_CAP,
    });
    if (!result.replaced) return;
    this.pushFindUndo({ text: before, current });
    this.setEditorText(result.text);
    this.find.matches = result.matches;
    this.find.valid = result.valid;
    this.find.error = result.error;
    this.find.limited = result.limited;
    this.find.current = result.nextIndex;
    this.pendingFindLine = null;
    if (this.find.current >= 0) this.scrollToCurrentFindMatch(cx);
    this.persistFindPrefs();
    cx.notify();
  }

  /**
   * Replaces every match in the buffer. Zero matches is a no-op and never
   * marks the tab dirty.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  replaceAllInEditor(cx) {
    if (!this.canEditWithReplace()) return;
    const now = Date.now();
    if (this.lastReplaceActionAt && now - this.lastReplaceActionAt < 80) return;
    this.lastReplaceActionAt = now;
    const before = this.findSourceText();
    // The visible match list is capped at FIND_MATCH_CAP for rendering; a
    // Replace All must still cover every match in the buffer.
    const full = findMatches(before, this.find.query, {
      ...this.findOptions(),
      cap: Number.MAX_SAFE_INTEGER,
    });
    if (!full.valid || full.matches.length === 0) return;
    const next = applyReplacements(before, full.matches, this.find.replace ?? "", {
      ...this.findOptions(),
      preserveCase: this.find.preserveCase === true,
    });
    if (next === before) return;
    this.pushFindUndo({ text: before, current: this.find.current });
    this.setEditorText(next);
    this.refreshFindMatches(cx, false);
    this.persistFindPrefs();
    cx.notify();
  }

  /**
   * Restores the buffer before the last replace operation while find is open.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @returns {boolean} Whether an entry was restored.
   */
  undoFindReplace(cx) {
    if (!this.findUndo?.length || !this.code) return false;
    // This is only called from the widget's on_key_down after checking that
    // the stack is non-empty; with no binding, Cmd+Z propagates to the input
    // when there is nothing to undo.
    const entry = this.findUndo.pop();
    this.setEditorText(entry.text);
    this.refreshFindMatches(cx, false);
    this.find.current =
      entry.current >= 0 && entry.current < this.find.matches.length
        ? entry.current
        : this.find.matches.length > 0
          ? 0
          : -1;
    if (this.find.current >= 0) this.scrollToCurrentFindMatch(cx);
    this.persistFindPrefs();
    cx.notify();
    return true;
  }

  /**
   * Key handling while the find widget is open. Registered on the tab root and
   * on the widget so shortcuts still work when the input consumed the key.
   *
   * @param {import("gpui-kit").KeyEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleFindWidgetKeyDown(event, cx) {
    if (!this.find?.open) return false;
    const modifiers = event.modifiers || {};
    const command = Boolean(modifiers.platform || modifiers.control);
    const key = String(event.key ?? "").toLowerCase();
    const keystroke = String(event.keystroke ?? "").toLowerCase();

    if (key === "escape") {
      cx.stop_propagation();
      this.closeFind(cx);
      return true;
    }
    if (
      (modifiers.platform && modifiers.alt && key === "f") ||
      (modifiers.control && !modifiers.platform && !modifiers.alt && key === "h")
    ) {
      cx.stop_propagation();
      this.openFindReplace(cx);
      return true;
    }
    if (command && !modifiers.alt && key === "f") {
      cx.stop_propagation();
      this.focusFindInput(cx);
      return true;
    }
    if (command && !modifiers.shift && key === "z" && this.findUndo?.length) {
      cx.stop_propagation();
      this.undoFindReplace(cx);
      return true;
    }
    if (key === "enter" && this.find.replaceOpen) {
      const replaceAllChord = (modifiers.platform && !modifiers.shift) || (modifiers.control && modifiers.alt);
      if (replaceAllChord) {
        cx.stop_propagation();
        this.replaceAllInEditor(cx);
        return true;
      }
      if (this.findFocusTarget === "replace" && !modifiers.shift) {
        cx.stop_propagation();
        this.replaceCurrentMatch(cx);
        return true;
      }
    }
    if (command && modifiers.shift && (key === "1" || key === "!" || keystroke === "cmd-shift-1" || keystroke === "ctrl-shift-1")) {
      if (this.find.replaceOpen) {
        cx.stop_propagation();
        this.replaceCurrentMatch(cx);
        return true;
      }
    }
    if (modifiers.alt && !modifiers.platform && !modifiers.control) {
      const isC = key === "c" || key === "ç" || keystroke === "alt-c";
      const isW = key === "w" || key === "∑" || keystroke === "alt-w";
      const isR = key === "r" || key === "®" || keystroke === "alt-r";
      if (isC) {
        cx.stop_propagation();
        this.toggleFindOption("caseSensitive", cx);
        return true;
      }
      if (isW) {
        cx.stop_propagation();
        this.toggleFindOption("wholeWord", cx);
        return true;
      }
      if (isR) {
        cx.stop_propagation();
        this.toggleFindOption("regex", cx);
        return true;
      }
    }
    return false;
  }

  /* ========================================================================
   * Files Pane Mode Implementation
   * ======================================================================== */

  /**
   * Sets up state, location timers, and folder watcher for the Files pane mode.
   *
   * @param {Record<string, any>} _p
   * @param {import("gpui-kit").ViewContext} cx
   */
  initPaneMode(p, cx) {
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.selectedFile = null;
    this.hoveredPath = null;
    this.previewFiles = new Set();
    this.pendingFileOpen = null;
    this.contextMenu = null;
    this.pendingContextTarget = null;
    this.renameDialog = null;
    this.deleteDialog = null;
    this.renameInput = null;
    this.actionPending = false;
    this.filesFocusHandle = cx.focus_handle();
    this.loading = false;
    this.refreshPending = false;
    this.watched = null;
    this.watchToken = null;
    this.error = null;
    this.limited = false;

    // Collapsible sidebar sections and the workspace search state. Search
    // results live in memory; the actual scan runs off the UI thread in
    // executeSearch and is discarded when its token is stale.
    this.sections = normalizeSections(shared("file-editor.sections"));
    this.search = {
      query: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      include: "",
      exclude: "",
      filtersOpen: false,
      replace: "",
      replaceOpen: false,
      preserveCase: false,
      groups: [],
      totalMatches: 0,
      totalFiles: 0,
      limited: false,
      error: null,
      warning: null,
      valid: true,
      running: false,
      collapsedFiles: new Set(),
    };
    this.searchRows = [];
    this.searchToken = null;
    this.rgAvailable = null;
    this.rgContextKey = null;
    this.lastSearchClick = null;
    this.searchHoveredRow = null;
    this.searchDiffCacheKey = "";
    this.searchDiffCache = new Map();
    this.replaceDialog = null;
    this.replaceRunning = false;
    this.pendingSearchReplaceDialog = false;
    this.searchScrollY = 0;
    this.searchViewportHeight = 0;
    this.searchInput = InputState.new({ placeholder: "Search" });
    this.searchReplaceInput = InputState.new({ placeholder: "Replace" });
    this.includeInput = InputState.new({ placeholder: "files to include (e.g. src/**, *.js)" });
    this.excludeInput = InputState.new({ placeholder: "files to exclude (e.g. dist/**, *.lock)" });
    this.searchInput.on("change", (_event, eventCx) => this.handleSearchInputChange(eventCx));
    this.searchInput.on("submit", (_event, eventCx) => this.runSearchNow(eventCx));
    this.searchReplaceInput.on("change", (_event, eventCx) => this.handleSearchReplaceInputChange(eventCx));
    this.includeInput.on("change", (_event, eventCx) => this.handleSearchFilterChange(eventCx));
    this.excludeInput.on("change", (_event, eventCx) => this.handleSearchFilterChange(eventCx));

    // Optional deep link: `props().search` opens SEARCH with a prefilled query,
    // which is also how a saved or scripted search can land directly in results.
    const initialSearch = p?.search && typeof p.search === "object" ? p.search : null;
    if (initialSearch) {
      this.search.query = typeof initialSearch.query === "string" ? initialSearch.query : "";
      this.search.caseSensitive = initialSearch.caseSensitive === true;
      this.search.wholeWord = initialSearch.wholeWord === true;
      this.search.regex = initialSearch.regex === true;
      this.search.include = typeof initialSearch.include === "string" ? initialSearch.include : "";
      this.search.exclude = typeof initialSearch.exclude === "string" ? initialSearch.exclude : "";
      this.search.replace = typeof initialSearch.replace === "string" ? initialSearch.replace : "";
      this.search.replaceOpen =
        initialSearch.replaceOpen === true || this.search.replace.length > 0;
      this.search.preserveCase = initialSearch.preserveCase === true;
      // UI-only screenshot/automation hook: open the Replace All dialog for
      // the settled results without ever running a replacement.
      this.pendingSearchReplaceDialog = initialSearch.replaceDialog === true;
      this.search.filtersOpen = Boolean(this.search.include || this.search.exclude);
      this.searchInput.set_value(this.search.query);
      this.searchReplaceInput.set_value(this.search.replace);
      this.includeInput.set_value(this.search.include);
      this.excludeInput.set_value(this.search.exclude);
      this.sections.search = true;
      setShared("file-editor.sections", { ...this.sections });
    }

    // Sanitize any poisoned openTabs entries loaded from shared state
    const openTabsMap = shared("file-editor.openTabs");
    if (openTabsMap && typeof openTabsMap === "object") {
      let changed = false;
      const cleaned = {};
      for (const [k, v] of Object.entries(openTabsMap)) {
        if (v && v.file && v.tabName && !isTabMatchingFile(v.tabName, v.file, v.root)) {
          changed = true;
          continue;
        }
        cleaned[k] = v;
      }
      if (changed) {
        setShared("file-editor.openTabs", cleaned);
      }
    }

    this.refresh(cx);
    // Poll location every 250ms in memory so space switches reload immediately
    cx.timer.every(250, (cx) => this.checkLocation(cx));
    // Full folder and git status refresh every 10s
    cx.timer.every(10000, (cx) => this.refresh(cx));

    if (initialSearch && this.search.query.trim().length > 0) {
      cx.timer.after(350, (timerCx) => {
        if (!this.closed) this.runSearchNow(timerCx);
      });
    }
  }

  /**
   * Computes the current workspace location.
   *
   * @returns {{ cwd: string | null, on: string | null, space: string | null }}
   */
  getLocation() {
    return resolveLocationState({
      props: props(),
      spaces: spaces(),
      focused: focused(),
      panes: panes(),
      pinnedLocations: shared("spaces.pinned_locations"),
      previousCwd: this.root,
      previousSpace: this.context?.space,
    });
  }

  /**
   * Serializes current location for state cache comparison.
   *
   * @returns {string}
   */
  key() {
    return JSON.stringify(this.getLocation());
  }

  /**
   * Checks for location transitions and triggers refresh when active space or cwd shifts.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  checkLocation(cx) {
    if (this.key() !== this.context?.key) {
      this.refresh(cx);
    } else {
      this.syncActiveFileSelection(cx);
    }
  }

  /**
   * Applies active file selection and ensures all ancestor folders are expanded and loaded.
   *
   * @param {string} filePath
   * @param {import("gpui-kit").ViewContext} cx
   * @param {boolean} [triggerNotify=true]
   */
  applyActiveFileSelection(filePath, cx, triggerNotify = true) {
    const isNewSelection = this.selectedFile !== filePath;
    this.selectedFile = filePath;

    const ancestors = getAncestorFolders(filePath);
    let folderLoaded = false;
    for (const folder of ancestors) {
      if (!this.folders.has(folder)) {
        this.folders.add(folder);
        if (!this.entries.has(folder) && !this.pending.has(folder)) {
          const context = this.context;
          this.pending.add(folder);
          folderLoaded = true;
          cx.spawn(async (cx) => {
            try {
              await this.loadFolder(folder, context);
            } catch (e) {
              if (this.current(context)) this.error = String(e);
            } finally {
              if (this.context === context) this.pending.delete(folder);
              cx.notify();
            }
          });
        }
      }
    }

    if (isNewSelection && triggerNotify && !folderLoaded) {
      cx.notify();
    }
  }

  /**
   * Synchronizes active file selection with currently active or focused tab/pane.
   * Automatically expands and loads ancestor folders so the selected file is visible.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @param {boolean} [triggerNotify=true]
   */
  syncActiveFileSelection(cx, triggerNotify = true) {
    if (!this.root || this.closed) return;
    const activeOpenedFile = resolveActiveOpenedFile({
      spaces: spaces(),
      focused: focused(),
      panes: panes(),
      openTabs: shared("file-editor.openTabs"),
      activeFile: shared("file-editor.activeFile"),
      currentRoot: this.root,
      entries: this.entries,
      marks: this.marks,
    });

    if (activeOpenedFile) {
      this.applyActiveFileSelection(activeOpenedFile, cx, triggerNotify);
      return;
    }

    // If candidate tab name was not directly resolved, try looking it up via git ls-files
    const activeSpace = (spaces() || []).find((s) => s.active);
    const activeTab =
      activeSpace?.tabs?.find((t) => t.id === focused()?.tab) || activeSpace?.tabs?.find((t) => t.active);
    if (activeTab?.name) {
      const candidate = parseTabFileName(activeTab.name);
      if (candidate && !candidate.includes("/")) {
        if (this.fileLookupCache?.has(candidate)) {
          const cachedRel = this.fileLookupCache.get(candidate);
          if (cachedRel) {
            this.applyActiveFileSelection(cachedRel, cx, triggerNotify);
            return;
          }
        } else if (!this.fileLookupPending?.has(candidate)) {
          this.fileLookupPending = this.fileLookupPending || new Set();
          this.fileLookupCache = this.fileLookupCache || new Map();
          this.fileLookupPending.add(candidate);
          const context = this.context;
          cx.spawn(async (cx) => {
            try {
              const r = await exec("git", ["ls-files", "-co", "--exclude-standard", `*${candidate}`], {
                cwd: this.root,
                on: this.on,
              }).catch(() => null);
              if (r?.code === 0 && r.stdout) {
                const lines = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
                const matched = lines.find((l) => l.endsWith(`/${candidate}`) || l === candidate);
                if (matched && this.current(context)) {
                  this.fileLookupCache.set(candidate, matched);
                  this.applyActiveFileSelection(matched, cx, true);
                }
              }
            } finally {
              this.fileLookupPending?.delete(candidate);
            }
          });
        }
      }
    }
  }

  /**
   * Validates whether a background context is still the active one.
   *
   * @param {{ key: string }} context
   * @returns {boolean}
   */
  current(context) {
    return this.context === context && this.key() === context.key;
  }

  /**
   * Watches the current workspace folder for filesystem changes.
   * Uses watchToken to invalidate previous watchers when folder changes.
   *
   * @param {string} root
   * @param {import("gpui-kit").ViewContext} cx
   */
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const token = (this.watchToken = {});
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.watchToken === token && this.context === context && !this.closed) {
          await watchFolder(root);
          if (this.watchToken === token && this.current(context) && !this.closed) {
            this.refresh(cx);
          }
        }
      } catch {
        if (this.watchToken === token && this.context === context) {
          this.watched = null;
          this.watchToken = null;
        }
      }
    });
  }

  /**
   * Asynchronously lists entries for a subfolder.
   *
   * @param {string} path
   * @param {{ key: string, cwd: string, on: string | null }} context
   */
  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;

    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);

    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    );

    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) {
      this.limited = true;
    }
  }

  /**
   * Refreshes the directory tree and git status marks.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  refresh(cx) {
    const { cwd, on, space } = this.getLocation();
    const next = this.key();

    if (next !== this.context?.key) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, selectedFile: this.selectedFile });
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.selectedFile = saved?.selectedFile ?? null;
      this.hoveredPath = null;
      this.contextMenu = null;
      this.closeModals();
      this.watched = null;
      this.watchToken = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
      this.searchToken = null;
      this.search.running = false;
      this.search.groups = [];
      this.search.totalMatches = 0;
      this.search.totalFiles = 0;
      this.search.limited = false;
      this.search.error = null;
      this.search.warning = null;
      this.searchRows = [];
      if (this.search.query.trim().length > 0) this.scheduleSearch(cx);
    }

    if (!cwd || this.loading) {
      if (this.loading) this.refreshPending = true;
      return;
    }
    const context = this.context;
    this.loading = true;
    this.limited = false;

    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          if (path === "") {
            await this.loadFolder(path, context);
          } else {
            try {
              await this.loadFolder(path, context);
            } catch {
              for (const folder of [...this.folders]) {
                if (folder === path || folder.startsWith(path + "/")) {
                  this.folders.delete(folder);
                  this.entries.delete(folder);
                }
              }
            }
          }
        }

        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec(
            "git",
            ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
            { cwd, on }
          ).catch(() => null);

          if (status?.code === 0) {
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              const rel = entry.slice(3).trim();
              const val = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
              marks[rel] = val;
              marks[`${cwd}/${rel}`] = val;
              if (top?.stdout) {
                marks[`${top.stdout.trim()}/${rel}`] = val;
              }
            }
          }
        }

        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) {
          this.loading = false;
          cx.notify();
          if (this.refreshPending && !this.closed) {
            this.refreshPending = false;
            this.refresh(cx);
          }
        }
      }
    });
  }

  /**
   * Toggles folder expansion in the directory tree.
   *
   * @param {string} path
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  /**
   * Opens a file in its own Herdr tab, reusing an existing tab or creating a new one.
   *
   * A single click opens the file as a disposable preview tab. An explicit open
   * (double-clicking the file or its tab, or the context menu action) promotes
   * it to a permanent tab. Opening another preview replaces the previous
   * temporary tab in the same space, matching VS Code's preview tabs.
   *
   * @param {string} path
   * @param {import("gpui-kit").ViewContext} cx
   * @param {{ permanent?: boolean }} [options={}]
   */
  openFileTab(path, cx, options = {}) {
    const permanent = options?.permanent === true;
    const activeSpace = spaces().find((s) => s.active);
    const activeTabs = activeSpace?.tabs ?? [];
    const allTabs = (spaces() || []).flatMap((space) => space.tabs || []);
    const openTabsMap = shared("file-editor.openTabs") || {};
    const fileKey = toFileKey(this.root, path);

    // A search result can target an already-open tab, where props cannot
    // change. Leave a pending record that the mounted tab consumes.
    if (options?.find) {
      setShared("file-editor.pendingFind", {
        fileKey,
        find: options.find,
        timestamp: Date.now(),
      });
    }

    this.selectedFile = path;
    setShared("file-editor.activeFile", { root: this.root, file: path });

    // The two click events of a double-click arrive while the first tab is
    // still being created. Promote that pending preview instead of opening a
    // second tab.
    const pending = this.pendingFileOpen;
    if (shouldCoalescePendingOpen(pending, fileKey)) {
      if (permanent) {
        setShared("file-editor.openTabs", setOpenTabPreview(openTabsMap, fileKey, false));
      }
      cx.notify();
      return;
    }

    const editorTabIds = new Set(
      (panes() || []).filter((pane) => pane.mod === "file-editor").map((pane) => pane.tab)
    );
    const pinnedTabIds = shared("tabs.pinned") ?? [];

    // Plan the replacement before naming the new tab, so a preview that is
    // about to be closed does not force a disambiguated title (e.g.
    // dir/index.js instead of index.js).
    let tabsForNaming = activeTabs;
    if (!permanent) {
      const prePlan = planPreviewOpen(openTabsMap, activeTabs, this.root, fileKey, pinnedTabIds, editorTabIds);
      const closingIds = new Set([...prePlan.closeTabIds, ...prePlan.deferredCloseTabIds]);
      if (closingIds.size > 0) {
        tabsForNaming = activeTabs.filter((tab) => !closingIds.has(tab.id));
      }
    }

    const { existingTabId, tabName, updatedOpenTabs } = resolveFileTab(
      path,
      this.root,
      tabsForNaming,
      openTabsMap,
      allTabs,
      editorTabIds
    );

    const activeTab = activeTabs.find((t) => t.active);
    const allPanes = panes() || [];
    const currentTabPanes = activeTab ? allPanes.filter((p) => p.tab === activeTab.id) : [];
    const focusedPaneId = options?.pane || focused()?.pane;
    const targetEmptyPane = findTargetEmptyPane(currentTabPanes, focusedPaneId);

    const placement = planFilePlacement({
      currentTabPanes,
      targetEmptyPane,
      existingTabId,
      activeTabId: activeTab?.id,
      file: path,
      root: this.root,
    });

    if (placement.action === "focus-pane") {
      run("pane.focus", { pane: placement.paneId });
      cx.notify();
      return;
    }

    if (placement.action === "replace-pane") {
      const tabProps = { folder: this.root, file: path };
      if (this.on) tabProps.on = this.on;
      if (options?.find) tabProps.find = options.find;
      run("pane.split", {
        direction: "right",
        pane: placement.targetPaneId,
        mod: "file-editor",
        props: tabProps,
      });
      run("pane.close", { pane: placement.targetPaneId });

      const nextOpenTabs = {
        ...updatedOpenTabs,
        [fileKey]: mergeOpenTabEntry(updatedOpenTabs[fileKey], {
          root: this.root,
          file: path,
          tabName: activeTab?.name || tabName,
          tabId: placement.tabId,
          preview: false,
        }),
      };
      setShared("file-editor.openTabs", nextOpenTabs);
      cx.notify();
      return;
    }

    if (placement.action === "replace-tab") {
      const tabProps = { folder: this.root, file: path };
      if (this.on) tabProps.on = this.on;
      if (options?.find) tabProps.find = options.find;
      run("tab.new", { name: tabName, mod: "file-editor", props: tabProps });
      if (placement.closeTabId) {
        run("tab.close", { id: placement.closeTabId });
      }
      const nextOpenTabs = setOpenTabPreview(updatedOpenTabs, fileKey, !permanent);
      setShared("file-editor.openTabs", nextOpenTabs);
      this.pendingFileOpen = { fileKey, at: Date.now() };
      cx.timer?.after?.(650, () => {
        if (this.pendingFileOpen?.fileKey === fileKey) this.pendingFileOpen = null;
      });
      cx.notify();
      return;
    }

    if (placement.action === "select-tab") {
      const nextOpenTabs = permanent
        ? setOpenTabPreview(updatedOpenTabs, fileKey, false)
        : updatedOpenTabs;
      setShared("file-editor.openTabs", nextOpenTabs);
      run("tab.select", { id: placement.tabId });
      cx.notify();
      return;
    }

    let nextOpenTabs = { ...updatedOpenTabs };
    let closeTabIds = [];
    let deferredCloseTabIds = [];
    let replaceIndex = null;

    if (!permanent) {
      const plan = planPreviewOpen(
        updatedOpenTabs,
        activeTabs,
        this.root,
        fileKey,
        pinnedTabIds,
        editorTabIds
      );
      nextOpenTabs = plan.nextOpenTabs;
      closeTabIds = plan.closeTabIds;
      deferredCloseTabIds = plan.deferredCloseTabIds;
      replaceIndex = plan.replaceIndex;
      for (const tabId of closeTabIds) run("tab.close", { id: tabId });
    }

    nextOpenTabs = setOpenTabPreview(nextOpenTabs, fileKey, !permanent);
    setShared("file-editor.openTabs", nextOpenTabs);
    this.pendingFileOpen = { fileKey, at: Date.now() };

    const tabProps = { folder: this.root, file: path };
    if (this.on) tabProps.on = this.on;
    if (options?.find) tabProps.find = options.find;
    run("tab.new", { name: tabName, mod: "file-editor", props: tabProps });

    // The replacement now exists, so closing the old preview cannot take the
    // whole space with it.
    for (const tabId of deferredCloseTabIds) run("tab.close", { id: tabId });

    // Keep the coalescing window open long enough for a normal double-click
    // (the 60 ms timer below only records the new tab id and position).
    cx.timer?.after?.(650, () => {
      if (this.pendingFileOpen?.fileKey === fileKey) this.pendingFileOpen = null;
    });

    cx.timer?.after?.(60, () => {
      if (this.closed) return;
      const activeSp = (spaces() || []).find((s) => s.active);
      const activeTab = (activeSp?.tabs || []).find((t) => t.active);
      if (activeTab?.id && isTabMatchingFile(activeTab.name, path, this.root)) {
        const currentTabs = shared("file-editor.openTabs") || {};
        if (currentTabs[fileKey]) {
          setShared("file-editor.openTabs", {
            ...currentTabs,
            [fileKey]: {
              ...currentTabs[fileKey],
              tabId: activeTab.id,
              tabName: activeTab.name || tabName,
            },
          });
        }
        // Reuse the replaced preview's position instead of appending the new
        // tab at the end of the strip.
        if (replaceIndex !== null && typeof activeTab.index === "number") {
          const lastIndex = Math.max(1, activeSp?.tabs?.length ?? 1);
          const targetIndex = Math.max(1, Math.min(replaceIndex, lastIndex));
          if (activeTab.index !== targetIndex) {
            run("tab.move", { id: activeTab.id, index: targetIndex });
          }
        }
      }
    });

    cx.notify();
  }

  /**
   * Copies the absolute filesystem path of a file or directory to the clipboard.
   *
   * @param {string} path
   * @param {boolean} isDir
   * @param {import("gpui-kit").ViewContext} cx
   */
  copyPathToClipboard(path, isDir, cx) {
    const absPath = resolveAbsolutePath(this.root, path);
    cx.write_to_clipboard(absPath);
    notify({
      title: isDir ? "Folder path copied" : "File path copied",
      body: absPath,
      level: "success",
      timeout: 1500,
    });
  }

  /**
   * Plans the right-click menu for a file tree row. The pane root's bubbled
   * press opens it, where `local_position` is already relative to the pane.
   *
   * @param {{ name: string, dir: boolean }} entry
   * @param {string} path
   */
  rememberRowContextTarget(entry, path) {
    this.pendingContextTarget = { path, dir: entry.dir };
  }

  /**
   * Opens the right-click menu at the pane-relative press position.
   *
   * @param {import("gpui-kit").MouseButtonEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  openRowContextMenu(event, cx) {
    const target = this.pendingContextTarget;
    this.pendingContextTarget = null;
    if (!target) return;

    const { x, y } = resolveFilesMenuPosition({
      event,
      localPosition: event?.local_position,
      bounds: event?.bounds,
      zoom: Number(settings()?.zoom) || 1,
      menuWidth: 180,
      menuHeight: target.dir ? 88 : 114,
    });
    this.contextMenu = { path: target.path, dir: target.dir, x, y };
    cx.notify();
  }

  /**
   * Closes the file tree right-click menu.
   *
   * @param {import("gpui-kit").ViewContext} [cx]
   */
  closeRowContextMenu(cx) {
    if (!this.contextMenu) return;
    this.contextMenu = null;
    if (cx) cx.notify();
  }

  /**
   * Opens the rename modal dialog for a given path.
   *
   * @param {string} path
   * @param {boolean} isDir
   * @param {import("gpui-kit").ViewContext} cx
   */
  openRenameDialog(path, isDir, cx) {
    this.closeRowContextMenu();
    const { base, dir } = splitPathInfo(path);
    this.deleteDialog = null;
    this.renameDialog = {
      path,
      isDir,
      oldName: base,
      dir,
      error: null,
    };
    if (this.renameInput) {
      try {
        this.renameInput.release();
      } catch {}
    }
    this.renameInput = InputState.new({ placeholder: "New name", value: base });
    this.renameInput.on("submit", (_e, cx) => this.submitRename(cx));
    this.renameInput.on("change", () => cx.notify());
    this.renameInput.focus();
    cx.timer?.after?.(50, () => this.renameInput?.focus());
    cx.notify();
  }

  /**
   * Submits the rename operation.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  submitRename(cx) {
    const dialog = this.renameDialog;
    if (!dialog || this.actionPending) return;

    const rawNewName = this.renameInput ? this.renameInput.value() : "";
    const newName = rawNewName.trim();
    const isDir = Boolean(dialog.isDir);

    const validation = validateEntryName(newName, dialog.oldName, isDir);
    if (!validation.valid) {
      dialog.error = validation.error;
      cx.notify();
      return;
    }

    const resolvedName = resolveRenamedName(newName, dialog.oldName, isDir);
    const parentFolder = dialog.dir || "";
    const siblings = this.entries.get(parentFolder) ?? [];
    if (siblings.some((e) => e.name === resolvedName)) {
      dialog.error = `An item named "${resolvedName}" already exists`;
      cx.notify();
      return;
    }

    const newPath = getRenamedPath(dialog.path, newName, isDir);
    const root = this.root;
    const on = this.on;
    const oldPath = dialog.path;

    this.actionPending = true;
    dialog.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await renamePath(root, oldPath, newPath, on);

        setShared("file-editor.renamedFile", {
          root,
          oldPath,
          newPath,
          timestamp: Date.now(),
        });

        if (this.selectedFile === oldPath) {
          this.selectedFile = newPath;
          setShared("file-editor.activeFile", { root, file: newPath });
        }

        const openTabs = shared("file-editor.openTabs");
        if (openTabs && typeof openTabs === "object") {
          const oldKey = root ? `${root}/${oldPath}` : oldPath;
          const newKey = root ? `${root}/${newPath}` : newPath;
          if (openTabs[oldKey]) {
            const entry = openTabs[oldKey];
            delete openTabs[oldKey];
            openTabs[newKey] = { ...entry, file: newPath, tabName: resolvedName };
            setShared("file-editor.openTabs", openTabs);
            if (entry.tabId) {
              try {
                run("tab.rename", { id: entry.tabId, name: resolvedName });
              } catch {}
            }
          }
        }

        if (isDir) {
          this.folders = remapRenamedFolderSet(this.folders, oldPath, newPath);
          this.entries = remapRenamedFolderEntries(this.entries, oldPath, newPath);
        }

        remapRenamedFileStates(fileTabStates, oldPath, newPath, root);
        const oldDirtyKey = toFileKey(root, oldPath);
        const newDirtyKey = toFileKey(root, newPath);
        if (dirtyFileKeys.delete(oldDirtyKey)) dirtyFileKeys.add(newDirtyKey);

        if (this.context) {
          await this.loadFolder(parentFolder, this.context);
        }

        this.closeModals(cx);
        notify({
          title: isDir ? "Folder renamed" : "File renamed",
          body: `${dialog.oldName} → ${resolvedName}`,
          level: "success",
          timeout: 2000,
        });
      } catch (err) {
        if (this.renameDialog) {
          this.renameDialog.error = err?.message || String(err) || "Failed to rename";
        }
      } finally {
        this.actionPending = false;
        cx.notify();
      }
    });
  }

  /**
   * Opens the delete confirmation dialog for a given path.
   *
   * @param {string} path
   * @param {boolean} isDir
   * @param {import("gpui-kit").ViewContext} cx
   */
  openDeleteDialog(path, isDir, cx) {
    this.closeRowContextMenu();
    const { base, dir } = splitPathInfo(path);
    this.renameDialog = null;
    this.deleteDialog = {
      path,
      isDir,
      name: base,
      dir,
      error: null,
    };
    cx.notify();
  }

  /**
   * Submits the delete operation.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  submitDelete(cx) {
    const dialog = this.deleteDialog;
    if (!dialog || this.actionPending) return;

    const root = this.root;
    const on = this.on;
    const isDir = dialog.isDir;
    const path = dialog.path;
    const parentFolder = dialog.dir || "";

    this.actionPending = true;
    dialog.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await deletePath(root, path, isDir, on);

        if (this.selectedFile === path || (isDir && this.selectedFile?.startsWith(path + "/"))) {
          this.selectedFile = null;
        }

        const openTabs = shared("file-editor.openTabs");
        if (openTabs && typeof openTabs === "object") {
          const oldKey = root ? `${root}/${path}` : path;
          if (openTabs[oldKey]) {
            const entry = openTabs[oldKey];
            delete openTabs[oldKey];
            setShared("file-editor.openTabs", openTabs);
            if (entry.tabId) {
              try {
                run("tab.close", { id: entry.tabId });
              } catch {}
            }
          }
        }

        if (isDir) {
          this.folders = removeDeletedFolderSet(this.folders, path);
          this.entries = removeDeletedFolderEntries(this.entries, path);
        }

        const removedEntries = removeDeletedFileStates(fileTabStates, path, root);
        for (const { entry } of removedEntries) {
          entry.code?.release();
        }
        const deletedKey = toFileKey(root, path);
        for (const key of Array.from(dirtyFileKeys)) {
          if (key === deletedKey || key.startsWith(`${deletedKey}/`)) dirtyFileKeys.delete(key);
        }

        if (this.context) {
          await this.loadFolder(parentFolder, this.context);
        }

        this.closeModals(cx);
        notify({
          title: isDir ? "Folder deleted" : "File deleted",
          body: dialog.name,
          level: "info",
          timeout: 2000,
        });
      } catch (err) {
        if (this.deleteDialog) {
          this.deleteDialog.error = err?.message || String(err) || "Failed to delete";
        }
      } finally {
        this.actionPending = false;
        cx.notify();
      }
    });
  }

  /**
   * Closes active modal dialogs (rename/delete) and releases input states.
   *
   * @param {import("gpui-kit").ViewContext} [cx]
   */
  closeModals(cx) {
    if (this.renameInput) {
      try {
        this.renameInput.release();
      } catch {}
      this.renameInput = null;
    }
    this.renameDialog = null;
    this.deleteDialog = null;
    this.replaceDialog = null;
    if (cx) cx.notify();
  }

  /**
   * Keyboard handler for Files pane mode.
   *
   * @param {import("gpui-kit").KeyboardEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleFilesKeyDown(event, cx) {
    if (this.renameDialog) {
      if (event.key === "escape") {
        cx.stop_propagation();
        this.closeModals(cx);
      }
      return;
    }
    if (this.deleteDialog) {
      if (event.key === "escape") {
        cx.stop_propagation();
        this.closeModals(cx);
      } else if (event.key === "enter") {
        cx.stop_propagation();
        this.submitDelete(cx);
      }
      return;
    }
    if (this.replaceDialog) {
      if (event.key === "escape") {
        cx.stop_propagation();
        this.closeModals(cx);
      } else if (event.key === "enter") {
        cx.stop_propagation();
        this.submitReplaceAllFiles(cx);
      }
      return;
    }
    if (this.contextMenu) {
      if (event.key === "escape") {
        cx.stop_propagation();
        this.closeRowContextMenu(cx);
      }
      return;
    }

    const commandOrControl = Boolean(event.modifiers?.platform || event.modifiers?.control);
    const key = String(event.key ?? "").toLowerCase();
    const isSearchShortcut =
      event.keystroke === "cmd-shift-f" ||
      event.keystroke === "ctrl-shift-f" ||
      (commandOrControl && Boolean(event.modifiers?.shift) && (key === "f" || key === "F"));

    if (isSearchShortcut && !event.is_held) {
      cx.stop_propagation();
      this.focusSearch(cx);
      return;
    }

    const isReplaceAllShortcut =
      event.keystroke === "cmd-shift-1" ||
      event.keystroke === "ctrl-shift-1" ||
      (commandOrControl && Boolean(event.modifiers?.shift) && (key === "1" || key === "!"));
    if (isReplaceAllShortcut && !event.is_held && this.search.replaceOpen === true) {
      cx.stop_propagation();
      this.replaceAllInFiles(cx);
    }
  }

  /**
   * Expands the SEARCH section and moves the keyboard into its query input.
   * Used by Cmd/Ctrl+Shift+F and by the search icon in the EXPLORER header.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  focusSearch(cx) {
    if (this.closed) return;
    if (!this.sections.search) {
      this.sections.search = true;
      setShared("file-editor.sections", { ...this.sections });
    }
    const attempt = () => {
      if (this.closed || !this.sections.search) return;
      this.searchInput?.focus();
    };
    attempt();
    cx.timer.after(30, attempt);
    cx.timer.after(120, attempt);
    cx.notify();
  }

  /**
   * Toggles one sidebar section and persists both.
   *
   * @param {"explorer" | "search"} name
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleSection(name, cx) {
    if (!this.sections || (name !== "explorer" && name !== "search")) return;
    this.sections[name] = !this.sections[name];
    setShared("file-editor.sections", { ...this.sections });
    cx.notify();
  }

  /**
   * Handles typing in the search query and schedules a debounced scan.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleSearchInputChange(cx) {
    this.search.query = this.searchInput ? this.searchInput.value() : "";
    this.scheduleSearch(cx);
  }

  /**
   * Handles typing in the include/exclude fields and schedules a rescan.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleSearchFilterChange(cx) {
    this.search.include = this.includeInput ? this.includeInput.value() : "";
    this.search.exclude = this.excludeInput ? this.excludeInput.value() : "";
    this.scheduleSearch(cx);
  }

  /**
   * Toggles a search match option and rescans.
   *
   * @param {"caseSensitive" | "wholeWord" | "regex"} name
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleSearchOption(name, cx) {
    if (!["caseSensitive", "wholeWord", "regex"].includes(name)) return;
    this.search[name] = !this.search[name];
    this.scheduleSearch(cx);
    cx.timer.after(40, () => {
      if (!this.closed) this.searchInput?.focus();
    });
  }

  /**
   * Shows or hides the include/exclude fields.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleSearchFilters(cx) {
    this.search.filtersOpen = !this.search.filtersOpen;
    cx.notify();
  }

  /**
   * Handles typing in the SEARCH replace input. It only repaints the inline
   * diff preview; the query itself does not change.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleSearchReplaceInputChange(cx) {
    this.search.replace = this.searchReplaceInput ? this.searchReplaceInput.value() : "";
    cx.notify();
  }

  /**
   * Shows or hides the SEARCH replace row.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleSearchReplace(cx) {
    this.search.replaceOpen = !this.search.replaceOpen;
    const attempt = () => {
      if (this.closed) return;
      if (this.search.replaceOpen) this.searchReplaceInput?.focus();
      else this.searchInput?.focus();
    };
    attempt();
    cx.timer.after(40, attempt);
    cx.notify();
  }

  /**
   * Toggles preserve-case for Replace All in files.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  toggleSearchPreserveCase(cx) {
    this.search.preserveCase = !this.search.preserveCase;
    cx.notify();
  }

  /**
   * The match options used by the current SEARCH query.
   *
   * @returns {{ query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean }}
   */
  searchFindOptions() {
    return {
      query: this.search.query,
      caseSensitive: this.search.caseSensitive === true,
      wholeWord: this.search.wholeWord === true,
      regex: this.search.regex === true,
    };
  }

  /**
   * The inline strike/insert diff for one SEARCH result row, or null when the
   * replace row is collapsed or the query is invalid.
   *
   * @param {{ file: string }} group
   * @param {{ line: number, column: number, length: number, text: string }} match
   * @param {number} [visibleLength] Clamped match length from the row's context trim.
   * @returns {Array<{ kind: "removed" | "inserted", text: string }> | null}
   */
  searchRowDiff(group, match, visibleLength = match.length) {
    if (this.search.replaceOpen !== true || this.search.valid === false) return null;
    const cacheKey = JSON.stringify([
      this.search.query,
      this.search.caseSensitive,
      this.search.wholeWord,
      this.search.regex,
      this.search.replace,
      this.search.preserveCase,
    ]);
    if (this.searchDiffCacheKey !== cacheKey) {
      this.searchDiffCacheKey = cacheKey;
      this.searchDiffCache.clear();
    }
    const shownLength = Math.max(0, Math.min(match.length, visibleLength));
    const rowKey = `${group.file}\u0000${match.line}\u0000${match.column}\u0000${shownLength}\u0000${match.text}`;
    if (this.searchDiffCache.has(rowKey)) return this.searchDiffCache.get(rowKey);
    const removed = match.text.slice(match.column, match.column + shownLength);
    const inserted = expandSearchReplacement(
      match.text,
      this.search.query,
      this.searchFindOptions(),
      match,
      this.search.replace ?? "",
      { preserveCase: this.search.preserveCase === true }
    );
    const diff = replacementDiffSegments(removed, inserted);
    this.searchDiffCache.set(rowKey, diff);
    return diff;
  }

  /**
   * Tracks which SEARCH row is hovered so its Replace/Dismiss actions show.
   *
   * @param {string} key
   * @param {boolean} hovered
   * @param {import("gpui-kit").ViewContext} cx
   */
  setSearchHoveredRow(key, hovered, cx) {
    // Hover actions only exist while the replace row is open. Skipping the
    // state change otherwise avoids re-rendering a large result list.
    if (this.search.replaceOpen !== true) return;
    if (hovered) {
      if (this.searchHoveredRow === key) return;
      this.searchHoveredRow = key;
    } else if (this.searchHoveredRow === key) {
      this.searchHoveredRow = null;
    } else {
      return;
    }
    cx.notify();
  }

  /**
   * Clamps the manual SEARCH scroll offset to the current row count.
   */
  clampSearchScroll() {
    const viewport = this.searchViewportHeight || 240;
    const maxScroll = Math.max(0, (this.searchRows?.length ?? 0) * SEARCH_ROW_HEIGHT - viewport);
    this.searchScrollY = Math.max(0, Math.min(maxScroll, this.searchScrollY || 0));
  }

  /**
   * Records the measured height of the SEARCH results viewport. The windowed
   * list uses it to decide how many rows to render.
   *
   * @param {{ width?: number, height?: number }} size
   * @param {import("gpui-kit").ViewContext} cx
   */
  updateSearchViewport(size, cx) {
    const height = Math.max(0, Math.round(Number(size?.height) || 0));
    if (height === this.searchViewportHeight) return;
    this.searchViewportHeight = height;
    this.clampSearchScroll();
    cx.notify();
  }

  /**
   * Scrolls the manual SEARCH result window. The list is not a virtual list
   * because GPUI forbids handlers inside a virtual-list renderer; instead it
   * owns the offset and renders the visible rows plus overscan.
   *
   * @param {import("gpui-kit").ScrollWheelEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleSearchWheel(event, cx) {
    const delta =
      event.delta?.y !== 0 && event.delta?.y !== undefined
        ? event.delta.y
        : event.delta_lines?.y
          ? event.delta_lines.y * SEARCH_ROW_HEIGHT
          : 0;
    if (delta === 0) return;
    const viewport = this.searchViewportHeight || 240;
    const maxScroll = Math.max(0, (this.searchRows?.length ?? 0) * SEARCH_ROW_HEIGHT - viewport);
    const next = Math.max(0, Math.min(maxScroll, (this.searchScrollY || 0) - delta));
    if (next !== this.searchScrollY) {
      this.searchScrollY = next;
      this.searchHoveredRow = null;
      cx.notify();
    }
  }

  /**
   * Rebuilds totals and the flat row list after a dismissal.
   */
  recomputeSearchResults() {
    this.search.groups = this.search.groups.filter((group) => group.count > 0);
    this.search.totalMatches = this.search.groups.reduce((sum, group) => sum + group.count, 0);
    this.search.totalFiles = this.search.groups.length;
    this.searchRows = flattenSearchRows(this.search.groups, this.search.collapsedFiles);
    this.searchHoveredRow = null;
    this.searchDiffCache.clear();
    this.clampSearchScroll();
  }

  /**
   * Removes one match row from the in-memory results.
   *
   * @param {Record<string, any>} group
   * @param {Record<string, any>} match
   * @param {import("gpui-kit").ViewContext} cx
   */
  dismissSearchMatch(group, match, cx) {
    const target = this.search.groups.find((candidate) => candidate.file === group.file);
    if (!target) return;
    const index = target.matches.indexOf(match);
    if (index < 0) return;
    target.matches.splice(index, 1);
    target.count = target.matches.length;
    this.recomputeSearchResults();
    cx.notify();
  }

  /**
   * Removes a whole file group from the in-memory results.
   *
   * @param {Record<string, any>} group
   * @param {import("gpui-kit").ViewContext} cx
   */
  dismissSearchGroup(group, cx) {
    this.search.groups = this.search.groups.filter((candidate) => candidate !== group);
    this.recomputeSearchResults();
    cx.notify();
  }

  /**
   * Whether a file has unsaved edits in any editor state source.
   *
   * A closed tab can still be restored from the bounded cache with its dirty
   * buffer, so checking live `openTabs` alone is not enough. The live dirty
   * set, the in-memory cache and the sessionStorage state are all consulted.
   * Keys are normalized with `toFileKey`, the same function open tabs use.
   *
   * @param {string} file
   * @returns {boolean}
   */
  isFileDirtyInEditor(file) {
    const key = toFileKey(this.root, file);
    return isDirtyFileState({
      key,
      dirtyKeys: dirtyFileKeys,
      cached: fileTabStates.get(key),
      persisted: loadPersistedTabState(key),
    });
  }

  /**
   * Replaces every match in one file without a confirmation dialog.
   *
   * @param {Record<string, any>} group
   * @param {import("gpui-kit").ViewContext} cx
   */
  replaceAllInFile(group, cx) {
    if (this.search.replaceOpen !== true) return;
    this.runFileReplacements(
      collectReplaceTargets([group]),
      { preserveCase: this.search.preserveCase === true },
      cx
    );
  }

  /**
   * Replaces one match without a confirmation dialog.
   *
   * @param {Record<string, any>} group
   * @param {Record<string, any>} match
   * @param {import("gpui-kit").ViewContext} cx
   */
  replaceOneSearchMatch(group, match, cx) {
    if (this.search.replaceOpen !== true) return;
    this.runFileReplacements(
      collectReplaceTargets([{ ...group, matches: [match] }]),
      { preserveCase: this.search.preserveCase === true },
      cx
    );
  }

  /**
   * Replace All in files. Always asks first, even for one match or one file,
   * like VS Code's search view. The per-row Replace and per-file Replace All
   * hover actions skip the dialog.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  replaceAllInFiles(cx) {
    this.openReplaceAllDialog(cx);
  }

  /**
   * Opens the Replace All confirmation dialog for the current results without
   * writing anything. The dialog's Replace button calls `submitReplaceAllFiles`.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  openReplaceAllDialog(cx) {
    if (this.closed || this.replaceRunning || this.replaceDialog) return;
    if (this.search.replaceOpen !== true) return;
    if (this.sections.search !== true) return;
    if (this.search.valid === false || this.search.running === true) return;
    if (this.search.query.trim().length === 0) return;
    const targets = collectReplaceTargets(this.search.groups);
    const totalMatches = targets.reduce((sum, group) => sum + group.matches.length, 0);
    const totalFiles = targets.length;
    if (totalMatches === 0) return;
    this.replaceDialog = {
      count: totalMatches,
      files: totalFiles,
      query: this.search.query,
      options: this.searchFindOptions(),
      replacement: this.search.replace ?? "",
      preserveCase: this.search.preserveCase === true,
      targets,
      error: null,
    };
    cx.notify();
  }

  /**
   * Confirms the Replace All dialog and starts the run.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  submitReplaceAllFiles(cx) {
    const dialog = this.replaceDialog;
    if (!dialog || this.replaceRunning) return;
    this.replaceDialog = null;
    this.runFileReplacements(
      dialog.targets,
      {
        preserveCase: dialog.preserveCase,
        query: dialog.query,
        options: dialog.options,
        replacement: dialog.replacement,
      },
      cx
    );
  }

  /**
   * Safely replaces targets across files.
   *
   * For each file it re-reads the current disk text, recomputes matches with
   * the same query options, and applies only targets that still match at the
   * same line/column/length. A file with unsaved edits in an open editor tab,
   * or one that changed on disk, is skipped. Writes preserve line endings and
   * the trailing newline because untouched text is never rebuilt.
   *
   * @param {Array<{ file: string, matches: Array<{ line: number, column: number, length: number, text: string }> }>} targets
   * @param {{
   *   preserveCase?: boolean,
   *   query?: string,
   *   options?: { caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean },
   *   replacement?: string,
   * }} [options]
   * @param {import("gpui-kit").ViewContext} cx
   */
  runFileReplacements(targets, options, cx) {
    if (this.closed || this.replaceRunning) return;
    const context = this.context;
    if (!context?.cwd || !Array.isArray(targets) || targets.length === 0) return;
    const root = context.cwd;
    const on = context.on;
    const query = options?.query ?? this.search.query;
    const matchOptions = options?.options ?? this.searchFindOptions();
    const replacement = options?.replacement ?? this.search.replace ?? "";
    const preserveCase = options?.preserveCase === true;
    this.replaceRunning = true;
    cx.notify();

    cx.spawn(async (asyncCx) => {
      let replacedCount = 0;
      let replacedFiles = 0;
      const skippedFiles = [];

      for (const target of targets) {
        if (this.closed) break;
        const fullPath = root ? `${root}/${target.file}` : target.file;
        if (this.isFileDirtyInEditor(target.file)) {
          skippedFiles.push({ file: target.file, reason: "unsaved edits" });
          continue;
        }
        try {
          const byteSize = await fileByteSize(fullPath, on);
          if (byteSize === null) {
            skippedFiles.push({ file: target.file, reason: "size check failed" });
            continue;
          }
          if (byteSize >= REPLACE_MAX_BYTES) {
            skippedFiles.push({ file: target.file, reason: "too large" });
            continue;
          }
          const current = await readTextFile(fullPath, { on });
          if (typeof current !== "string") {
            skippedFiles.push({ file: target.file, reason: "unreadable" });
            continue;
          }
          const safety = classifyReplacementRead({ byteSize, text: current });
          if (!safety.ok) {
            skippedFiles.push({ file: target.file, reason: safety.reason });
            continue;
          }
          // A file that grew between the size check and the read could have
          // been truncated by readTextFile's 1 MiB cap.
          if (typeof Buffer !== "undefined") {
            const readBytes = Buffer.byteLength(current, "utf8");
            if (readBytes !== byteSize) {
              skippedFiles.push({ file: target.file, reason: "changed on disk" });
              continue;
            }
          }
          // Re-check after the await: a tab may have become dirty while the
          // fresh read was in flight.
          if (this.isFileDirtyInEditor(target.file)) {
            skippedFiles.push({ file: target.file, reason: "unsaved edits" });
            continue;
          }
          const plan = planFileReplacements(
            current,
            query,
            matchOptions,
            target.matches,
            replacement,
            { preserveCase }
          );
          if (!plan.ok) {
            skippedFiles.push({
              file: target.file,
              reason: plan.reason === "changed" ? "changed on disk" : "unreadable",
            });
            continue;
          }
          if (on) {
            await writeRemoteTextFile(fullPath, plan.text, on, current);
          } else {
            await writeTextFile(fullPath, plan.text, current);
          }
          replacedCount += plan.count;
          replacedFiles += 1;
        } catch {
          skippedFiles.push({ file: target.file, reason: "write failed" });
        }
      }

      const skipped = skippedFiles.length;
      const skippedDetail =
        skipped > 0
          ? skippedFiles
              .slice(0, 3)
              .map((item) => `${item.file} (${item.reason})`)
              .join(", ") + (skipped > 3 ? "…" : "")
          : "";
      const skippedNames = skipped > 0 ? ` (${skippedDetail})` : "";
      const skippedLabel = skipped > 0 ? ` (${skipped} skipped: ${skippedDetail})` : "";
      this.replaceRunning = false;
      if (this.closed) return;
      if (replacedCount > 0) {
        notify({
          title: "Replaced",
          body: `${replacedCount} occurrence${replacedCount === 1 ? "" : "s"} in ${replacedFiles} file${
            replacedFiles === 1 ? "" : "s"
          }${skippedLabel}`,
          level: "success",
          timeout: 3000,
        });
      } else if (skipped > 0) {
        notify({
          title: "Nothing replaced",
          body: `${skipped} file${skipped === 1 ? "" : "s"} skipped${skippedNames}`,
          level: "warning",
          timeout: 3500,
        });
      }
      if (!this.closed) {
        this.runSearchNow(asyncCx);
        asyncCx.notify();
      }
    });
  }

  /**
   * Clears results while keeping the current query.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  clearSearchResults(cx) {
    this.search.groups = [];
    this.search.totalMatches = 0;
    this.search.totalFiles = 0;
    this.search.limited = false;
    this.search.error = null;
    this.search.warning = null;
    this.search.valid = true;
    this.search.running = false;
    this.searchRows = [];
    this.searchHoveredRow = null;
    this.searchDiffCache.clear();
    this.searchScrollY = 0;
    cx.notify();
  }

  /**
   * Schedules a debounced (~300 ms) search. Every keystroke replaces the token,
   * so a slower earlier scan cannot overwrite the result of a newer query.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  scheduleSearch(cx) {
    if (this.closed) return;
    const token = (this.searchToken = {});
    const query = this.search.query;
    if (query.trim().length === 0) {
      this.clearSearchResults(cx);
      return;
    }
    const built = buildFindRegExp(query, {
      caseSensitive: this.search.caseSensitive,
      wholeWord: this.search.wholeWord,
      regex: this.search.regex,
    });
    this.search.valid = built.valid;
    this.search.error = built.valid ? null : built.error;
    this.search.warning = null;
    this.search.running = built.valid;
    cx.notify();
    cx.timer.after(300, (timerCx) => {
      if (this.closed || this.searchToken !== token) return;
      this.executeSearch(timerCx, token);
    });
  }

  /**
   * Runs the current search immediately, bypassing the debounce (Enter).
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  runSearchNow(cx) {
    if (this.closed) return;
    const query = this.search.query;
    if (query.trim().length === 0) {
      this.clearSearchResults(cx);
      return;
    }
    const token = (this.searchToken = {});
    this.executeSearch(cx, token);
  }

  /**
   * Executes the workspace search off the UI thread. Uses `rg --json` when
   * ripgrep is available (which also honours .gitignore), and falls back to
   * `grep -rn` plus a JavaScript re-match pass when it is not.
   *
   * @param {import("gpui-kit").AsyncContext} cx
   * @param {object} token Stale-search token.
   */
  executeSearch(cx, token) {
    const context = this.context;
    if (!context || !context.cwd) {
      this.search.running = false;
      cx.notify();
      return;
    }
    const query = this.search.query;
    const options = {
      caseSensitive: this.search.caseSensitive,
      wholeWord: this.search.wholeWord,
      regex: this.search.regex,
    };
    const built = buildFindRegExp(query, options);
    if (!built.valid) {
      this.search.valid = false;
      this.search.error = built.error;
      this.search.running = false;
      this.search.groups = [];
      this.search.totalMatches = 0;
      this.search.totalFiles = 0;
      this.search.limited = false;
      this.search.warning = null;
      this.searchRows = [];
      this.searchHoveredRow = null;
      cx.notify();
      return;
    }
    this.search.valid = true;
    this.search.error = null;
    this.search.running = true;
    cx.notify();

    const include = parseGlobList(this.search.include);
    const exclude = parseGlobList(this.search.exclude);
    const stale = () => {
      if (this.closed || this.searchToken !== token) return true;
      if (!this.current(context)) {
        this.search.running = false;
        cx.notify();
        return true;
      }
      return false;
    };

    cx.spawn(async (asyncCx) => {
      try {
        const hasRg = await this.detectRipgrep(context);
        if (stale()) return;

        let rows = [];
        let limited = false;
        let error = null;
        let warning = null;

        if (hasRg) {
          const args = buildRipgrepArgs({ query, ...options, include, exclude });
          const result = await exec("rg", args, {
            cwd: context.cwd,
            on: context.on,
            timeout: 20000,
          }).catch((err) => ({
            code: -1,
            stdout: "",
            stderr: err?.message || String(err),
          }));
          if (stale()) return;
          const parsed = parseRgJson(result.stdout, {
            maxMatches: SEARCH_MATCH_CAP,
            maxFiles: SEARCH_FILE_CAP,
          });
          rows = filterSearchRowsByGlobs(parsed.rows, { include, exclude });
          limited = parsed.limited;
          const outcome = classifySearchResult(result.code, rows.length, result.stderr, options.regex);
          warning = outcome.warning;
          error = outcome.error;
        } else {
          const args = buildGrepArgs({ query, ...options, include, exclude });
          const result = await exec("grep", args, {
            cwd: context.cwd,
            on: context.on,
            timeout: 20000,
          }).catch((err) => ({
            code: -1,
            stdout: "",
            stderr: err?.message || String(err),
          }));
          if (stale()) return;
          const parsed = parseGrepOutput(result.stdout);
          // Filter globs before the 2,000-match cap: otherwise include *.md
          // can spend the whole budget on files it later discards.
          const filtered = filterSearchRowsByGlobs(parsed.rows, { include, exclude });
          const expanded = expandGrepRows(filtered, query, { ...options, cap: SEARCH_MATCH_CAP });
          rows = expanded.rows;
          limited = expanded.limited;
          if (!expanded.valid) {
            error = formatSearchError(expanded.error, options.regex) || expanded.error;
          } else {
            const outcome = classifySearchResult(result.code, rows.length, result.stderr, options.regex);
            warning = outcome.warning;
            error = outcome.error;
          }
        }

        if (stale()) return;

        const grouped = groupSearchRows(rows, { maxMatches: SEARCH_MATCH_CAP, maxFiles: SEARCH_FILE_CAP });
        this.search.groups = grouped.groups;
        this.search.totalMatches = grouped.totalMatches;
        this.search.totalFiles = grouped.totalFiles;
        this.search.limited = limited || grouped.limited;
        this.search.error = error;
        this.search.warning = warning;
        this.search.running = false;
        this.searchRows = flattenSearchRows(grouped.groups, this.search.collapsedFiles);
        this.searchHoveredRow = null;
        this.searchDiffCache.clear();
        this.searchScrollY = 0;
        asyncCx.notify();
        // UI-only hook: `search.replaceDialog: true` opens the confirmation
        // dialog for the settled results. It never runs a replacement.
        if (this.pendingSearchReplaceDialog) {
          this.pendingSearchReplaceDialog = false;
          this.openReplaceAllDialog(asyncCx);
        }
      } catch (err) {
        if (stale()) return;
        this.search.error = formatSearchError(err?.message || String(err)) || "Search failed";
        this.search.warning = null;
        this.search.running = false;
        this.search.groups = [];
        this.search.totalMatches = 0;
        this.search.totalFiles = 0;
        this.search.limited = false;
        this.searchRows = [];
        this.searchHoveredRow = null;
        asyncCx.notify();
      }
    });
  }

  /**
   * Detects ripgrep once per workspace context. Each failed attempt is cached,
   * so the grep fallback does not pay a process spawn on every keystroke.
   *
   * @param {{ key: string, cwd: string, on: string | null }} context
   * @returns {Promise<boolean>}
   */
  async detectRipgrep(context) {
    if (this.rgContextKey === context.key && this.rgAvailable !== null) return this.rgAvailable;
    const result = await exec("rg", ["--version"], { cwd: context.cwd, on: context.on }).catch(() => null);
    const available = Boolean(result && result.code === 0);
    this.rgAvailable = available;
    this.rgContextKey = context.key;
    return available;
  }

  /**
   * Handles a click on a virtual search row. Group headers collapse; match rows
   * open their file with a find prop pointing at the line. Two clicks inside
   * the double-click window promote the preview tab, like the Explorer does.
   *
   * @param {string} key
   * @param {import("gpui-kit").ViewContext} cx
   */
  onSearchRowClick(key, cx) {
    const row = this.searchRows.find((candidate) => candidate.key === key);
    if (!row) return;
    if (row.kind === "group") {
      if (this.search.collapsedFiles.has(row.group.file)) {
        this.search.collapsedFiles.delete(row.group.file);
      } else {
        this.search.collapsedFiles.add(row.group.file);
      }
      this.searchRows = flattenSearchRows(this.search.groups, this.search.collapsedFiles);
      cx.notify();
      return;
    }

    const now = Date.now();
    const permanent = shouldPromoteSearchClick(this.lastSearchClick, key, now);
    this.lastSearchClick = { key, at: now };
    this.openSearchResult(row.group, row.match, permanent, cx);
  }

  /**
   * Opens one search match through the normal preview-tab path, carrying the
   * query, toggles and line so the opened tab can show the match.
   *
   * @param {{ file: string }} group
   * @param {{ line: number }} match
   * @param {boolean} permanent
   * @param {import("gpui-kit").ViewContext} cx
   */
  openSearchResult(group, match, permanent, cx) {
    const find = {
      query: this.search.query,
      caseSensitive: this.search.caseSensitive,
      wholeWord: this.search.wholeWord,
      regex: this.search.regex,
      line: match.line,
      at: Date.now(),
    };
    this.openFileTab(group.file, cx, { permanent, find });
  }

  /**
   * Renders the Rename modal dialog.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element | null}
   */
  renderRenameDialog(t) {
    const dialog = this.renameDialog;
    if (!dialog) return null;

    const title = dialog.isDir ? "Rename Folder" : "Rename File";
    const currentVal = this.renameInput ? this.renameInput.value() : "";
    const previewName = currentVal.trim()
      ? resolveRenamedName(currentVal.trim(), dialog.oldName, dialog.isDir)
      : dialog.oldName;
    const showPreview = previewName && previewName !== currentVal.trim();

    return v_flex()
      .id("files-rename-backdrop")
      .absolute()
      .inset_0()
      .bg(isLightColor(t.background) ? "#00000040" : "#0000008c")
      .items_center()
      .justify_center()
      .p(12)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.closeModals(cx);
        }
      })
      .on_mouse_down("left", (_e, cx) => this.closeModals(cx))
      .on_mouse_down("right", (_e, cx) => this.closeModals(cx))
      .child(
        v_flex()
          .id("files-rename-dialog")
          .w_full()
          .max_w(280)
          .p(14)
          .gap(10)
          .rounded(10)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .text_size(12.5)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .child(
            h_flex()
              .items_center()
              .child(div().flex_1().font_semibold().text_size(13).text_color(t.foreground).child(title))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => this.closeModals(cx))
                  .child("Esc")
              )
          )
          .child(
            div()
              .truncate()
              .text_size(11.5)
              .text_color(t.muted)
              .child(`Current: ${dialog.oldName}`)
          )
          .child(
            Input.new(this.renameInput)
              .h(30)
              .px(8)
              .rounded(6)
              .border_1()
              .border_color(dialog.error ? t.blocked || "#e05252" : t.accent || t.input)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground)
          )
          .when(Boolean(showPreview), (el) =>
            el.child(
              div()
                .truncate()
                .text_size(11)
                .text_color(t.dim)
                .child(`Will rename to: ${previewName}`)
            )
          )
          .when(Boolean(dialog.error), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(t.blocked || "#e05252")
                .child(dialog.error)
            )
          )
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .pt(4)
              .child(
                h_flex()
                  .id("files-rename-cancel")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.closeModals(cx))
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .id("files-rename-confirm")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.solid || t.accent)
                  .bg(t.solid || t.accent)
                  .text_color(t.solid_foreground || "#ffffff")
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => this.submitRename(cx))
                  .child(this.actionPending ? "Renaming…" : "Rename")
              )
          )
      );
  }

  /**
   * Renders the Delete confirmation modal dialog.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element | null}
   */
  renderDeleteDialog(t) {
    const dialog = this.deleteDialog;
    if (!dialog) return null;

    const title = dialog.isDir ? "Delete Folder" : "Delete File";
    const question = dialog.isDir
      ? `Are you sure you want to delete "${dialog.name}" and all its contents?`
      : `Are you sure you want to delete "${dialog.name}"?`;

    return v_flex()
      .id("files-delete-backdrop")
      .absolute()
      .inset_0()
      .bg(isLightColor(t.background) ? "#00000040" : "#0000008c")
      .items_center()
      .justify_center()
      .p(12)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.closeModals(cx);
        } else if (e.key === "enter") {
          cx.stop_propagation();
          this.submitDelete(cx);
        }
      })
      .on_mouse_down("left", (_e, cx) => this.closeModals(cx))
      .on_mouse_down("right", (_e, cx) => this.closeModals(cx))
      .child(
        v_flex()
          .id("files-delete-dialog")
          .w_full()
          .max_w(280)
          .p(14)
          .gap(10)
          .rounded(10)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .text_size(12.5)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .child(
            h_flex()
              .items_center()
              .child(div().flex_1().font_semibold().text_size(13).text_color(t.foreground).child(title))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => this.closeModals(cx))
                  .child("Esc")
              )
          )
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(question)
          )
          .when(dialog.isDir, (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(t.blocked || "#e05252")
                .child("This action cannot be undone.")
            )
          )
          .when(Boolean(dialog.error), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(t.blocked || "#e05252")
                .child(dialog.error)
            )
          )
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .pt(4)
              .child(
                h_flex()
                  .id("files-delete-cancel")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.closeModals(cx))
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .id("files-delete-confirm")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.blocked || "#e05252")
                  .bg(t.blocked || "#e05252")
                  .text_color("#ffffff")
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => this.submitDelete(cx))
                  .child(this.actionPending ? "Deleting…" : "Delete")
              )
          )
      );
  }

  /**
   * Renders the Replace All in Files confirmation modal.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element | null}
   */
  renderReplaceDialog(t) {
    const dialog = this.replaceDialog;
    if (!dialog) return null;
    const question = formatReplaceAllConfirmation(dialog.count, dialog.files, dialog.replacement);

    return v_flex()
      .id("files-replace-backdrop")
      .absolute()
      .inset_0()
      .bg(isLightColor(t.background) ? "#00000040" : "#0000008c")
      .items_center()
      .justify_center()
      .p(12)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.closeModals(cx);
        } else if (e.key === "enter") {
          cx.stop_propagation();
          this.submitReplaceAllFiles(cx);
        }
      })
      .on_mouse_down("left", (_e, cx) => this.closeModals(cx))
      .on_mouse_down("right", (_e, cx) => this.closeModals(cx))
      .child(
        v_flex()
          .id("files-replace-dialog")
          .w_full()
          .max_w(340)
          .p(14)
          .gap(10)
          .rounded(10)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .text_size(12.5)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .child(
            h_flex()
              .items_center()
              .child(div().flex_1().font_semibold().text_size(13).text_color(t.foreground).child("Replace All"))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => this.closeModals(cx))
                  .child("Esc")
              )
          )
          .child(
            div()
              .text_size(11.5)
              .text_color(t.muted)
              .child(question)
          )
          .when(Boolean(dialog.error), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(t.blocked || "#e05252")
                .child(dialog.error)
            )
          )
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .pt(4)
              .child(
                h_flex()
                  .id("files-replace-cancel")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.closeModals(cx))
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .id("files-replace-confirm")
                  .h(26)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.accent || t.solid || t.foreground)
                  .bg(t.accent || t.solid || t.foreground)
                  .text_color(t.background)
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => this.submitReplaceAllFiles(cx))
                  .child(this.replaceRunning ? "Replacing…" : "Replace")
              )
          )
      );
  }

  /**
   * Renders the file tree right-click menu over the pane.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element | null}
   */
  renderRowContextMenu(t) {
    const menu = this.contextMenu;
    if (!menu) return null;

    const activeSpace = (spaces() || []).find((s) => s.active);
    const activeTab = (activeSpace?.tabs ?? []).find((t) => t.active);
    const tabPanes = activeTab ? (panes() || []).filter((p) => p.tab === activeTab.id) : [];
    const hasEmptySplit = tabPanes.length > 1 && tabPanes.some(isEmptyPane);

    const item = (id, label, iconPath, action, options = {}) =>
      h_flex()
        .id(id)
        .h(26)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(options.danger ? (t.blocked ? `${t.blocked}22` : t.hover) : t.hover))
        .on_click((_e, cx) => {
          this.contextMenu = null;
          action(cx);
          cx.notify();
        })
        .when(Boolean(iconPath), (el) =>
          el.child(
            svg(iconPath)
              .size(13)
              .flex_none()
              .text_color(options.danger ? (t.blocked || t.muted) : t.muted)
          )
        )
        .child(
          div()
            .truncate()
            .when(Boolean(options.danger), (el) => el.text_color(t.blocked || t.foreground))
            .child(label)
        );

    return div()
      .id("files-context-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => this.closeRowContextMenu(cx))
      .on_mouse_down("right", (_e, cx) => this.closeRowContextMenu(cx))
      .child(
        v_flex()
          .id("files-context-menu")
          .absolute()
          .left(menu.x)
          .top(menu.y)
          .w(180)
          .p(4)
          .rounded(8)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_lg()
          .text_size(12)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .when(!menu.dir, (el) =>
            el.child(item("files-menu-open", "Open file", "mods/file-editor/file.svg", (cx) => this.openFileTab(menu.path, cx, { permanent: true })))
          )
          .when(!menu.dir && hasEmptySplit, (el) =>
            el.child(item("files-menu-open-pane", "Place in empty pane", "mods/file-editor/file.svg", (cx) => this.openFileTab(menu.path, cx, { permanent: true })))
          )
          .child(item("files-menu-copy", "Copy path", "mods/file-editor/copy.svg", (cx) => this.copyPathToClipboard(menu.path, menu.dir, cx)))
          .child(item("files-menu-rename", "Rename", "mods/file-editor/rename.svg", (cx) => this.openRenameDialog(menu.path, menu.dir, cx)))
          .child(
            item("files-menu-delete", "Delete", "mods/file-editor/trash.svg", (cx) => this.openDeleteDialog(menu.path, menu.dir, cx), {
              danger: true,
            })
          )
      );
  }

  /**
   * Builds rows of the files tree.
   *
   * @param {string} prefix
   * @param {number} depth
   * @param {Array<import("gpui-kit").Element>} out
   * @param {Record<string, string>} t
   * @returns {Array<import("gpui-kit").Element>}
   */
  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const mark = this.marks[`${this.root}/${path}`] || this.marks[path];
      const isSelected = this.selectedFile === path;
      const isHovered = this.hoveredPath === path;
      const isPreview = !entry.dir && this.previewFiles?.has(path);

      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .cursor_context_menu()
          .on_mouse_down("right", () => this.rememberRowContextTarget(entry, path))
          .when(isSelected, (el) => el.bg(t.selected))
          .hover((s) => s.bg(isSelected ? t.selected : t.hover))
          .on_hover((hovered, cx) => {
            if (hovered) {
              this.hoveredPath = path;
            } else if (this.hoveredPath === path) {
              this.hoveredPath = null;
            }
            cx.notify();
          })
          .on_click((event, cx) => {
            if (entry.dir) this.toggle(path, cx);
            else this.openFileTab(path, cx, { permanent: event.click_count >= 2 });
          })
          .child(
            entry.dir
              ? svg(`mods/file-editor/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim)
              : div().w(12).flex_none()
          )
          .child(image(entry.dir ? FOLDER_ICON_PATH : fileIconPath(entry.name, isLightColor(t.background))).size(14).flex_none())
          .child(
            h_flex()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(
                div()
                  .min_w(0)
                  .truncate()
                  .when(isPreview, (el) => el.italic())
                  .when(isPreview, (el) => el.text_color(t.dim))
                  .when(isPreview, (el) => el.tooltip("Preview — double-click to keep this file open"))
                  .child(entry.name)
              )
              .when(isHovered, (el) =>
                el.child(
                  h_flex()
                    .id(`file-copy-${path}`)
                    .flex_none()
                    .p(3)
                    .rounded(4)
                    .cursor_pointer()
                    .hover((s) => s.bg(isSelected ? t.hover : t.selected))
                    .text_color(t.muted)
                    .tooltip(entry.dir ? "Copy folder path" : "Copy file path")
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.copyPathToClipboard(path, entry.dir, cx);
                    })
                    .child(svg("mods/file-editor/copy.svg").size(12))
                )
              )
          )
          .child(div().flex_1())
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
                .child(mark)
            )
          )
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  /**
   * Renders the Files pane browser tree and its right-click menu overlay.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @returns {import("gpui-kit").Element}
   */
  renderFilesPane(cx) {
    this.syncActiveFileSelection(cx, false);
    const t = theme();
    const activeTabs = (spaces() || []).find((s) => s.active)?.tabs ?? [];
    const editorTabIds = new Set(
      (panes() || []).filter((pane) => pane.mod === "file-editor").map((pane) => pane.tab)
    );
    this.previewFiles = new Set(
      collectPreviewTabs(shared("file-editor.openTabs"), activeTabs, this.root, null, { editorTabIds })
        .map((preview) => preview.entry?.file)
        .filter((file) => typeof file === "string" && file.length > 0)
    );

    return v_flex()
      .id("files")
      .relative()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.filesFocusHandle)
      .key_context("FilesPane")
      .on_action("file-editor.search", (_event, cx) => this.focusSearch(cx))
      .on_mouse_down("right", (event, cx) => this.openRowContextMenu(event, cx))
      .on_key_down((event, cx) => this.handleFilesKeyDown(event, cx))
      .child(
        renderSidebarSectionHeader({
          id: "files-section-explorer",
          label: "EXPLORER",
          open: this.sections.explorer,
          t,
          onToggle: (cx) => this.toggleSection("explorer", cx),
          trailing: h_flex()
            .gap(4)
            .items_center()
            .child(
              div()
                .max_w(130)
                .truncate()
                .text_size(10.5)
                .text_color(t.dim)
                .child(this.root?.split(/[\\/]/).pop() ?? "")
            )
            .child(
              h_flex()
                .id("files-explorer-search")
                .w(20)
                .h(20)
                .flex_none()
                .items_center()
                .justify_center()
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .text_color(t.dim)
                .tooltip("Search files (Cmd+Shift+F)")
                .on_click((_event, cx) => {
                  cx.stop_propagation();
                  this.focusSearch(cx);
                })
                .child(svg("mods/file-editor/search.svg").size(12))
            ),
        })
      )
      .when(this.sections.explorer, (el) =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .on_mouse_down("left", (_event, _cx) => {
              this.filesFocusHandle?.focus();
            })
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
              el.child(
                div()
                  .p(8)
                  .text_size(12)
                  .text_color(t.dim)
                  .child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))
              )
            )
            .when(this.limited, (el) =>
              el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))
            )
        )
      )
      .child(renderSearchSection(this, t))
      .when(Boolean(this.contextMenu), (el) => el.child(this.renderRowContextMenu(t)))
      .when(Boolean(this.renameDialog), (el) => el.child(this.renderRenameDialog(t)))
      .when(Boolean(this.deleteDialog), (el) => el.child(this.renderDeleteDialog(t)))
      .when(Boolean(this.replaceDialog), (el) => el.child(this.renderReplaceDialog(t)));
  }

  /**
   * Root render entrypoint. Dispatches to tab view or pane tree.
   *
   * @param {import("gpui-kit").ViewContext} cx
   * @returns {import("gpui-kit").Element}
   */
  render(cx) {
    if (this.tabMode) {
      return this.renderFileTab(cx);
    }
    return this.renderFilesPane(cx);
  }
}
