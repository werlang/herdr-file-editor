# File Explorer & Editor

A native, dual-mode file explorer panel and tabbed file editor for Herdr with syntax highlighting, Markdown, SVG, CSV, and XLSX previews, picture zoom, in-editor find/replace, workspace search/replace, and live filesystem watching powered directly by GPUI.

![File Explorer & Editor](preview.png)

## What you see

Inside any Herdr sidebar, split pane, or dedicated tab:

- **Files Browser Pane (`#files`)**:
  - **Header**: Two VS Code-style collapsible sections, `EXPLORER` and `SEARCH`, each with a chevron. The open/collapsed state persists in `shared("file-editor.sections")`; the EXPLORER header shows the workspace folder name and a search icon.
  - **Directory Tree (`#files-tree`)**: Collapsible folder hierarchy with vector chevrons (`chevron-down.svg`, `chevron-right.svg`), folder icons (`folder.svg`), file icons (`file.svg`), Git status porcelain marks (`A` in green, `M` in yellow/blocked, `D`/`U` in red), selection highlighting when a file's tab is active, a hover copy-path button beside the name, and a right-click menu (`Open file`, `Copy path`).
  - **SEARCH Section (`#files-search-section`)**: A replace chevron at the left of the query input, then the query input with `Aa`, `ab` and `.*` toggles, a `…` button revealing comma-separated `files to include` / `files to exclude` glob fields, a `N results in M files` summary, and manually windowed results grouped by file (visible rows plus six rows of overscan). File headers show a file icon, name, dim relative directory, match-count badge and collapse chevron; match rows show the line number and highlighted context. Expanding the replace row adds a replace input, `AB` preserve-case toggle and Replace All; open rows preview the strike/insert diff, and hovering a row reveals Replace/Dismiss (headers: Replace All in file/Dismiss). `Cmd+Shift+F` / `Ctrl+Shift+F` (or the EXPLORER search icon) expands and focuses SEARCH; `Cmd+Shift+1` / `Ctrl+Shift+1` replaces all when the replace row is open and results exist.

- **Dedicated File Editor Tab (`#file-editor-tab`)**:
  - **Toolbar (`h(38)`)**: Matches Herdr diff tab craft with vector file icon, bold filename with an accent dot indicator (`●`) on unsaved edits, truncated directory path, metadata pill showing line count and language name (e.g., `142 lines · JavaScript` or `85 lines · Markdown`), dynamic `Save` button (or `Read-only` badge on protected files), find button, and copy/refresh buttons.
  - **Find Widget**: Docked top-right, with a focused query input, `Aa` / `ab` / `.*` toggles, `N of M` counter, previous/next buttons and close. A chevron expands a second row with a replace input, `AB` preserve-case toggle, Replace and Replace All (`Cmd+Alt+F` / `Ctrl+H` opens it directly). Matches are highlighted in a read-only virtualised view and the current match is scrolled into view. `Esc` returns to the native editor; invalid regexes show `Invalid regex`; images disable find. Replacing edits only the buffer (`set_value`), marks the tab dirty and supports `Cmd+Z` / `Ctrl+Z` through a small in-memory undo stack; nothing is saved until `Cmd+S`.

  - **Editing & Saving**: Full editing support in Code view for code, config, Markdown, and SVG files with live dirty state tracking, `Save` button, and `Cmd+S` / `Ctrl+S` saving.
  - **Markdown Mode Switcher**: For `.md`, `.markdown`, and `.mdx` files, a segmented toggle (`Preview` / `Code`) defaulting to rendered preview.
  - **SVG Mode Switcher**: For `.svg` files, the same `Preview` / `Code` toggle, defaulting to a rendered preview on a light canvas so `currentColor` icons stay visible on dark themes.
  - **Spreadsheet Preview**: For `.csv` / `.tsv`, a table with a sticky header and row numbers, quoted-field parsing, delimiter detection and the same `Preview` / `Code` toggle. For `.xlsx` / `.xlsm`, worksheet tabs and a read-only table parsed from the OOXML ZIP container, with shared strings, inline strings, dates, percentages and number styles. Legacy `.xls` is not supported.
  - **Zoom Controls**: Raster images and SVG previews show `−` / percentage / `+` controls beside the view switcher; the percentage resets to fit. Cmd/Ctrl + wheel also zooms.
  - **Wrap Toggle**: In Code view, a `Wrap` button toggling soft line wrapping on long lines.
  - **Copy Button**: One-click clipboard copy button (`copy.svg`) with an instant toast notification.
  - **Refresh Button**: One-click reload button (`refresh.svg`) that re-reads file content from disk.
  - **Code View**: Interactive editor with line numbers, code folding, theme-matched syntax highlighting, user font settings, and in-place editing.
  - **Markdown Preview**: GitHub-style rendering (headings with rules, code boxes, bordered tables, quote bars, task lists) in a centered, readable 880px max-width column.
  - **SVG Preview**: `prepareSvgPreview` writes an enlarged copy to `cache/file-editor/` so the host rasterizes small icon view boxes crisply, and the preview is drawn on a light canvas so black `currentColor` fallbacks remain visible.
  - **Edge State Banners**: Friendly centered messages for deleted/missing files (`"This file is no longer available"`), binary files (`"Binary file · no text preview"`), or files truncated past 400,000 characters.
  - **Spreadsheet Limits**: Tables stop at 2,000 rows × 100 columns and 500 characters per cell; the toolbar shows a limit note when a sheet is capped. Workbooks above the 8 MiB `exec` transport budget show a friendly notice.

