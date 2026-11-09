/**
 * Herdr File Editor Mod (Dual-Mode: Files Pane Tree & Dedicated File Viewer Tab).
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
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
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
  mergeOpenTabEntry,
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
} from "./file-logic.js";
import { renderMarkdownDocument } from "./markdown-view.js";

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
   * Lifecycle cleanup: marks view closed, releases EditorState, and invalidates active watchers.
   *
   * @param {import("gpui-kit").AsyncContext} _cx
   */
  async close(_cx) {
    this.closed = true;
    if (this.imageSrc) {
      const name = this.imageSrc.slice(this.imageSrc.lastIndexOf("/") + 1);
      const prefix = name.replace(/-\d+\.[^.]+$/, "");
      await exec("sh", ["-c", 'rm -f "$1/$2"-*', "rm", `${appHome()}/cache/file-editor`, prefix]).catch(() => null);
      this.imageSrc = null;
    }
    this.watched = null;
    this.watchToken = null;
    this.hoveredPath = null;
    this.editorInputs = null;
    this.imageSize = null;
    this.pictureViewport = null;
    this.focusHandle = null;
    this.dirty = false;
    this.saving = false;
    this.lastSavedText = null;
    if (this.code) {
      this.code.release();
      this.code = null;
    }
    const active = shared("file-editor.activeFile");
    if (active && active.file === this.file && active.root === this.root) {
      setShared("file-editor.activeFile", null);
    }
    const openTabsMap = shared("file-editor.openTabs");
    if (openTabsMap && this.file) {
      const fileKey = this.root ? `${this.root}/${this.file}` : this.file;
      if (openTabsMap[fileKey]) {
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

    const requestedMode = typeof p.viewMode === "string" ? p.viewMode : null;
    this.viewMode = defaultViewMode(this.file, requestedMode);

    this.explicitWrap = typeof p.wrap === "boolean";
    const savedWrap = shared("file-editor.wrap");
    this.wrap = this.explicitWrap ? p.wrap : savedWrap === true;

    this.rawText = null;
    this.preparedText = null;
    this.fileError = null;
    this.lineCount = 0;
    this.isBinary = false;
    this.isImage = isImageFile(this.file);
    this.isSvg = isSvgFile(this.file);
    this.imageSrc = null;
    this.imageLoading = false;
    this.imageSize = null;
    this.imageZoom = normalizeImageZoom(typeof p.zoom === "number" ? p.zoom : 1);
    this.pictureViewport = null;
    this.isTruncated = false;
    this.loading = false;
    this.reloadPending = false;
    this.code = null;
    this.editorInputs = null;
    this.watched = null;
    this.watchToken = null;
    this.focusHandle = cx.focus_handle();
    this.dirty = false;
    this.saving = false;
    this.lastSavedText = null;

    // Register this open tab in shared state
    this.registerOpenTab(p);

    this.loadFile(cx);
    this.watchTab(this.root, cx);

    // Sync theme, font, and shared wrap setting periodically
    cx.timer.every(500, (cx) => this.syncTabConfig(cx));
    // Poll for external file modifications as a safety net (e.g. agent edits, remote SSH, missed watcher events)
    cx.timer.every(1500, (cx) => this.checkDiskChanges(cx));
  }

  /**
   * Records this open tab in shared("file-editor.openTabs").
   *
   * @param {Record<string, any>} p
   */
  registerOpenTab(p) {
    const fileKey = this.root ? `${this.root}/${this.file}` : this.file;
    const openTabsMap = shared("file-editor.openTabs") || {};
    let tabId = null;
    let tabName = null;

    if (p.pane) {
      const matchedPane = (panes() || []).find((pn) => pn.pane === p.pane);
      if (matchedPane?.tab) {
        tabId = matchedPane.tab;
        for (const sp of spaces() || []) {
          const foundTab = (sp.tabs || []).find((t) => t.id === tabId);
          if (foundTab?.name) {
            tabName = foundTab.name;
            break;
          }
        }
      }
    }

    if (!tabId) {
      const f = focused();
      if (f?.tab) {
        tabId = f.tab;
        for (const sp of spaces() || []) {
          const foundTab = (sp.tabs || []).find((t) => t.id === tabId);
          if (foundTab?.name) {
            tabName = foundTab.name;
            break;
          }
        }
      }
    }

    if (!tabId) {
      const activeSpace = (spaces() || []).find((s) => s.active);
      const activeTab = activeSpace?.tabs?.find((t) => t.active);
      if (activeTab) {
        tabId = activeTab.id;
        tabName = activeTab.name;
      }
    }

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
    setShared("file-editor.activeFile", { root: this.root, file: this.file });
  }

  /**
   * Synchronizes active EditorState with theme, font settings, and shared wrap.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  syncTabConfig(cx) {
    if (this.closed) return;

    let changed = false;
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
          } else {
            this.code?.release();
            this.code = null;
            this.editorInputs = null;
          }
        } else {
          this.code?.release();
          this.code = null;
          this.editorInputs = null;
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
      this.code?.release();
      this.code = null;
      this.editorInputs = null;
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
      notifyNeeded = true;
    }
    if (this.lineCount !== newLineCount) {
      this.lineCount = newLineCount;
      notifyNeeded = true;
    }
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
    this.rebuildEditor();
    cx.notify();
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
    if (mode === "code" && !this.code) {
      this.rebuildEditor();
    } else if (mode === "preview" && this.isSvg && !this.imageSrc && !this.imageLoading) {
      this.loadImage(cx);
    }
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
    }
    const modifiers = event.modifiers || {};
    if (!modifiers.platform && !modifiers.control) return;
    const delta = event.delta?.y || event.delta?.x || 0;
    if (delta === 0) return;
    this.zoomPicture(delta < 0 ? 1 : -1, cx);
    cx.stop_propagation();
  }

  /**
   * Remembers the tab's bounds as the picture viewport, so the pixel-based fit
   * math has the real pane size. Called from pointer events on the tab root,
   * before a click reaches the zoom controls.
   *
   * @param {{ width: number, height: number } | undefined} bounds
   * @param {import("gpui-kit").Context} cx
   */
  rememberViewport(bounds, cx) {
    if (!bounds || !this.showsPicturePreview()) return;
    const width = Math.round(bounds.width);
    const height = Math.max(1, Math.round(bounds.height - HEADER_HEIGHT));
    const previous = this.pictureViewport;
    if (previous && previous.width === width && previous.height === height) return;
    this.pictureViewport = { width, height };
    // The percentage fallback fits by width; the measured path also fits by
    // height and centers the picture. Repaint once the real size is known.
    cx.notify();
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

    return v_flex()
      .id("file-editor-tab")
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
              .child(div().min_w(0).font_semibold().text_size(12.5).truncate().child(base))
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
                .p(4)
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
            div()
              .flex_none()
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.raised)
              .text_size(10)
              .text_color(t.muted)
              .child(lineLabel)
          )
          .when(this.isReadonly(), (e) =>
            e.child(
              div()
                .id("file-editor-readonly")
                .flex_none()
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.raised)
                .text_size(10)
                .text_color(t.dim)
                .tooltip(this.readonlyReason())
                .child("Read-only")
            )
          )
          .when(!this.isReadonly(), (e) =>
            e.child(
              h_flex()
                .id("file-editor-save")
                .flex_none()
                .px(7)
                .py(2)
                .items_center()
                .rounded(4)
                .text_size(10)
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
                .child(this.saving ? "Saving…" : "Save")
            )
          )
          .when(hasPreview, (e) =>
            e.child(
              h_flex()
                .flex_none()
                .items_center()
                .gap(2)
                .p(2)
                .rounded(6)
                .bg(t.raised)
                .child(
                  div()
                    .id("file-view-preview")
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .text_size(10)
                    .cursor_pointer()
                    .when(this.viewMode === "preview", (btn) => btn.bg(t.selected).text_color(t.foreground))
                    .when(this.viewMode !== "preview", (btn) => btn.text_color(t.dim))
                    .hover((s) => s.bg(this.viewMode === "preview" ? t.selected : t.hover))
                    .tooltip(isSvg ? "Rendered SVG preview" : "Rendered Markdown preview")
                    .on_click((_e, cx) => this.setViewMode("preview", cx))
                    .child("Preview")
                )
                .child(
                  div()
                    .id("file-view-code")
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .text_size(10)
                    .cursor_pointer()
                    .when(this.viewMode === "code", (btn) => btn.bg(t.selected).text_color(t.foreground))
                    .when(this.viewMode !== "code", (btn) => btn.text_color(t.dim))
                    .hover((s) => s.bg(this.viewMode === "code" ? t.selected : t.hover))
                    .tooltip("Raw code and syntax view")
                    .on_click((_e, cx) => this.setViewMode("code", cx))
                    .child("Code")
                )
            )
          )
          .when(this.showsPicturePreview(), (e) => e.child(this.renderZoomControls(t)))
          .when(isCodeView, (e) =>
            e.child(
              div()
                .id("file-editor-wrap")
                .flex_none()
                .px(7)
                .py(2)
                .rounded(4)
                .text_size(10)
                .cursor_pointer()
                .when(this.wrap, (btn) => btn.bg(t.selected).text_color(t.foreground))
                .when(!this.wrap, (btn) => btn.text_color(t.dim))
                .hover((s) => s.bg(this.wrap ? t.selected : t.hover))
                .tooltip(
                  this.wrap
                    ? "Wrap long lines to the pane width (Alt+Z)"
                    : "Scroll long lines horizontally instead of wrapping (Alt+Z)"
                )
                .on_click((_e, cx) => this.setWrap(!this.wrap, cx))
                .child("Wrap")
            )
          )
          .child(
            h_flex()
              .id("file-editor-refresh")
              .flex_none()
              .p(4)
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
    return v_flex()
      .id("file-editor-image")
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
    return v_flex()
      .id("file-editor-svg")
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

    const container = v_flex()
      .id("file-editor-picture")
      .flex_1()
      .min_h(0)
      .overflow_scrollbar()
      .bg(t.background)
      .on_scroll_wheel((event, cx) => this.handlePictureWheel(event, cx));

    if (!size || !viewport || viewport.width <= 0 || viewport.height <= 0) {
      if (!size) {
        // Dimensions unknown (an unsupported header): fall back to the host's
        // natural-size rendering inside the pane.
        return container.items_center().justify_center().child(
          v_flex()
            .flex_none()
            .p(PICTURE_PADDING)
            .items_center()
            .justify_center()
            .when(whiteCanvas, (e) => e.bg("#ffffff").rounded(8).border(1).border_color(t.border))
            .child(image(this.imageSrc).max_w_full().max_h_full())
        );
      }
      // Before the pane has been measured, fit by width using a percentage
      // aspect box: the padding-top resolves against the box's own width, so
      // the picture keeps its ratio without knowing the pane in pixels.
      const aspect = size.height > 0 ? size.width / size.height : 1;
      const aspectPadding = Math.min(4000, 100 / aspect);
      return container.items_center().child(
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

    // Fit the whole picture inside the pane at 100%, never enlarging it.
    const availableWidth = Math.max(1, viewport.width - PICTURE_PADDING * 2);
    const availableHeight = Math.max(1, viewport.height - PICTURE_PADDING * 2);
    const fitScale = Math.min(1, availableWidth / size.width, availableHeight / size.height);
    const width = Math.max(1, Math.round(size.width * fitScale * zoom));
    const height = Math.max(1, Math.round(size.height * fitScale * zoom));

    return container
      .when(zoom <= 1, (e) => e.items_center().justify_center())
      .when(zoom > 1, (e) => e.items_start())
      .child(
        v_flex()
          .flex_none()
          .p(PICTURE_PADDING)
          .when(whiteCanvas, (e) => e.bg("#ffffff").rounded(8).border(1).border_color(t.border))
          .child(image(this.imageSrc).w(width).h(height))
      );
  }

  /**
   * Renders the Markdown preview as a GitHub-style document, centered in a readable column.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderMarkdownView(t) {
    const codeFont = settings()?.font_family ?? null;
    return v_flex()
      .id("file-editor-markdown")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
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
              .child(renderMarkdownDocument(this.preparedText ?? "", { t, codeFont, idPrefix: `md-${this.file}` }))
          )
      );
  }

  /**
   * Renders syntax-highlighted code editor view.
   *
   * @param {Record<string, string>} t
   * @returns {import("gpui-kit").Element}
   */
  renderCodeView(t) {
    if (this.code) {
      return Editor.new(this.code).flex_1().min_h(0);
    }
    return v_flex()
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
    this.contextMenu = null;
    this.filesOrigin = null;
    this.filesBounds = null;
    this.loading = false;
    this.refreshPending = false;
    this.watched = null;
    this.watchToken = null;
    this.error = null;
    this.limited = false;

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
   * @param {string} path
   * @param {import("gpui-kit").ViewContext} cx
   */
  openFileTab(path, cx) {
    this.selectedFile = path;
    setShared("file-editor.activeFile", { root: this.root, file: path });
    const activeSpace = spaces().find((s) => s.active);
    const activeTabs = activeSpace?.tabs ?? [];
    const openTabsMap = shared("file-editor.openTabs") || {};

    const { existingTabId, tabName, updatedOpenTabs } = resolveFileTab(path, this.root, activeTabs, openTabsMap);
    setShared("file-editor.openTabs", updatedOpenTabs);

    if (existingTabId) {
      run("tab.select", { id: existingTabId });
      cx.notify();
      return;
    }

    const tabProps = { folder: this.root, file: path };
    if (this.on) tabProps.on = this.on;
    run("tab.new", { name: tabName, mod: "file-editor", props: tabProps });
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
    const menuHeight = entry.dir ? 34 : 60;
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
   * @param {import("gpui-kit").ViewContext} cx
   */
  closeRowContextMenu(cx) {
    if (!this.contextMenu) return;
    this.contextMenu = null;
    cx.notify();
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

    const item = (id, label, action) =>
      h_flex()
        .id(id)
        .h(26)
        .px(8)
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.contextMenu = null;
          action(cx);
          cx.notify();
        })
        .child(div().truncate().child(label));

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
            el.child(item("files-menu-open", "Open file", (cx) => this.openFileTab(menu.path, cx)))
          )
          .child(item("files-menu-copy", "Copy path", (cx) => this.copyPathToClipboard(menu.path, menu.dir, cx)))
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
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.openFileTab(path, cx)))
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
              .child(div().min_w(0).truncate().child(entry.name))
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
          .child(div().font_semibold().child("Files"))
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
      .when(Boolean(this.contextMenu), (el) => el.child(this.renderRowContextMenu(t)));
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
