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
import { v_flex, h_flex, Editor, EditorState, Input, InputState, Scrollbar } from "gpui-base";
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
} from "./file-logic.js";
import { renderMarkdownDocument } from "./markdown-view.js";

/** In-memory cache for open and recent file tab states (scroll, cursor, text, view mode, EditorState). */
const fileTabStates = new Map();

/** Max number of file editor instances to retain in the LRU cache. */
const MAX_CACHED_FILE_STATES = 15;

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
    this.mdScrollY = cached?.mdScrollY ?? 0;
    this.pictureScrollX = cached?.pictureScrollX ?? 0;
    this.pictureScrollY = cached?.pictureScrollY ?? 0;
    this.watched = null;
    this.watchToken = null;
    this.focusHandle = cx.focus_handle();
    this.dirty = cached?.dirty ?? false;
    this.saving = false;
    this.lastSavedText = null;

    if (fileTabStates.has(this.fileKey)) {
      fileTabStates.get(this.fileKey).lastAccess = Date.now();
    } else if (cached) {
      fileTabStates.set(this.fileKey, { ...cached, lastAccess: Date.now() });
    }

    // Register this open tab in shared state
    this.registerOpenTab(p);
    if (this.dirty) this.promotePreviewTab();

    this.loadFile(cx);
    this.watchTab(this.root, cx);

    // Sync theme, font, and shared wrap setting periodically
    cx.timer.every(500, (cx) => this.syncTabConfig(cx));
    // Poll for external file modifications as a safety net (e.g. agent edits, remote SSH, missed watcher events)
    cx.timer.every(1500, (cx) => this.checkDiskChanges(cx));
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
      dirty: this.dirty,
      lastAccess: Date.now(),
      ...patch,
    };
    fileTabStates.set(this.fileKey, updated);
    savePersistedTabState(this.fileKey, {
      viewMode: updated.viewMode,
      imageZoom: updated.imageZoom,
      wrap: updated.wrap,
      mdScrollY: updated.mdScrollY,
      pictureScrollX: updated.pictureScrollX,
      pictureScrollY: updated.pictureScrollY,
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
          this.updateCachedTabState();
        } else {
          this.code?.release();
          this.code = null;
          this.editorInputs = null;
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
   * Keyboard shortcut listener on the tab container for saving with Cmd+S / Ctrl+S
   * and toggling soft wrap with Alt+Z / Opt+Z.
   *
   * @param {import("gpui-kit").KeyEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  handleKeyDown(event, cx) {
    const isSave =
      event.keystroke === "cmd-s" ||
      event.keystroke === "ctrl-s" ||
      ((event.modifiers?.platform || event.modifiers?.control) && (event.key === "s" || event.key === "S"));

    if (isSave && !event.is_held) {
      cx.stop_propagation();
      this.saveFile(cx);
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
   */
  setViewMode(mode, cx) {
    if (this.viewMode === mode) return;
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
      this.focusEditor(cx);
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
    if (this.showsPicturePreview()) {
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
      .on_key_down((event, cx) => this.handleKeyDown(event, cx))
      .on_mouse_move((event, cx) => this.rememberViewport(event?.bounds, cx))
      .on_mouse_down("left", (event, cx) => {
        this.rememberViewport(event?.bounds, cx);
        setShared("file-editor.activeFile", { root: this.root, file: this.file });
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
              : this.renderCodeView(t)
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
    const estContentHeight = Math.max(viewportHeight, (this.lineCount || 100) * 32);
    const maxScroll = Math.max(0, estContentHeight - viewportHeight);
    this.mdScrollY = Math.max(0, Math.min(maxScroll, this.mdScrollY || 0));

    return div()
      .relative()
      .size_full()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .on_scroll_wheel((event, cx) => {
        const delta = event.delta?.y || 0;
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
          .py(24)
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
   * Files Pane Mode Implementation
   * ======================================================================== */

  /**
   * Sets up state, location timers, and folder watcher for the Files pane mode.
   *
   * @param {Record<string, any>} _p
   * @param {import("gpui-kit").ViewContext} cx
   */
  initPaneMode(_p, cx) {
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
    this.renameDialog = null;
    this.deleteDialog = null;
    this.renameInput = null;
    this.actionPending = false;
    this.filesFocusHandle = cx.focus_handle();
    this.filesOrigin = null;
    this.filesBounds = null;
    this.loading = false;
    this.refreshPending = false;
    this.watched = null;
    this.watchToken = null;
    this.error = null;
    this.limited = false;

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

    const { existingTabId, tabName, updatedOpenTabs } = resolveFileTab(
      path,
      this.root,
      activeTabs,
      openTabsMap,
      allTabs
    );

    if (existingTabId) {
      const nextOpenTabs = permanent
        ? setOpenTabPreview(updatedOpenTabs, fileKey, false)
        : updatedOpenTabs;
      setShared("file-editor.openTabs", nextOpenTabs);
      run("tab.select", { id: existingTabId });
      cx.notify();
      return;
    }

    let nextOpenTabs = { ...updatedOpenTabs };
    let closeTabIds = [];
    let deferredCloseTabIds = [];
    let replaceIndex = null;

    if (!permanent) {
      const editorTabIds = new Set(
        (panes() || []).filter((pane) => pane.mod === "file-editor").map((pane) => pane.tab)
      );
      const plan = planPreviewOpen(
        updatedOpenTabs,
        activeTabs,
        this.root,
        fileKey,
        shared("tabs.pinned") ?? [],
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
   * Opens the right-click menu for a file tree row at the pointer position.
   *
   * @param {{ name: string, dir: boolean }} entry
   * @param {string} path
   * @param {import("gpui-kit").MouseButtonEvent} event
   * @param {import("gpui-kit").ViewContext} cx
   */
  openRowContextMenu(entry, path, event, cx) {
    const menuWidth = 180;
    const menuHeight = entry.dir ? 88 : 114;
    const origin = this.filesOrigin;
    const bounds = this.filesBounds;
    const paneX = origin?.x ?? bounds?.x ?? 0;
    const paneY = origin?.y ?? bounds?.y ?? 0;
    let x = typeof event?.position?.x === "number" ? event.position.x - paneX : 20;
    let y = typeof event?.position?.y === "number" ? event.position.y - paneY : 20;
    const maxW = bounds?.width ?? 0;
    const maxH = bounds?.height ?? 0;
    if (maxW && x + menuWidth > maxW) x = Math.max(8, maxW - menuWidth - 8);
    if (maxH && y + menuHeight > maxH) y = Math.max(8, maxH - menuHeight - 8);
    this.contextMenu = { path, dir: entry.dir, x, y };
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
    if (this.contextMenu) {
      if (event.key === "escape") {
        cx.stop_propagation();
        this.closeRowContextMenu(cx);
      }
    }
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
   * Renders the file tree right-click menu over the pane.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element | null}
   */
  renderRowContextMenu(t) {
    const menu = this.contextMenu;
    if (!menu) return null;

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
          .on_mouse_down("right", (event, cx) => this.openRowContextMenu(entry, path, event, cx))
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
      .on_key_down((event, cx) => this.handleFilesKeyDown(event, cx))
      .on_mouse_move((e, _cx) => {
        if (e.bounds) this.filesBounds = e.bounds;
        if (e.position && e.local_position) {
          this.filesOrigin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
        }
      })
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Explorer"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(12)
              .text_color(t.dim)
              .child(this.root?.split(/[\\/]/).pop() ?? "")
          )
      )
      .child(
        v_flex()
          .id("files-tree")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
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
      .when(Boolean(this.contextMenu), (el) => el.child(this.renderRowContextMenu(t)))
      .when(Boolean(this.renameDialog), (el) => el.child(this.renderRenameDialog(t)))
      .when(Boolean(this.deleteDialog), (el) => el.child(this.renderDeleteDialog(t)));
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