## How it behaves

- Automatically detects whether it is running as a Files browser panel (`props().file` unset) or a dedicated file viewer tab (`props().file` provided).
- In Files panel mode:
  - Resolves workspace root from `props().folder` or `props().cwd`, pinned active space location, focused terminal cwd (only when focused in the active space), or space folder fallback.
  - Checks location changes every 250ms in memory, so switching active spaces updates the file tree immediately.
  - Clicking a directory expands or collapses its contents.
  - **Clicking a file never opens the raw file inline inside the panel**. It calls `openFileTab(path)` to open or focus the file in its own Herdr tab.
  - Single-click opens a temporary preview tab (italic and dimmed); double-click the file (or, with `tabs-ref`, its tab) promotes it to permanent. Opening another preview replaces the previous temporary tab, while editing, pinning, or splitting the tab promotes it first so unsaved work survives.
  - Right-clicking a row opens a context menu with `Open file` (files) and `Copy path`; it is clamped to the panel and dismissed by any outside press.
  - Reuses an already open, non-settled tab for the same file using `run("tab.select")` instead of creating duplicate tabs.
  - Disambiguates identical file names across different folders by prepending their parent directory (`dir/base`).
  - **SEARCH** runs as you type with a ~300ms debounce, off the UI thread, and discards stale scans with a token. `rg --json` is preferred (respecting `.gitignore`; bounded to 1,000 columns, 1 MiB per file and 200 matches per file); without ripgrep it falls back to `grep -rn --null` plus a JS re-match pass (binary skip, `.git`/`node_modules` exclusion, 200 matches per file). Include/exclude globs are applied before the match cap. Both use a 20s timeout; superseded scans are ignored because `exec` has no cancellation handle. Results cap at 2,000 matches / 200 files and show `(limited)`. Partial exit-2 runs keep their matches with a dim warning; unsupported regex dialects read `Regex not supported by search: …`.
  - Clicking a search match opens the file through the normal preview path and passes `find: { query, caseSensitive, wholeWord, regex, line }`; the opened tab shows the find widget with that match current. Double-clicking promotes the preview tab.
  - **Replace in files** snapshots the targeted rows, re-reads each file, recomputes matches on the fresh content and applies only targets whose line/column/length still match. The SEARCH Replace All button and `Cmd+Shift+1` always open the `Replace N occurrences across M files with 'X'?` confirmation, even for one match or one file; the per-row Replace and per-file Replace All hover actions write directly. Files changed on disk, unreadable files, files at or above 1 MiB, files whose fresh read contains `\uFFFD` and files with unsaved editor edits are skipped with the reason in the toast. Writes use the existing local/remote snapshot save paths, preserve line endings, the trailing newline and a UTF-8 BOM, and the search re-runs afterwards.
  - Search results are manually windowed (visible rows plus six rows of overscan) rather than a virtual list because GPUI forbids event handlers inside a virtual-list renderer and the hover Replace/Dismiss actions need per-row handlers. For 2,000 results in a 400px viewport at 24px rows that is at most 29 rendered rows.

