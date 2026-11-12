# herdr-file-editor

Source of truth for the `file-editor` Herdr app mod (`mods/file-editor/`), published as **File Explorer & Editor**: a dual-mode file explorer panel and tabbed file editor with syntax highlighting, Markdown and SVG previews, picture zoom, in-editor find, workspace search, and live filesystem watching built natively with GPUI.

## Rule: Always Update the Herdr Live Folder

Herdr reads active mods from `~/.config/herdr-app/mods/<name>`. After code changes in this repository, run:

```sh
./sync.sh
```

The script copies `mods/file-editor` to `~/.config/herdr-app/mods/file-editor` and runs `herdr-app check`. Never edit files in `~/.config/herdr-app/mods/` directly.

---

## Dual-Mode Architecture

The mod operates in two distinct modes based on whether `props().file` is provided:

1. **Files Pane Mode (`props().file` not set)**:
   - Renders the workspace file browser tree (`#files-tree`) inside `#files`.
   - Resolves workspace root via `resolveLocation` honoring:
     1. Explicit `props().folder` or `props().cwd`.
     2. Pinned space location (`spaces.pinned_locations[space.id]`).
     3. Focused pane or terminal cwd **only when `focused.space === space.id`**.
     4. Fallback to `space.folder`.
   - Polls location in memory every 250ms so switching active spaces or tabs updates the file tree immediately, in addition to the 10s refresh timer and `watchFolder(root)`.
   - **Active Opened File Selection**: Synchronizes with the currently active or focused tab/pane (via `resolveActiveOpenedFile`, checking `focused`, active space tabs, `openTabs`, and `activeFile`). Highlights the opened file with `.bg(t.selected)` and automatically expands and loads any collapsed parent directories (`getAncestorFolders`) so the selected row is always visible in the tree.
   - **Clicking a file (`!entry.dir`) NEVER opens the file inline or replaces the tree**. It invokes `this.openFileTab(path, cx, options)` which checks existing non-settled tabs, reuses matching tabs via `tab.select`, or opens a new dedicated Herdr tab with `tab.new`. When an empty pane (`new-pane`) is present in the active tab, it places the opened file directly into that empty split (replacing the empty chooser pane with `pane.split` and `pane.close`) instead of creating an unwanted new tab or switching away to an existing tab; if the active tab is a lone empty placeholder tab (`space-pin`), it replaces the placeholder cleanly.
   - **VS Code-style preview tabs**: a single click opens the file as a temporary preview (`file-editor.openTabs[fileKey].preview = true`), shown italic and dimmed in the tree and editor header, and dimmed with a hollow dot in the `tabs-ref` tab bar. Double-clicking the file row (`event.click_count >= 2`) or the tab promotes it to permanent. Opening another preview replaces the previous preview tab in the same space (never when it is the last live tab), reuses its strip position, and an edited, pinned, or split preview is promoted automatically before it can be replaced. `planPreviewOpen` in `file-logic.js` owns the replacement decision so it stays unit-tested. The map is keyed by file, not by space: if the same file is opened in two spaces, its preview record follows the latest open and the other tab remains as an independent permanent tab. Never reuse a tab by basename alone; that could focus a different file.
   - Hovering a row tracks it as `hoveredPath` and reveals a copy-path control immediately after the entry name (folders included); it copies the absolute path through `resolveAbsolutePath` and stops propagation so the click never opens the entry.
   - Right-clicking a row opens `#files-context-menu` at the pointer with `Open file` (files only, through `openFileTab`), `Place in empty pane` (when an empty split pane is available), `Copy path`, `Rename`, and `Delete`. The row records the target and the pane root's bubbled press opens the menu from its pane-local `local_position` through `resolveFilesMenuPosition`, which divides by app zoom and flips or clamps the menu inside the panel, and the `#files-context-backdrop` overlay closes it on any outside press. Renaming opens `#files-rename-dialog` with input validation, duplicate checks, and Escape/Enter shortcuts; deleting opens `#files-delete-dialog` with a confirmation prompt before executing filesystem removal and reloading affected tree directories.
   - The header is now a pair of VS Code-style collapsible sidebar sections: `EXPLORER` (the tree above) and `SEARCH`. Each header has a chevron and persists its open/collapsed state in `shared("file-editor.sections")` (`{ explorer, search }`; Explorer defaults open, SEARCH defaults collapsed). `Cmd+Shift+F` / `Ctrl+Shift+F` (also the search icon in the EXPLORER header) expands SEARCH and focuses its query input. The pane root focuses `filesFocusHandle` on any left press so those keys reach the view.
   - **SEARCH section** (`#files-search-section`): query input with `Aa` / `ab` / `.*` toggles, a `…` toggle revealing comma-separated `files to include` / `files to exclude` glob fields, a `N results in M files` summary (with `(limited)` at the caps) and virtualised results grouped by file. Each file header shows a `fileIconPath` icon, base name, dim relative directory and a match-count badge; clicking it collapses that file. Each match row shows its line number and trimmed/ellipsised context around the highlighted span. Clicking a match calls the existing `openFileTab(path, cx, options)` with a `find` option, preserving preview-tab semantics; two clicks inside the double-click window promote the tab. The click carries `find: { query, caseSensitive, wholeWord, regex, line }` as a tab prop and as `shared("file-editor.pendingFind")` so an already-mounted tab can react. `props().search = { query, caseSensitive, wholeWord, regex, include, exclude }` opens the pane with a prefilled search.
   - Searches are debounced by 300ms, run in `cx.spawn` off the UI thread, and use a per-search token (`searchToken`) so stale scans are discarded, matching the `watchToken` pattern. `rg --json` is used when `rg --version` succeeds (which honours `.gitignore`); otherwise the mod falls back to `grep -rn` and re-runs the pure match engine over each candidate line. Both paths apply include/exclude globs and cap at 2,000 matches / 200 files.


