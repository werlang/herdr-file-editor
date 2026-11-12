# Herdr File Explorer & Editor

A native, dual-mode **File Explorer & Editor** mod for Herdr featuring directory tree navigation, Git status porcelain badges, dedicated tabbed file viewing, theme-aware syntax highlighting, in-editor find/replace, workspace-wide search/replace, and rich Markdown and SVG previews powered directly by GPUI.

Instead of opening raw code files inside the narrow Files panel, `file-editor` opens files into their own dedicated Herdr tabs with full-pane syntax highlighting and Markdown or SVG rendering, keeping your directory tree accessible and intact.

---

## Features

- **Dual-Mode Operation**:
  - **Files Pane Mode**: Sits in your sidebar panel or split pane, browsing the active space's workspace tree with Git status badges (`A`, `M`, `D`, `U`), folder toggle chevrons, a hover copy-path button, and a right-click menu with `Open file` and `Copy path`.
  - **File Editor Tab Mode**: Opens files in full-size Herdr tabs (`#file-editor-tab`) with a clean 38px toolbar and full reading comfort.
- **Tab Deduplication & Disambiguation**:
  - Clicking a file reuses an existing open tab for that file instead of creating duplicate tabs.
  - Automatically disambiguates files with identical names from different directories (`dir/base`).
- **Empty Pane & Split Placement**:
  - When an empty split pane (`new-pane`) is present in the active tab, opening a file (or choosing `Open file` / `Place in empty pane` in the context menu) places it directly into that empty split instead of creating an unwanted new tab or jumping away to another tab.
  - When opening a file from a lone placeholder tab (`space-pin` / "New tab"), it cleanly replaces the placeholder tab with the opened file.
- **VS Code-style Preview Tabs**:
  - A single click in the Explorer opens a temporary preview tab. Its name is italic and dimmed in the file tree and editor header; with the optional `tabs-ref` tab bar it is also dimmed and carries a hollow preview dot.
  - Double-clicking the file in the Explorer promotes it to a permanent tab (normal name). With `tabs-ref`, double-clicking the tab also promotes it instead of renaming.
  - Opening another file in preview mode replaces the previous temporary tab. Editing a preview, pinning it, or splitting another pane into its tab promotes it automatically, so unsaved work and terminals are never replaced.
- **Interactive File Editing & Saving**:
  - Full-featured in-place editing for code, configuration, Markdown, and SVG files in Code view.
  - Real-time dirty state tracking with an accent unsaved-changes indicator (`●`) beside the filename and updated line counts as you type.
  - Dedicated `Save` button in the header toolbar (highlighted when dirty) and `Cmd+S` / `Ctrl+S` keyboard shortcuts.
  - Atomic snapshot saving with `writeTextFile` locally and chunked atomic writes over SSH via `herdr-core` `exec` to prevent overwriting external disk edits, alerting on conflicts via toast.
  - Watcher safety: background directory watching never clobbers active unsaved edits.
- **Syntax Highlighting & Code View**:
  - Powered by `EditorState` and `Editor` with line numbers, code folding, font family/size configuration, and colors derived dynamically from your active Herdr `theme()`.
  - Supports JavaScript, TypeScript, JSX/TSX, Python, Rust, Go, C/C++, Shell, HTML, CSS, JSON, YAML, TOML, Dockerfile, Makefile, and more.
- **Rendered Markdown Preview**:
  - For `.md`, `.markdown`, and `.mdx` files, defaults to a GitHub-style rendered preview (headings, code, tables, quotes, task lists) inside a centered, readable reading column.
  - Supports switching seamlessly between **Preview** and **Code** modes via a segmented header switcher.
- **Rendered SVG Preview**:
  - For `.svg` files, defaults to a rendered preview on a light canvas so `currentColor` icons stay visible on dark themes.
  - The preview copy is rasterized at a large intrinsic size, keeping small 24×24 icon view boxes crisp when enlarged.
  - Supports the same **Preview** / **Code** switcher, with full SVG source highlighting in Code view.
- **Picture Zoom**:
  - Raster images and SVG previews support zoom controls (`−` / percentage / `+`), a reset-to-fit button, and Cmd/Ctrl + wheel zooming.
  - 100% fits the picture to the pane; larger levels overflow and scroll in both directions.