- In File Editor tab mode:
  - Reads file text asynchronously off the UI thread with `readTextFile`.
  - Automatically detects language and syntax coloring tokens from Herdr's active theme.
  - Defaults Markdown, SVG, CSV and TSV files to `"preview"` mode, XLSX/XLSM to read-only preview, and all other files to `"code"` mode.
  - Parses CSV/TSV tables in memory with delimiter detection and quoted-field support; XLSX/XLSM is read from its ZIP container through `exec` + base64, then inflated and parsed as OOXML.
  - Virtualizes spreadsheet rows, keeps the header and row-number gutter sticky, scrolls in both axes, and restores each worksheet's scroll position.
  - Caps spreadsheet previews at 2,000 rows × 100 columns and 500 characters per cell, showing a limit note in the toolbar.
  - Allows full editing in Code view, updating line counts dynamically and tracking dirty state against the disk snapshot.
  - Saves file contents atomically (via `writeTextFile` locally or `writeRemoteTextFile` over SSH via `herdr-core` `exec`), triggered by the toolbar `Save` button or `Cmd+S` / `Ctrl+S`, alerting if disk files were modified externally.
  - Watches the workspace directory via `watchFolder` so external edits reload automatically without clobbering active unsaved work.
  - Persists line wrap preferences in `shared("file-editor.wrap")`.
  - Persists the last find query, toggles, replace text, replace-row state and preserve-case flag in `shared("file-editor.find")`; opening find on a Markdown/SVG preview switches to Code view, since the read-only match view is the only surface that can scroll a match into view.
  - In-editor replacement supports literal inserts in plain mode and `$0` / `$&`, `$1`…`$99`, `$$`, `\n`, `\t`, `\\` plus `\u` / `\l` / `\U` / `\L` / `\E` in regex mode; unknown escapes keep their backslash. Preserve case follows VS Code: all-upper → upper, all-lower → lower, mixed case adjusts only the first letter, and hyphen/underscore segments are handled per segment. Replacements run back to front so untouched text (including CRLF and a trailing newline) stays byte-identical; Replace All recomputes matches without the 5,000 display cap, zero matches is a no-op, and `Cmd+Z` is only consumed when the replace undo stack is non-empty.
  - Regex anchors match every line, whole-word keeps alternation candidates (`foo|foobar`), and the read-only view slices long lines horizontally to keep the current match visible. A `find` prop is applied once per file (including its replace fields), and Escape is scoped to the find widget's key context so it does not swallow Escape elsewhere.
  - `EditorState` has no selection, cursor, scroll-to-line or decoration API, so the find widget renders its own virtualised read-only text view and leaves the native editor state untouched. Editing pauses while find is open; unsaved edits survive.

  - Zooms raster images and SVG previews at 25%–400%; 100% fits the pane and higher levels scroll in both directions.
  - Releasing or closing tabs cleanly frees `EditorState` instances, invalidates watch tokens, and deletes cached preview copies.

## Built from

- `mods/file-editor/`:
  - `main.js`: Main dual-mode View component handling tree navigation, tab management, toolbar interactions, and editor rendering.
  - `file-logic.js`: Pure, deterministic helpers for language mapping, Markdown block parsing, SVG preview preparation, picture zoom levels, location resolution, spreadsheet file classification, and tab deduplication.
  - `spreadsheet.js`: Pure CSV/TSV parsing and XLSX/XLSM OOXML reading, plus visible table range and column-width helpers.
  - `find-logic.js`: Pure match/search/replace engine (query → regex, match scanning, counters, wrap/step, line lookup, highlight segments, context trimming, globs, rg/grep parsing, grouping/capping, summaries, replacement expansion, preserve case, back-to-front application, single-match next selection, inline diff segments, safe file-replace planning, confirmation text).
  - `find-view.js`: Find bar and replace row, virtualised read-only match view and the SEARCH sidebar section (replace row, inline diff, hover actions).
  - `mod.json`: Herdr mod manifest (`"place": "none"`).
  - Vector SVG icons: `chevron-down.svg`, `chevron-right.svg`, `folder.svg`, `file.svg`, `copy.svg`, `refresh.svg`, `search.svg`, `arrow-up.svg`, `arrow-down.svg`, `close.svg`, `replace.svg`, `replace-all.svg`.

