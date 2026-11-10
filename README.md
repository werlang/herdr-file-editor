# Herdr File Explorer & Editor

A native, dual-mode **File Explorer & Editor** mod for Herdr featuring directory tree navigation, Git status porcelain badges, dedicated tabbed file viewing, theme-aware syntax highlighting, and rich Markdown and SVG previews powered directly by GPUI.

Instead of opening raw code files inside the narrow Files panel, `file-editor` opens files into their own dedicated Herdr tabs with full-pane syntax highlighting and Markdown or SVG rendering, keeping your directory tree accessible and intact.

---

## Features

- **Dual-Mode Operation**:
  - **Files Pane Mode**: Sits in your sidebar panel or split pane, browsing the active space's workspace tree with Git status badges (`A`, `M`, `D`, `U`), folder toggle chevrons, a hover copy-path button, and a right-click menu with `Open file` and `Copy path`.
  - **File Editor Tab Mode**: Opens files in full-size Herdr tabs (`#file-editor-tab`) with a clean 38px toolbar and full reading comfort.
- **Tab Deduplication & Disambiguation**:
  - Clicking a file reuses an existing open tab for that file instead of creating duplicate tabs.
  - Automatically disambiguates files with identical names from different directories (`dir/base`).
- **VS Code-style Preview Tabs**:
  - A single click in the Explorer opens a temporary preview tab, shown with an italic name in the file tree and editor header; with the optional `tabs-ref` tab bar, the tab label is italic too.
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
    - `Copy Button`: `copy.svg` button copying file text to the clipboard with an instant toast notification.
    - `Refresh Button`: `refresh.svg` button reloading file contents directly from disk.
- **Live Disk Watching & Polling**:
  - Integrates with `watchFolder` off the UI thread and a 1.5s disk change poll so external modifications by agents or tools automatically update the open tab without clobbering unsaved edits.
- **Edge Case & Safety Protections**:
  - Friendly warnings for deleted or missing files (`"This file is no longer available"`).
  - Binary file detection (`"Binary file · no text preview"`).
  - Graceful truncation of files exceeding 400,000 characters.

---

## Requirements

- Herdr desktop app (`herdr-app`).
- Git installed on your system.
- Node.js (v18+) for running unit tests.

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