- **Toolbar Craft**:
  - **Header Info**: Bold basename with unsaved dot (`●`), copy button, truncated folder path, line count & language pill.
  - **Action Controls**: Compact icon buttons with tooltips and uniform 24px vertical alignment:
    - `Save` icon button (`save.svg`), accent-highlighted when dirty, or `Read-only` lock icon indicator (`lock.svg`).
    - `Preview` / `Code` segmented icon switcher (`eye.svg` and `code.svg`) for Markdown and SVG files.
    - `Zoom Controls`: `−` / percentage / `+` for raster images and SVG previews; the percentage resets to fit.
    - `Wrap Toggle`: `wrap.svg` icon button toggling soft line wrapping on and off (via button or `Alt+Z` / `Opt+Z`), remembered in shared settings (`file-editor.wrap`).
    - `Split Actions`: `split-right.svg` and `split-down.svg` icon buttons splitting the editor right (also `Cmd+\` / `Ctrl+\`) or down, opening the `new-pane` chooser.
    - `Find Button`: `search.svg` opening the in-editor find widget (also `Cmd+F` / `Ctrl+F`).
    - `Copy Button`: `copy.svg` button copying file text to the clipboard with an instant toast notification.
    - `Refresh Button`: `refresh.svg` button reloading file contents directly from disk.
- **Live Disk Watching & Polling**:
  - Integrates with `watchFolder` off the UI thread and a 1.5s disk change poll so external modifications by agents or tools automatically update the open tab without clobbering unsaved edits.
- **Find in File**:
  - `Cmd+F` / `Ctrl+F` (or the `search.svg` toolbar button) opens a VS Code-style find bar docked over the editor: focused query input, `Aa` match case, `ab` whole word, `.*` regex (also `Alt+C` / `Alt+W` / `Alt+R`), an `N of M` counter, previous/next, and close.
  - `Enter` / `Shift+Enter`, `F3` / `Shift+F3`, and `Cmd/Ctrl+G` / `Cmd/Ctrl+Shift+G` step through matches with wrap-around; `Esc` closes and returns to the native editor.
  - Every match is highlighted and the current one is scrolled into view, horizontally too when it lies past the pane width. Regex `^`/`$` anchor at every line, whole-word matches backtrack through alternations (`foo|foobar`), and invalid regexes show `Invalid regex` with a red input border instead of throwing. Images disable find.
  - A chevron at the left of the find bar expands a VS Code-style replace row: replace input, `AB` preserve-case toggle, Replace and Replace All. `Cmd+Alt+F` / `Ctrl+H` opens it directly. While the replace input is focused, `Enter` replaces the current match and moves to the next, `Cmd+Enter` / `Ctrl+Alt+Enter` replaces all, and `Cmd+Shift+1` / `Cmd+Alt+Enter` are also accepted. The expanded state, last replacement and preserve-case flag persist in `shared("file-editor.find")`.
  - Regex replacements support `$0` / `$&` (the whole match), `$1`…`$99`, `$$`, `\n`, `\t`, `\\` and the `\u` / `\l` / `\U` / `\L` / `\E` case operations; unknown escapes keep their backslash, so `C:\path` survives. Preserve case follows VS Code: all-upper → upper, all-lower → lower, mixed case adjusts only the first letter (and hyphen/underscore-separated segments are handled per segment). Replacements edit only the in-memory buffer through `set_value`, mark the tab dirty and promote a preview tab; nothing is written until `Cmd+S`. `Cmd+Z` / `Ctrl+Z` while find is open restores the text before the last replace, and does not consume the chord when the replace undo stack is empty. Replace is disabled with a read-only tooltip on binary, image, truncated or unreadable files.
  - The widget renders a read-only, virtualised text view while open because GPUI's `EditorState` has no selection/cursor/decoration API; the native editor state is left untouched, so unsaved edits survive. Markdown and SVG previews switch to Code view when find opens.
  - The last query and toggles persist in `shared("file-editor.find")`.
- **Find in Files (SEARCH sidebar)**:
  - The Files pane now has collapsible `EXPLORER` and `SEARCH` sections (state persisted in `shared("file-editor.sections")`). `Cmd+Shift+F` / `Ctrl+Shift+F` or the search icon expands SEARCH and focuses its input.
  - Search accepts `Aa` / `ab` / `.*` toggles and comma-separated `files to include` / `files to exclude` globs behind a `…` toggle (e.g. `src/**, *.js` and `dist/**`).
  - A summary line reports `N results in M files` (or `No results`, `Invalid regex`, `Searching…`), and results are grouped by file with a file icon, dim relative directory, match-count badge and per-file collapse.
  - Each match row shows its line number and trimmed context with the matched span highlighted. Clicking a result opens the file through the normal preview-tab path and jumps to that match; double-clicking promotes it to permanent.
  - A chevron at the left of the query expands a replace row with a replace input, `AB` preserve-case toggle and Replace All. With the row open, each result shows the VS Code inline diff: the match struck through on a red tint followed by the replacement on a green tint. Hovering a match row reveals Replace and Dismiss; hovering a file header reveals Replace All in file and Dismiss. `Cmd+Shift+1` / `Ctrl+Shift+1` replaces all when the replace row is open and results exist.
  - The SEARCH Replace All button always asks `Replace N occurrences across M files with 'X'?` first, even for one match or one file, like VS Code. The per-row Replace and per-file Replace All hover actions write directly without a dialog. Each file is re-read, the query is recomputed on the fresh content and only targets that still match at the same line/column/length are written. Files changed on disk, unreadable files, files at or above 1 MiB, files whose fresh read contains `\uFFFD` (not valid UTF-8) and files with unsaved editor edits are skipped with the reason in the toast. Writes preserve line endings, the trailing newline and a UTF-8 BOM, use the existing local/remote save paths with a fresh snapshot, and the search re-runs afterwards.
  - Results are rendered in a manual window: only the visible rows plus six rows of overscan are built each frame, with normal per-row hover/click handlers. For 2,000 results in a 400px viewport at 24px rows that is at most 29 rendered rows.
  - Searches are debounced (~300ms), run off the UI thread, and discard stale results with a token. `rg --json` is used when ripgrep exists (respecting `.gitignore`); otherwise the mod falls back to `grep -rn --null` and the pure JS match engine. Glob filtering happens before the match cap, so `*.md` cannot be starved by other files.
  - rg is bounded to 1,000 columns, 1 MiB per file and 200 matches per file; grep skips binaries, `.git` and `node_modules` and caps each file. Both run with a 20s timeout; superseded scans are ignored rather than cancelled (the host `exec` API has no cancellation handle). Partial exit-2 runs keep their parsed matches and show a dim warning, and unsupported regex dialects are reported as `Regex not supported by search: …`. Results cap at 2,000 matches / 200 files with a visible `(limited)` note.

- **Edge Case & Safety Protections**:
  - Friendly warnings for deleted or missing files (`"This file is no longer available"`).
  - Binary file detection (`"Binary file · no text preview"`).
  - Graceful truncation of files exceeding 400,000 characters.
  - Replace in files skips files at or above 1 MiB and reads containing `\uFFFD` (not valid UTF-8), so a truncated or lossy read is never written back. A UTF-8 BOM is preserved.
  - Known limitation: remote writes use a temp file + `mv -f`, which may drop the target file's mode; a portable mode copy is not attempted.

---

## Requirements

- Herdr desktop app (`herdr-app`).
- Git installed on your system.
- Node.js (v18+) for running unit tests.
- Optional: ripgrep (`rg`) for fast, `.gitignore`-aware Find in Files. Without it, the mod falls back to `grep -rn`.

---

## Usage

### Replace the Files panel

In your personal Herdr layout clone (e.g. `~/.config/herdr-app/layouts/my-layout.json`), point the `files` block at `file-editor`:

```json
{
  "id": "files",
  "type": "block",
  "content": {
    "mod": "file-editor"
  }
}
```

This replaces the default `files` panel with `file-editor`. The directory tree behaves identically, but clicking any file opens it in a dedicated tab rather than taking over the sidebar. Single-click opens a temporary preview tab (italic); double-click the file or its tab keeps it open permanently.

### Open Files Browser in a Split Pane

```sh
herdr-app do pane.split --direction right --mod file-editor
```

Or target a specific workspace folder:

```sh
herdr-app do pane.split --direction right --mod file-editor --props '{"folder":"/path/to/project"}'
```

### Open a File Tab Directly

Open any file in a dedicated tab:

```sh
herdr-app do tab.new --name "README.md" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"README.md"}'
```

Open a code file with soft wrap enabled:

```sh
herdr-app do tab.new --name "main.js" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"src/main.js","wrap":true}'
```

Force Code view for a Markdown document:

```sh
herdr-app do tab.new --name "CHANGELOG.md" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"CHANGELOG.md","viewMode":"code"}'
```

Open an SVG in its rendered preview (the default) at 150% zoom:

```sh
herdr-app do tab.new --name "icon.svg" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"assets/icon.svg","zoom":1.5}'
```

Force Code view for an SVG:

```sh
herdr-app do tab.new --name "icon.svg" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"assets/icon.svg","viewMode":"code"}'
```

Open a file with the find widget already searching for `render`:

```sh
herdr-app do tab.new --name "main.js" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"src/main.js","find":{"query":"render","caseSensitive":true}}'
```

Open the find bar with the replace row expanded and a replacement prefilled:

```sh
herdr-app do tab.new --name "main.js" --mod file-editor \
  --props '{"folder":"/path/to/project","file":"src/main.js","find":{"query":"render","replace":"draw","replaceOpen":true,"preserveCase":true}}'
```

Open the Files pane with the SEARCH section expanded and a query running:

```sh
herdr-app do tab.new --name "search" --mod file-editor \
  --props '{"folder":"/path/to/project","search":{"query":"render","include":"src/**, *.js","exclude":"dist/**"}}'
```

Open SEARCH with the replace row and its inline diff:

```sh
herdr-app do tab.new --name "replace" --mod file-editor \
  --props '{"folder":"/path/to/project","search":{"query":"render","replace":"draw","replaceOpen":true}}'
```

`find` also accepts `wholeWord`, `regex`, `line` (1-based), `replace`, `replaceOpen` and `preserveCase`. `search` also accepts `wholeWord`, `regex`, `replace`, `replaceOpen` and `preserveCase`. For screenshots or UI automation, `search.replaceDialog: true` (with `replaceOpen: true`) opens the Replace All confirmation for the settled results; it only opens the dialog and never writes anything.

### Find & Search Shortcuts

| Action | Shortcut |
| --- | --- |
| Find in file | `Cmd+F` / `Ctrl+F`, or the `search.svg` toolbar button |
| Find and replace in file | `Cmd+Alt+F` / `Ctrl+H` |
| Replace current match (replace input focused) | `Enter`, or `Cmd+Shift+1` |
| Replace all in file (replace input focused) | `Cmd+Enter`, `Ctrl+Alt+Enter`, or `Cmd+Alt+Enter` |
| Undo last replace while find is open | `Cmd+Z` / `Ctrl+Z` |
| Next / previous match | `Enter` / `Shift+Enter`, `F3` / `Shift+F3`, `Cmd/Ctrl+G` / `Cmd/Ctrl+Shift+G` |
| Close find | `Esc` |
| Toggle match case / whole word / regex | `Alt+C` / `Alt+W` / `Alt+R` (or the `Aa` / `ab` / `.*` buttons) |
| Find in files | `Cmd+Shift+F` / `Ctrl+Shift+F`, or the search icon in the EXPLORER header |
| Replace all in files | `Cmd+Shift+1` / `Ctrl+Shift+1` when the SEARCH replace row is open and results exist |

---

## Testing

Run the automated test suite with Node's native test runner:

```sh
node --test test/
```

Run mod syntax and manifest validation:

```sh
herdr-app check mods/file-editor
```

---

## Install & Sync

To install or sync the mod into your live Herdr configuration:

```sh
./sync.sh
```

Then check that the mod passes validation:

```sh
herdr-app check ~/.config/herdr-app/mods/file-editor
```

---

## Publishing to Herdr Marketplace

To publish `file-editor` to the Herdr marketplace (`herdr.dev/mods`):

1. Keep `mods/file-editor/` at the repository root.
2. Ensure `RECIPE.md` and `preview.png` are present.
3. Tag the repository with the GitHub topic `herdr-mod`:
   ```sh
   gh repo edit --add-topic herdr-mod
   ```
4. Verify repository visibility and metadata:
   ```sh
   gh repo view --json visibility,repositoryTopics,defaultBranchRef
   ```