- `gpui-kit` & `gpui-base`: Native GPU elements, flex layouts, `Editor`, `EditorState`, and `TextView.markdown` for inline text.
- `herdr` runtime API: `readTextFile`, `writeTextFile`, `exec`, `appHome`, `watchFolder`, `theme()`, `settings()`, `spaces()`, `panes()`, `focused()`, `run()`, `shared()`, `setShared()`, and `notify()`.

## Watch out

- Keep the mod name `file-editor` stable because assets are loaded from `mods/file-editor/*.svg`.
- `EditorState.new` must never be called inside `render()`. Always instantiate in `loadFile` or event handlers and release previous instances via `this.code?.release()`.
- `EditorState` exposes only `value`, `set_value`, `on` and `release`. Find must not look for selection/cursor/scroll APIs; it owns the read-only match view and must never recreate or `set_value` the editor just because the widget opens or closes. Replacement is the one deliberate `set_value` caller, and it owns the dirty flag and the in-memory undo snapshot because `set_value` may reset native undo.
- Files-pane replace must never write a file open in an editor tab with unsaved edits. The check combines `shared("file-editor.openTabs")` with `dirtyFileKeys` (kept outside the bounded LRU cache); stale cached edits from a closed tab must not block a write.
- Never pass `null` or `undefined` to `.child()` to prevent GPUI rendering panics.

- Never use synchronous event `cx` across an `await`; wrap asynchronous workflows in `cx.spawn(async (cx) => ...)`.
- Per-loop `watchToken` objects invalidate stale background watchers when switching directories or closing views.
- The host rasterizes SVG at its root `width`/`height`, not the layout size; use `prepareSvgPreview` so small view boxes stay crisp, and never draw SVG previews on the app background alone because `currentColor` falls back to black.
- Cache previews live outside `mods/` so writing them does not trigger a mod reload; remove them in `close(_cx)`.
- XLSX bytes are read with `exec` + base64 because `fs.readFile` is capability-gated. Keep the 8 MiB stdout cap in mind: the preview rejects larger workbooks instead of showing a truncated ZIP.
- Spreadsheet rows are virtualized; do not render every row or every off-screen column, or a large CSV will stall the UI.
- Known limitation: remote writes through `writeRemoteTextFile` use a temp file + `mv -f`, which may drop the target file's mode. A portable mode copy is not attempted (`chmod --reference` is not portable).

## Done when

- `herdr-app check mods/file-editor` passes with zero errors.
- `node --test test/` passes all unit tests.
- `sync.sh` synchronizes the mod to `~/.config/herdr-app/mods/file-editor`.
- Clicking files in the Files browser opens dedicated Herdr tabs rather than replacing the directory tree.
- `Cmd+F` opens the find widget, highlights matches, steps with wrap-around, and `Esc` returns to the editor with unsaved edits intact.
- `Cmd+Alt+F` / `Ctrl+H` opens the replace row; Replace/Replace All edit the buffer, mark the tab dirty, leave the disk untouched until save, and `Cmd+Z` restores the previous text while find is open.
- `Cmd+Shift+F` expands SEARCH, results group by file, and clicking a match opens the file at that match through the find prop.
- SEARCH replace shows the inline strike/insert diff, Replace/Dismiss hover actions, and a confirmation dialog for multi-file runs; the write re-reads each file, skips dirty open tabs and files changed on disk, then re-runs the search.
- Syntax highlighting and Markdown preview render smoothly.
- CSV/TSV table previews handle quotes, delimiters and large row counts; XLSX worksheet tabs, dates and percentages render correctly.
- SVG previews render crisply on a light canvas, and raster/SVG zoom controls work at every level.