2. **File Editor Tab Mode (`props().file` is a non-empty string)**:
   - Renders a full-size file editor tab (`#file-editor-tab`) for `{ folder, file, on?, viewMode?, wrap?, zoom? }`.
   - Reads file text via `readTextFile` off the UI thread and watches `root` via `watchFolder` so external edits reload automatically without clobbering unsaved dirty changes.
   - Header bar (`h(38)`, `bg(t.chrome)`) provides:
     - Basename with an accent dot indicator (`●`) when unsaved edits are present, italic while the tab is a temporary preview, copy path button, truncated parent path, line count & language pill, and an icon action group with uniform 24px alignment:
     - `Save` icon button (`save.svg`, accent-highlighted when dirty, supporting Cmd/Ctrl+S with descriptive tooltips) or a `Read-only` lock icon indicator (`lock.svg` with reason tooltip).
     - For Markdown files (`.md`, `.markdown`, `.mdx`) and SVG files (`.svg`): segmented `Preview` (eye icon) / `Code` (brackets icon) view switcher defaulting to `"preview"`. In Code view, full text editing and saving are supported.
     - For raster images and SVG previews: zoom controls (`−`, percentage, `+`), a reset-to-fit percentage button, and Cmd/Ctrl + wheel zooming. Zoom runs from 25% to 400%; 100% fits the picture to the pane and larger levels scroll in both directions.
     - In Code view: `Wrap` icon toggle button (`wrap.svg`, and `Alt+Z` / `Opt+Z` keyboard shortcut) toggling soft wrapping on `EditorState` and persisting to `shared("file-editor.wrap")`.
     - `Split right` and `Split down` icon buttons (`split-right.svg`, `split-down.svg`, and `Cmd+\` / `Ctrl+\` keyboard shortcut) splitting the editor pane with `new-pane` chooser (or terminal if `new-pane` is missing).
     - Copy button next to the file name writing current text to the clipboard with a toast notification.
     - Refresh button (`refresh.svg`) reloading from disk and discarding uncommitted edits; automatic background watcher (`watchFolder`) and 1.5s disk change poller update files live when modified by agents, git, or external processes without clobbering dirty edits.
     - Find button (`search.svg`) opening the in-editor find widget. `Cmd+F` / `Ctrl+F` (and the `FileEditor` key context bindings for `Cmd/Ctrl+G`, `F3`, `Shift+F3`) do the same. The widget is docked top-right over the content with a focused query input, `Aa` / `ab` / `.*` toggles (Alt+C / Alt+W / Alt+R), an `N of M` counter (or `No results` / `Invalid regex` with a red input border), previous/next buttons and close. `Enter` / `Shift+Enter` step with wrap-around; `Esc` returns to the native Editor.
     - While find is open the tab renders a read-only virtualised text view (`find-view.js`) instead of the native `Editor`: GPUI's `EditorState` exposes only `value`, `set_value`, `on` and `release`, with no selection, cursor, scroll-to-line, focus or decoration API, so the mod owns matching and highlighting. All matches get a highlight and the current one is scrolled into view through a `VirtualListScrollHandle`; only visible lines are rendered. The native `EditorState` in `this.code` is never recreated or `set_value`'d by opening/closing find, so unsaved edits, cursor and undo state survive. Editing pauses while find is open, as accepted. Markdown/SVG previews switch to Code view when find opens (the read-only view is the only surface that can bring a match into view; documented behaviour). Images have find disabled.

   - Code editing and rendering uses `EditorState.new` with syntax highlighting from `theme()` and font settings. Listens to `change` events for real-time dirty tracking and Cmd/Ctrl+S saving via `writeTextFile` (locally) or `writeRemoteTextFile` (remotely over SSH via `herdr-core` `exec`).
   - **Scroll and View Position Preservation**: Preserves the user's position (scroll, cursor, selection, view mode, zoom, and unsaved edits) across tab switches, view mode toggles, and reopens. Retains active file editor state in a bounded LRU cache (`fileTabStates`), restores cached content immediately on frame 1 to prevent 0-height scroll resets, and assigns deterministic, per-file GPUI element IDs (`fileElementId`) to Editor, Markdown, and picture view containers. Because GPUI's element state manager sweeps ephemeral layout scroll offsets for views unmounted during frame rendering of other tabs, preview scroll and pan offsets (`mdScrollY`, `pictureScrollX`, `pictureScrollY`, `tabViewport`) are tracked directly in memory on the view instance, persisted in `fileTabStates` and `sessionStorage`, and applied through offset positioning (`.top(-mdScrollY)`, `.left(-pictureScrollX).top(-pictureScrollY)`) paired with smooth proportional scrollbars, guaranteeing that switching tabs or spaces always restores the exact scrolled position.
   - Markdown rendering is GitHub-style and built in `mods/file-editor/markdown-view.js`: `parseMarkdownBlocks` (file-logic.js) turns the source into blocks, which are drawn as headings with rules, code boxes, bordered tables, quote bars, list and task markers. Inline text (emphasis, code, links) goes through `TextView.markdown`, which takes no styling of its own.
   - Picture previews use `imageHeaderSize` (raster header parsing) and `prepareSvgPreviewInfo` (SVG root size) to know the picture's aspect ratio. With the pane measured from pointer/wheel bounds, `renderPictureCanvas` sizes it in pixels for an exact fit; before that, a percentage aspect box fits by width using `padding-top` relative to the box width. The preview is top-left aligned when zoomed in, centered at fit, and wrapped in `overflow_scrollbar` for panning; `file-logic.js` owns the level ladder (`IMAGE_ZOOM_LEVELS`, `normalizeImageZoom`, `stepImageZoom`, `imageZoomPercent`).
   - SVG preview writes an enlarged copy of the source into `cache/file-editor/` and draws it with `image()` on a light canvas. The host rasterizes SVG at the root `width`/`height`, so `prepareSvgPreview` (file-logic.js) scales the intrinsic size up while preserving the `viewBox`; the light canvas keeps `currentColor` icons visible on dark themes. The cache copy is refreshed on reload and removed in `close(_cx)`.

## Find & Workspace Search Architecture

- **In-editor find (`find-view.js`, `find-logic.js`)**: `Cmd+F` / `Ctrl+F` opens `#file-find-widget`; the tab root also binds actions in the `FileEditor` key context so the shortcut survives host keymaps. The widget owns the query, toggles, current index and matches on the view (`this.find`), while the pure engine (`findMatches`, `buildFindRegExp`, `stepMatchIndex`, `findMatchIndexAtLine`, `lineMatchSegments`) lives in `find-logic.js`. The last query and toggles persist in `shared("file-editor.find")`. Invalid regexes are reported as data (`{ valid: false, error }`), never thrown. Editing is paused while find is open, and the native `EditorState` is left untouched so unsaved edits survive. Images disable find. Markdown/SVG previews switch to Code when find opens.
- **Search results (`renderSearchSection`)**: the sidebar renders both sections; SEARCH state lives on the view (`this.search`, `this.searchRows`, `this.searchToken`, `this.rgAvailable`) and results are a flat virtual-list row list built by `flattenSearchRows`. Parsing (`parseRgJson`, `parseGrepOutput`, `expandGrepRows`), globbing (`parseGlobList`, `globToRegExp`, `matchesGlob`, `filterSearchRowsByGlobs`), grouping/capping (`groupSearchRows`) and summaries (`formatSearchSummary`) are pure and unit-tested.
- **Opening a result**: `openFileTab` carries `find` through tab props; for an already-open tab it writes `shared("file-editor.pendingFind")`, which `syncTabConfig` consumes. The `line` is 1-based in the prop/search row and converted to the engine's 0-based line before selecting the first match at or after it.


---

## GPUI Invariants & Safety Rules

- **No `null` or `undefined` in `.child()`**: Re-rendering aborts with an error banner if null/undefined is passed to `.child()`. Always use `.when(cond, el => el.child(...))`.
- **No sync `cx` across `await`**: Event handler `cx` is valid only during synchronous delivery. Wrap all async tasks in `cx.spawn(async (cx) => ...)` and use the `AsyncContext`.
- **Never call `EditorState.new` inside `render()`**: Editor instances must be created or updated outside `render()` (in `loadFile` or event handlers). Always call `this.code?.release()` before recreating or in `async close(_cx)`.
- **Watch tokens**: Always use a per-loop `watchToken = {}` so changing directories or files invalidates stale watchers. Clear `watched` and `watchToken` in `close(_cx)` or when switching context.

---

## Validation & Testing

Run the automated test suite and mod validator:

```sh
herdr-app check mods/file-editor && node --test test/
```

- `mods/file-editor/file-logic.js`: Pure functions for path splitting, language detection, view mode defaults, file text preparation, SVG preview preparation (`prepareSvgPreview`, `prepareSvgPreviewInfo`), raster image dimensions (`imageHeaderSize`), picture zoom levels (`normalizeImageZoom`, `stepImageZoom`, `imageZoomPercent`), Markdown block parsing, syntax theming, location resolution, tab resolution, file icon choice (`fileIconPath`), and Files context-menu placement (`resolveFilesMenuPosition`, zoom-aware so the menu stays under the pointer). Icons in `mods/file-editor/icons/` are full-color SVGs from Material Icon Theme (MIT, license in `icons/LICENSE.txt`), drawn with `image()` so their colors survive; `svg()` would tint them with the text color.
- `mods/file-editor/find-logic.js`: Pure find/search engine: literal/regex/whole-word/case query building, match scanning with line/column ids, counter labels, step-with-wrap, query → line lookup, line highlight segments, context trimming, glob parsing/matching, rg JSON and grep output parsing, grep re-matching, grouping/capping, sidebar sections and find props.
- `mods/file-editor/find-view.js`: GPUI rendering for the find bar, the virtualised read-only match view and the SEARCH sidebar section.
- `test/file-logic.test.js`: Unit tests verifying contract, edge cases, and boundaries with `node:test` and `node:assert/strict`.
- `test/find-logic.test.js`: Unit tests for the match engine, regex builder, globs, rg/grep parsing, grouping/capping, counter/step/wrap, context trimming and search props.

---

## Layout Wiring

To replace the default `files` panel block in your personal layout clone (`~/.config/herdr-app/layouts/<name>.json`):

```json
{
  "id": "files",
  "type": "block",
  "content": {
    "mod": "file-editor"
  }
}
```

### Direct Split and Tab Commands

Open the Files browser in a side split:
```sh
herdr-app do pane.split --direction right --mod file-editor
```

Open a specific file directly in a dedicated tab:
```sh
herdr-app do tab.new --name "README.md" --mod file-editor --props '{"folder":"/path/to/repo","file":"README.md"}'
```

Open a code file with soft wrap enabled:
```sh
herdr-app do tab.new --name "main.js" --mod file-editor --props '{"folder":"/path/to/repo","file":"src/main.js","wrap":true}'
```
