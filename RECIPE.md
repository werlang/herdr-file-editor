# File Explorer & Editor

A native, dual-mode file explorer panel and tabbed file editor for Herdr with syntax highlighting, Markdown and SVG previews, picture zoom, in-editor find, workspace search, and live filesystem watching powered directly by GPUI.

![File Explorer & Editor](preview.png)

## What you see

Inside any Herdr sidebar, split pane, or dedicated tab:

- **Files Browser Pane (`#files`)**:
  - **Header**: Two VS Code-style collapsible sections, `EXPLORER` and `SEARCH`, each with a chevron. The open/collapsed state persists in `shared("file-editor.sections")`; the EXPLORER header shows the workspace folder name and a search icon.
  - **Directory Tree (`#files-tree`)**: Collapsible folder hierarchy with vector chevrons (`chevron-down.svg`, `chevron-right.svg`), folder icons (`folder.svg`), file icons (`file.svg`), Git status porcelain marks (`A` in green, `M` in yellow/blocked, `D`/`U` in red), selection highlighting when a file's tab is active, a hover copy-path button beside the name, and a right-click menu (`Open file`, `Copy path`).
  - **SEARCH Section (`#files-search-section`)**: A query input with `Aa`, `ab` and `.*` toggles, a `…` button revealing comma-separated `files to include` / `files to exclude` glob fields, a `N results in M files` summary, and virtualised results grouped by file. File headers show a file icon, name, dim relative directory, match-count badge and collapse chevron; match rows show the line number and highlighted context. `Cmd+Shift+F` / `Ctrl+Shift+F` (or the EXPLORER search icon) expands and focuses SEARCH.

- **Dedicated File Editor Tab (`#file-editor-tab`)**:
  - **Toolbar (`h(38)`)**: Matches Herdr diff tab craft with vector file icon, bold filename with an accent dot indicator (`●`) on unsaved edits, truncated directory path, metadata pill showing line count and language name (e.g., `142 lines · JavaScript` or `85 lines · Markdown`), dynamic `Save` button (or `Read-only` badge on protected files), find button, and copy/refresh buttons.
  - **Find Widget**: Docked top-right, with a focused query input, `Aa` / `ab` / `.*` toggles, `N of M` counter, previous/next buttons and close. Matches are highlighted in a read-only virtualised view and the current match is scrolled into view. `Esc` returns to the native editor; invalid regexes show `Invalid regex`; images disable find.

  - **Editing & Saving**: Full editing support in Code view for code, config, Markdown, and SVG files with live dirty state tracking, `Save` button, and `Cmd+S` / `Ctrl+S` saving.
  - **Markdown Mode Switcher**: For `.md`, `.markdown`, and `.mdx` files, a segmented toggle (`Preview` / `Code`) defaulting to rendered preview.
  - **SVG Mode Switcher**: For `.svg` files, the same `Preview` / `Code` toggle, defaulting to a rendered preview on a light canvas so `currentColor` icons stay visible on dark themes.
  - **Zoom Controls**: Raster images and SVG previews show `−` / percentage / `+` controls beside the view switcher; the percentage resets to fit. Cmd/Ctrl + wheel also zooms.
  - **Wrap Toggle**: In Code view, a `Wrap` button toggling soft line wrapping on long lines.
  - **Copy Button**: One-click clipboard copy button (`copy.svg`) with an instant toast notification.
  - **Refresh Button**: One-click reload button (`refresh.svg`) that re-reads file content from disk.
  - **Code View**: Interactive editor with line numbers, code folding, theme-matched syntax highlighting, user font settings, and in-place editing.
  - **Markdown Preview**: GitHub-style rendering (headings with rules, code boxes, bordered tables, quote bars, task lists) in a centered, readable 880px max-width column.
  - **SVG Preview**: `prepareSvgPreview` writes an enlarged copy to `cache/file-editor/` so the host rasterizes small icon view boxes crisply, and the preview is drawn on a light canvas so black `currentColor` fallbacks remain visible.
  - **Edge State Banners**: Friendly centered messages for deleted/missing files (`"This file is no longer available"`), binary files (`"Binary file · no text preview"`), or files truncated past 400,000 characters.

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
  - **SEARCH** runs as you type with a ~300ms debounce, off the UI thread, and discards stale scans with a token. `rg --json` is preferred (respecting `.gitignore`; bounded to 1,000 columns, 2 MiB per file and 200 matches per file); without ripgrep it falls back to `grep -rn --null` plus a JS re-match pass (binary skip, `.git`/`node_modules` exclusion, 200 matches per file). Include/exclude globs are applied before the match cap. Both use a 20s timeout; superseded scans are ignored because `exec` has no cancellation handle. Results cap at 2,000 matches / 200 files and show `(limited)`. Partial exit-2 runs keep their matches with a dim warning; unsupported regex dialects read `Regex not supported by search: …`.
  - Clicking a search match opens the file through the normal preview path and passes `find: { query, caseSensitive, wholeWord, regex, line }`; the opened tab shows the find widget with that match current. Double-clicking promotes the preview tab.

- In File Editor tab mode:
  - Reads file text asynchronously off the UI thread with `readTextFile`.
  - Automatically detects language and syntax coloring tokens from Herdr's active theme.
  - Defaults Markdown and SVG files to `"preview"` mode and all other files to `"code"` mode.
  - Allows full editing in Code view, updating line counts dynamically and tracking dirty state against the disk snapshot.
  - Saves file contents atomically (via `writeTextFile` locally or `writeRemoteTextFile` over SSH via `herdr-core` `exec`), triggered by the toolbar `Save` button or `Cmd+S` / `Ctrl+S`, alerting if disk files were modified externally.
  - Watches the workspace directory via `watchFolder` so external edits reload automatically without clobbering active unsaved work.
  - Persists line wrap preferences in `shared("file-editor.wrap")`.
  - Persists the last find query and toggles in `shared("file-editor.find")`; opening find on a Markdown/SVG preview switches to Code view, since the read-only match view is the only surface that can scroll a match into view.
  - Regex anchors match every line, whole-word keeps alternation candidates (`foo|foobar`), and the read-only view slices long lines horizontally to keep the current match visible. A `find` prop is applied once per file, and Escape is scoped to the find widget's key context so it does not swallow Escape elsewhere.
  - `EditorState` has no selection, cursor, scroll-to-line or decoration API, so the find widget renders its own virtualised read-only text view and leaves the native editor state untouched. Editing pauses while find is open; unsaved edits survive.

  - Zooms raster images and SVG previews at 25%–400%; 100% fits the pane and higher levels scroll in both directions.
  - Releasing or closing tabs cleanly frees `EditorState` instances, invalidates watch tokens, and deletes cached preview copies.

## Built from

- `mods/file-editor/`:
  - `main.js`: Main dual-mode View component handling tree navigation, tab management, toolbar interactions, and editor rendering.
  - `file-logic.js`: Pure, deterministic helpers for language mapping, Markdown block parsing, SVG preview preparation, picture zoom levels, location resolution, and tab deduplication.
  - `find-logic.js`: Pure match/search engine (query → regex, match scanning, counters, wrap/step, line lookup, highlight segments, context trimming, globs, rg/grep parsing, grouping/capping, summaries).
  - `find-view.js`: Find bar, virtualised read-only match view and the SEARCH sidebar section.
  - `mod.json`: Herdr mod manifest (`"place": "none"`).
  - Vector SVG icons: `chevron-down.svg`, `chevron-right.svg`, `folder.svg`, `file.svg`, `copy.svg`, `refresh.svg`, `search.svg`, `arrow-up.svg`, `arrow-down.svg`, `close.svg`.

- `gpui-kit` & `gpui-base`: Native GPU elements, flex layouts, `Editor`, `EditorState`, and `TextView.markdown` for inline text.
- `herdr` runtime API: `readTextFile`, `writeTextFile`, `exec`, `appHome`, `watchFolder`, `theme()`, `settings()`, `spaces()`, `panes()`, `focused()`, `run()`, `shared()`, `setShared()`, and `notify()`.

## Watch out

- Keep the mod name `file-editor` stable because assets are loaded from `mods/file-editor/*.svg`.
- `EditorState.new` must never be called inside `render()`. Always instantiate in `loadFile` or event handlers and release previous instances via `this.code?.release()`.
- `EditorState` exposes only `value`, `set_value`, `on` and `release`. Find must not look for selection/cursor/scroll APIs; it owns the read-only match view and must never recreate or `set_value` the editor just because the widget opens or closes.
- Never pass `null` or `undefined` to `.child()` to prevent GPUI rendering panics.

- Never use synchronous event `cx` across an `await`; wrap asynchronous workflows in `cx.spawn(async (cx) => ...)`.
- Per-loop `watchToken` objects invalidate stale background watchers when switching directories or closing views.
- The host rasterizes SVG at its root `width`/`height`, not the layout size; use `prepareSvgPreview` so small view boxes stay crisp, and never draw SVG previews on the app background alone because `currentColor` falls back to black.
- Cache previews live outside `mods/` so writing them does not trigger a mod reload; remove them in `close(_cx)`.

## Done when

- `herdr-app check mods/file-editor` passes with zero errors.
- `node --test test/` passes all unit tests.
- `sync.sh` synchronizes the mod to `~/.config/herdr-app/mods/file-editor`.
- Clicking files in the Files browser opens dedicated Herdr tabs rather than replacing the directory tree.
- `Cmd+F` opens the find widget, highlights matches, steps with wrap-around, and `Esc` returns to the editor with unsaved edits intact.
- `Cmd+Shift+F` expands SEARCH, results group by file, and clicking a match opens the file at that match through the find prop.
- Syntax highlighting and Markdown preview render smoothly.
- SVG previews render crisply on a light canvas, and raster/SVG zoom controls work at every level.
