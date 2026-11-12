/**
 * GPUI rendering for the File Editor's two Find surfaces:
 *
 * - `renderFindBar` / `renderFindCodeView`: the VS Code-style in-editor find
 *   widget and the read-only, highlighted, virtualised text view shown while
 *   it is open.
 * - `renderSearchSection`: the collapsible SEARCH sidebar section with its
 *   filters, summary and virtualised grouped results.
 *
 * These functions read the owning view's state and call its handlers. No state
 * is created here: `InputState`, `VirtualListScrollHandle` and query results all
 * belong to the view and are built outside `render()`.
 */

import { div, image, svg } from "gpui-kit";
import { h_flex, Input, Scrollbar, v_flex, v_virtual_list } from "gpui-base";
import {
  FIND_LINE_HEIGHT,
  SEARCH_ROW_HEIGHT,
  describeFindCounter,
  formatSearchSummary,
  lineMatchSegments,
  searchWindow,
  trimMatchContext,
} from "./find-logic.js";
import { fileIconPath, isLightColor } from "./file-logic.js";

/** Height of a Files pane section header, in pixels. */
const SECTION_HEADER_HEIGHT = 30;

/** Width of the line-number gutter in the read-only find view, in pixels. */
const FIND_GUTTER_WIDTH = 48;

/**
 * Renders one of the Files pane's collapsible section headers.
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   open: boolean,
 *   onToggle: (cx: import("gpui-kit").ViewContext) => void,
 *   t: Record<string, string>,
 *   trailing?: import("gpui-kit").Element | null,
 * }} options
 * @returns {import("gpui-kit").Element}
 */
export function renderSidebarSectionHeader({ id, label, open, onToggle, t, trailing = null }) {
  return h_flex()
    .id(id)
    .h(SECTION_HEADER_HEIGHT)
    .flex_none()
    .px(10)
    .gap(6)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_event, cx) => onToggle(cx))
    .child(
      svg(`mods/file-editor/chevron-${open ? "down" : "right"}.svg`)
        .size(10)
        .flex_none()
        .text_color(t.dim)
    )
    .child(
      div()
        .text_size(10.5)
        .font_semibold()
        .text_color(t.muted)
        .child(label)
    )
    .child(div().flex_1())
    .when(Boolean(trailing), (el) => el.child(trailing));
}

/**
 * A compact icon button used by both find surfaces.
 *
 * @param {{
 *   id: string,
 *   icon: string,
 *   tooltip: string,
 *   t: Record<string, string>,
 *   onClick: (cx: import("gpui-kit").ViewContext) => void,
 *   disabled?: boolean,
 * }} options
 * @returns {import("gpui-kit").Element}
 */
function findIconButton({ id, icon, tooltip, t, onClick, disabled = false }) {
  return h_flex()
    .id(id)
    .w(22)
    .h(22)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(4)
    .cursor_pointer()
    .when(disabled, (el) => el.cursor_default())
    .text_color(t.dim)
    .when(!disabled, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .when(disabled, (el) => el.opacity(0.35))
    .tooltip(tooltip)
    .on_click((_event, cx) => {
      if (!disabled) onClick(cx);
    })
    .child(svg(icon).size(12));
}

/**
 * A text toggle such as `Aa`, `ab` or `.*`.
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   tooltip: string,
 *   active: boolean,
 *   t: Record<string, string>,
 *   onClick: (cx: import("gpui-kit").ViewContext) => void,
 * }} options
 * @returns {import("gpui-kit").Element}
 */
function findToggle({ id, label, tooltip, active, t, onClick }) {
  return h_flex()
    .id(id)
    .w(22)
    .h(22)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(4)
    .cursor_pointer()
    .text_size(10.5)
    .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
    .when(!active, (el) => el.text_color(t.dim))
    .hover((s) => s.bg(active ? t.selected : t.hover))
    .tooltip(tooltip)
    .on_click((_event, cx) => onClick(cx))
    .child(label);
}

/**
 * The docked in-editor find bar: query, match toggles, counter, step buttons
 * and close, plus the optional second replace row.
 *
 * @param {Record<string, any>} view The owning FileEditor view.
 * @param {Record<string, string>} t
 * @returns {import("gpui-kit").Element}
 */
export function renderFindBar(view, t) {
  const find = view.find;
  const query = find?.query ?? "";
  const invalid = query.length > 0 && find?.valid === false;
  const noResults = query.length > 0 && find?.valid !== false && (find?.matches?.length ?? 0) === 0;
  const borderColor = invalid || noResults ? t.blocked || "#e05252" : t.border;
  const counter = describeFindCounter(find?.current ?? -1, find?.matches?.length ?? 0, {
    empty: query.length === 0,
    valid: find?.valid !== false,
    limited: find?.limited === true,
  });
  const counterColor = invalid || noResults ? t.blocked || "#e05252" : t.muted;
  const hasMatches = (find?.matches?.length ?? 0) > 0;
  const hasCurrent = hasMatches && (find?.current ?? -1) >= 0;
  const replaceOpen = find?.replaceOpen === true;
  const readonly = view.isReadonly();
  const readonlyReason = readonly ? view.readonlyReason() || "Read-only" : "";
  const canEdit = Boolean(view.code) && !readonly;
  const editBlockedReason = readonlyReason || (!view.code ? "Editor is still loading" : "");
  const replaceDisabled = !canEdit || !hasCurrent;
  const replaceAllDisabled = !canEdit || !hasMatches;

  return v_flex()
    .id("file-find-widget")
    .absolute()
    .top(8)
    .right(16)
    .w(446)
    .max_w("92%")
    .p(5)
    .gap(2)
    .rounded(7)
    .bg(t.popover)
    .border_1()
    .border_color(t.border)
    .shadow_lg()
    .key_context("FileEditorFind")
    .on_key_down((event, cx) => view.handleFindWidgetKeyDown(event, cx))
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .child(
      h_flex()
        .gap(2)
        .items_center()
        .child(
          findIconButton({
            id: "file-find-replace-toggle",
            icon: `mods/file-editor/chevron-${replaceOpen ? "down" : "right"}.svg`,
            tooltip: replaceOpen ? "Hide Replace (Cmd+Alt+F)" : "Show Replace (Cmd+Alt+F)",
            t,
            onClick: (cx) => view.toggleFindReplace(cx),
          })
        )
        .child(
          Input.new(view.findInput)
            .id("file-find-input")
            .h(24)
            .flex_1()
            .min_w(0)
            .px(7)
            .rounded(4)
            .border_1()
            .border_color(borderColor)
            .bg(t.background)
            .text_size(12)
            .text_color(t.foreground)
        )
        .child(
          findToggle({
            id: "file-find-case",
            label: "Aa",
            tooltip: "Match case (Alt+C)",
            active: find?.caseSensitive === true,
            t,
            onClick: (cx) => view.toggleFindOption("caseSensitive", cx),
          })
        )
        .child(
          findToggle({
            id: "file-find-word",
            label: "ab",
            tooltip: "Match whole word (Alt+W)",
            active: find?.wholeWord === true,
            t,
            onClick: (cx) => view.toggleFindOption("wholeWord", cx),
          })
        )
        .child(
          findToggle({
            id: "file-find-regex",
            label: ".*",
            tooltip: "Use regular expression (Alt+R)",
            active: find?.regex === true,
            t,
            onClick: (cx) => view.toggleFindOption("regex", cx),
          })
        )
        .child(
          div()
            .min_w(56)
            .flex_none()
            .text_center()
            .text_size(10.5)
            .text_color(counterColor)
            .child(counter)
        )
        .child(
          findIconButton({
            id: "file-find-prev",
            icon: "mods/file-editor/arrow-up.svg",
            tooltip: "Previous match (Shift+Enter / Shift+F3)",
            t,
            disabled: !hasMatches,
            onClick: (cx) => view.stepFind(-1, cx),
          })
        )
        .child(
          findIconButton({
            id: "file-find-next",
            icon: "mods/file-editor/arrow-down.svg",
            tooltip: "Next match (Enter / F3)",
            t,
            disabled: !hasMatches,
            onClick: (cx) => view.stepFind(1, cx),
          })
        )
        .child(
          findIconButton({
            id: "file-find-close",
            icon: "mods/file-editor/close.svg",
            tooltip: "Close find (Esc)",
            t,
            onClick: (cx) => view.closeFind(cx),
          })
        )
    )
    .when(replaceOpen, (el) =>
      el.child(
        h_flex()
          .gap(2)
          .items_center()
          .child(div().w(22).flex_none())
          .child(
            Input.new(view.replaceInput)
              .id("file-find-replace-input")
              .h(24)
              .flex_1()
              .min_w(0)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground)
          )
          .child(
            findToggle({
              id: "file-find-preserve-case",
              label: "AB",
              tooltip: "Preserve case (foo → bar, Foo → Bar, FOO → BAR)",
              active: find?.preserveCase === true,
              t,
              onClick: (cx) => view.togglePreserveCase(cx),
            })
          )
          .child(
            findIconButton({
              id: "file-find-replace",
              icon: "mods/file-editor/replace.svg",
              tooltip: replaceDisabled
                ? editBlockedReason || "No current match to replace"
                : "Replace (Enter)",
              t,
              disabled: replaceDisabled,
              onClick: (cx) => view.replaceCurrentMatch(cx),
            })
          )
          .child(
            findIconButton({
              id: "file-find-replace-all",
              icon: "mods/file-editor/replace-all.svg",
              tooltip: replaceAllDisabled
                ? editBlockedReason || "No matches to replace"
                : "Replace All (Cmd+Enter)",
              t,
              disabled: replaceAllDisabled,
              onClick: (cx) => view.replaceAllInEditor(cx),
            })
          )
      )
    );
}

/**
 * Renders one virtualised line of the read-only find view. Callers must not
 * register handlers here: the virtual list renderer runs during layout.
 *
 * @param {number} index
 * @param {string} lineText
 * @param {Array<Record<string, any>>} matches
 * @param {number} current
 * @param {boolean} isCurrentLine
 * @param {Record<string, string>} t
 * @param {string} codeFont
 * @param {number} scrollColumn Character offset that keeps the current match visible.
 * @returns {import("gpui-kit").Element}
 */
function renderFindLine(index, lineText, matches, current, isCurrentLine, t, codeFont, scrollColumn) {
  const offset = Math.max(0, Math.min(lineText.length, scrollColumn || 0));
  const visibleText = offset > 0 ? lineText.slice(offset) : lineText;
  const lineMatches = (Array.isArray(matches) ? matches : [])
    .filter((match) => match.line === index && match.column + match.length > offset)
    .map((match) => ({ ...match, column: match.column - offset }));
  const segments = lineMatchSegments(visibleText, lineMatches, index, current);
  return h_flex()
    .h(FIND_LINE_HEIGHT)
    .w_full()
    .flex_none()
    .items_center()
    .when(isCurrentLine, (el) => el.bg(t.raised))
    .child(
      div()
        .w(FIND_GUTTER_WIDTH)
        .flex_none()
        .pr(10)
        .text_right()
        .text_size(11)
        .text_color(t.dim)
        .child(String(index + 1))
    )
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .overflow_hidden()
        .items_center()
        .whitespace_nowrap()
        .font_family(codeFont)
        .text_size(12.5)
        .text_color(t.foreground)
        .when(offset > 0, (el) => el.child(div().flex_none().text_color(t.dim).child("…")))
        .children(
          segments.map((segment) =>
            div()
              .flex_none()
              .whitespace_nowrap()
              .when(segment.text === "", (el) => el.child(" "))
              .when(segment.text !== "", (el) => el.child(segment.text))
              .when(segment.highlight && !segment.current, (el) =>
                el.bg(t.ansi3 || t.selected).text_color(t.background)
              )
              .when(segment.highlight && segment.current, (el) => el.bg(t.accent).text_color(t.background))
          )
        )
    );
}

/**
 * The read-only, highlighted text view that replaces the native Editor while
 * the find widget is open. The native `EditorState` has no selection/cursor API,
 * so matches are drawn here and the list scroll handle brings the current one
 * on screen. Only visible lines are rendered.
 *
 * @param {Record<string, any>} view
 * @param {Record<string, string>} t
 * @param {string} codeFont
 * @returns {import("gpui-kit").Element}
 */
export function renderFindCodeView(view, t, codeFont) {
  const text = view.findSourceText();
  const lines = text.split("\n");
  const lineCount = Math.max(1, lines.length - (text.endsWith("\n") ? 1 : 0));
  const matches = view.find?.matches ?? [];
  const current = view.find?.current ?? -1;
  const currentLine = matches[current]?.line ?? -1;
  const scrollColumn = view.find?.scrollColumn ?? 0;

  return v_flex()
    .id("file-find-code")
    .relative()
    .flex_1()
    .min_h(0)
    .bg(t.background)
    .child(
      v_virtual_list(
        "file-find-lines",
        lineCount,
        FIND_LINE_HEIGHT,
        (index) => `find-line-${index}`,
        (range) => {
          const out = [];
          for (let index = range.start; index < range.end; index += 1) {
            out.push(
              renderFindLine(index, lines[index] ?? "", matches, current, index === currentLine, t, codeFont, scrollColumn)
            );
          }
          return out;
        }
      )
        .track_scroll(view.findScrollHandle)
        .size_full()
    )
    .child(Scrollbar.vertical("file-find-lines").absolute().inset_0());
}

/**
 * A compact icon button used by a SEARCH result row's hover actions.
 *
 * @param {{
 *   id: string,
 *   icon: string,
 *   tooltip: string,
 *   t: Record<string, string>,
 *   onClick: (cx: import("gpui-kit").ViewContext) => void,
 * }} options
 * @returns {import("gpui-kit").Element}
 */
function searchActionButton({ id, icon, tooltip, t, onClick }) {
  return h_flex()
    .id(id)
    .w(18)
    .h(18)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(4)
    .cursor_pointer()
    .text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tooltip)
    .on_click((_event, cx) => onClick(cx))
    .child(svg(icon).size(11));
}

/**
 * Renders one search result row: a collapsible file header or a match line.
 *
 * Result rows are plain list rows rather than virtual-list items so they can
 * own their hover actions: GPUI refuses event handlers inside a virtual list
 * renderer. Hovering a row sets `view.searchHoveredRow`, which reveals the
 * Replace/Dismiss buttons. Clicking anywhere else on the row keeps the
 * existing open-file / collapse behaviour.
 *
 * @param {Record<string, any>} view
 * @param {Record<string, any>} row
 * @param {Record<string, string>} t
 * @param {boolean} light
 * @param {Set<string>} collapsedFiles
 * @returns {import("gpui-kit").Element}
 */
function renderSearchRow(view, row, t, light, collapsedFiles) {
  const replaceOpen = view.search?.replaceOpen === true;
  const hovered = view.searchHoveredRow === row.key;
  const showActions = replaceOpen && hovered;
  const red = t.ansi1 || t.blocked || "#e05252";
  const green = t.ansi2 || t.accent || "#4ea36f";

  if (row.kind === "group") {
    const group = row.group;
    const collapsed = collapsedFiles.has(group.file);
    return h_flex()
      .id(row.key)
      .h(SEARCH_ROW_HEIGHT)
      .w_full()
      .flex_none()
      .gap(5)
      .pl(4)
      .pr(8)
      .items_center()
      .rounded(4)
      .bg(t.chrome)
      .on_hover((isHovered, cx) => view.setSearchHoveredRow(row.key, isHovered, cx))
      .on_click((_event, cx) => view.onSearchRowClick(row.key, cx))
      .child(
        svg(`mods/file-editor/chevron-${collapsed ? "right" : "down"}.svg`)
          .size(9)
          .flex_none()
          .text_color(t.dim)
      )
      .child(image(fileIconPath(group.name, light)).size(13).flex_none())
      .child(
        div()
          .flex_none()
          .max_w("55%")
          .truncate()
          .text_size(12)
          .font_semibold()
          .text_color(t.foreground)
          .child(group.name)
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(10.5)
          .text_color(t.dim)
          .child(group.dir)
      )
      .child(
        div()
          .flex_none()
          .min_w(18)
          .px(3)
          .text_center()
          .rounded(8)
          .bg(t.raised)
          .text_size(9.5)
          .text_color(t.muted)
          .child(String(group.count))
      )
      .when(showActions, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .gap(2)
            .child(
              searchActionButton({
                id: `${row.key}:replace-all`,
                icon: "mods/file-editor/replace-all.svg",
                tooltip: `Replace all in ${group.name}`,
                t,
                onClick: (cx) => {
                  cx.stop_propagation();
                  view.replaceAllInFile(group, cx);
                },
              })
            )
            .child(
              searchActionButton({
                id: `${row.key}:dismiss`,
                icon: "mods/file-editor/close.svg",
                tooltip: "Dismiss this file from results",
                t,
                onClick: (cx) => {
                  cx.stop_propagation();
                  view.dismissSearchGroup(group, cx);
                },
              })
            )
        )
      );
  }

  const match = row.match;
  const trimmed = trimMatchContext(match.text, match.column, match.length);
  const before = trimmed.text.slice(0, trimmed.matchStart);
  const highlighted = trimmed.text.slice(trimmed.matchStart, trimmed.matchStart + trimmed.matchLength);
  const after = trimmed.text.slice(trimmed.matchStart + trimmed.matchLength);
  const diff = replaceOpen ? view.searchRowDiff(row.group, match, trimmed.matchLength) : null;

  return h_flex()
    .id(row.key)
    .h(SEARCH_ROW_HEIGHT)
    .w_full()
    .flex_none()
    .gap(4)
    .pl(12)
    .pr(8)
    .items_center()
    .rounded(4)
    .hover((s) => s.bg(t.hover))
    .on_hover((isHovered, cx) => view.setSearchHoveredRow(row.key, isHovered, cx))
    .on_click((_event, cx) => view.onSearchRowClick(row.key, cx))
    .child(
      div()
        .w(34)
        .flex_none()
        .text_right()
        .text_size(10)
        .text_color(t.dim)
        .child(String(match.line))
    )
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .overflow_hidden()
        .items_center()
        .whitespace_nowrap()
        .text_size(11)
        .text_color(t.muted)
        .when(trimmed.leadingEllipsis, (el) => el.child(div().flex_none().text_color(t.dim).child("…")))
        .when(before.length > 0, (el) => el.child(div().flex_none().whitespace_nowrap().child(before)))
        .when(Boolean(diff) && diff.length > 0, (el) =>
          el.children(
            diff.map((segment) =>
              div()
                .flex_none()
                .whitespace_nowrap()
                .rounded(2)
                .when(segment.kind === "removed", (d) =>
                  d.bg(`${red}22`).text_color(red).line_through()
                )
                .when(segment.kind === "inserted", (d) => d.bg(`${green}22`).text_color(green))
                .child(segment.text)
            )
          )
        )
        .when(!diff && highlighted.length > 0, (el) =>
          el.child(
            div()
              .flex_none()
              .whitespace_nowrap()
              .rounded(2)
              .bg(t.ansi3 || t.selected)
              .text_color(t.background)
              .child(highlighted)
          )
        )
        .when(after.length > 0, (el) => el.child(div().flex_none().whitespace_nowrap().child(after)))
        .when(trimmed.trailingEllipsis, (el) => el.child(div().flex_none().text_color(t.dim).child("…")))
    )
    .when(showActions, (el) =>
      el.child(
        h_flex()
          .flex_none()
          .gap(2)
          .child(
            searchActionButton({
              id: `${row.key}:replace`,
              icon: "mods/file-editor/replace.svg",
              tooltip: "Replace this match",
              t,
              onClick: (cx) => {
                cx.stop_propagation();
                view.replaceOneSearchMatch(row.group, match, cx);
              },
            })
          )
          .child(
            searchActionButton({
              id: `${row.key}:dismiss`,
              icon: "mods/file-editor/close.svg",
              tooltip: "Dismiss this match",
              t,
              onClick: (cx) => {
                cx.stop_propagation();
                view.dismissSearchMatch(row.group, match, cx);
              },
            })
          )
      )
    );
}

/**
 * The collapsible SEARCH section of the Files pane: query, toggles, include and
 * exclude filters, summary and grouped virtualised results.
 *
 * @param {Record<string, any>} view
 * @param {Record<string, string>} t
 * @returns {import("gpui-kit").Element}
 */
export function renderSearchSection(view, t) {
  const open = view.sections?.search === true;
  const search = view.search;
  const light = isLightColor(t.background);
  const summary = formatSearchSummary({
    query: search?.query ?? "",
    totalMatches: search?.totalMatches ?? 0,
    totalFiles: search?.totalFiles ?? 0,
    limited: search?.limited === true,
    valid: search?.valid !== false,
    error: search?.error ?? null,
    running: search?.running === true,
  });
  const rows = view.searchRows ?? [];
  const searchQueryEmpty = (search?.query?.trim().length ?? 0) === 0;
  const invalid = !searchQueryEmpty && search?.valid === false;
  const replaceOpen = search?.replaceOpen === true;
  const hasResults = (search?.totalMatches ?? 0) > 0;
  const canReplaceAll = hasResults && search?.running !== true && search?.valid !== false;

  const body = v_flex()
    .flex_1()
    .min_h(0)
    .px(8)
    .pb(8)
    .gap(6)
    .child(
      h_flex()
        .gap(1)
        .items_center()
        .child(
          findIconButton({
            id: "files-search-replace-toggle",
            icon: `mods/file-editor/chevron-${replaceOpen ? "down" : "right"}.svg`,
            tooltip: replaceOpen ? "Hide Replace" : "Show Replace",
            t,
            onClick: (cx) => view.toggleSearchReplace(cx),
          })
        )
        .child(
          Input.new(view.searchInput)
            .id("files-search-input")
            .h(26)
            .flex_1()
            .min_w(0)
            .px(7)
            .rounded(4)
            .border_1()
            .border_color(invalid ? t.blocked || "#e05252" : t.border)
            .bg(t.background)
            .text_size(12)
            .text_color(t.foreground)
        )
        .child(
          findToggle({
            id: "files-search-case",
            label: "Aa",
            tooltip: "Match case",
            active: search?.caseSensitive === true,
            t,
            onClick: (cx) => view.toggleSearchOption("caseSensitive", cx),
          })
        )
        .child(
          findToggle({
            id: "files-search-word",
            label: "ab",
            tooltip: "Match whole word",
            active: search?.wholeWord === true,
            t,
            onClick: (cx) => view.toggleSearchOption("wholeWord", cx),
          })
        )
        .child(
          findToggle({
            id: "files-search-regex",
            label: ".*",
            tooltip: "Use regular expression",
            active: search?.regex === true,
            t,
            onClick: (cx) => view.toggleSearchOption("regex", cx),
          })
        )
        .child(
          findToggle({
            id: "files-search-filters",
            label: "…",
            tooltip: "Toggle files to include / exclude",
            active: search?.filtersOpen === true,
            t,
            onClick: (cx) => view.toggleSearchFilters(cx),
          })
        )
    )
    .when(replaceOpen, (el) =>
      el.child(
        h_flex()
          .gap(1)
          .items_center()
          .pl(23)
          .child(
            Input.new(view.searchReplaceInput)
              .id("files-search-replace-input")
              .h(26)
              .flex_1()
              .min_w(0)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground)
          )
          .child(
            findToggle({
              id: "files-search-preserve-case",
              label: "AB",
              tooltip: "Preserve case (foo → bar, Foo → Bar, FOO → BAR)",
              active: search?.preserveCase === true,
              t,
              onClick: (cx) => view.toggleSearchPreserveCase(cx),
            })
          )
          .child(
            findIconButton({
              id: "files-search-replace-all",
              icon: "mods/file-editor/replace-all.svg",
              tooltip: canReplaceAll
                ? "Replace all (Cmd+Shift+1)"
                : "No results to replace",
              t,
              disabled: !canReplaceAll,
              onClick: (cx) => view.replaceAllInFiles(cx),
            })
          )
      )
    )
    .when(search?.filtersOpen === true, (el) =>
      el.child(
        v_flex()
          .gap(4)
          .child(
            Input.new(view.includeInput)
              .id("files-search-include")
              .h(24)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .text_size(11.5)
              .text_color(t.foreground)
          )
          .child(
            Input.new(view.excludeInput)
              .id("files-search-exclude")
              .h(24)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .text_size(11.5)
              .text_color(t.foreground)
          )
      )
    )
    .when(Boolean(summary), (el) =>
      el.child(
        div()
          .text_size(10.5)
          .text_color(invalid || search?.error ? t.blocked || "#e05252" : t.muted)
          .child(summary)
      )
    )
    .when(Boolean(search?.warning), (el) =>
      el.child(
        div()
          .text_size(9.5)
          .text_color(t.dim)
          .child(search.warning)
      )
    )
    .when(rows.length > 0, (el) => {
      const viewport = view.searchViewportHeight || 240;
      const windowInfo = searchWindow(
        rows.length,
        view.searchScrollY,
        viewport,
        SEARCH_ROW_HEIGHT,
        6
      );
      const windowRows = rows.slice(windowInfo.start, windowInfo.end);
      const contentHeight = Math.max(1, rows.length * SEARCH_ROW_HEIGHT);
      const thumbH = Math.max(28, Math.round((viewport / contentHeight) * viewport));
      const thumbTop =
        windowInfo.maxScroll > 0
          ? Math.round((windowInfo.offset / windowInfo.maxScroll) * Math.max(0, viewport - thumbH))
          : 0;

      return el.child(
        div()
          .id("file-search-results")
          .relative()
          .flex_1()
          .min_h(0)
          .overflow_hidden()
          .on_size_change((size, cx) => view.updateSearchViewport(size, cx))
          .on_scroll_wheel((event, cx) => view.handleSearchWheel(event, cx))
          .child(
            v_flex()
              .relative()
              .top(-windowInfo.offset)
              .w_full()
              .child(div().h(windowInfo.top))
              .children(
                windowRows.map((row) =>
                  renderSearchRow(view, row, t, light, view.search.collapsedFiles)
                )
              )
              .child(div().h(windowInfo.bottom))
          )
          .when(windowInfo.maxScroll > 0, (e) =>
            e.child(
              div()
                .absolute()
                .right(3)
                .top(thumbTop)
                .w(4)
                .h(thumbH)
                .rounded(2)
                .bg(t.dim)
                .opacity(0.6)
            )
          )
      );
    })
    .when(rows.length === 0 && !searchQueryEmpty && search?.valid !== false && !search?.running, (el) =>
      el.child(
        div()
          .p(6)
          .text_size(11.5)
          .text_color(t.dim)
          .child(search?.error || "No results found")
      )
    )
    .when(rows.length === 0 && searchQueryEmpty, (el) =>
      el.child(
        div()
          .p(6)
          .text_size(11.5)
          .text_color(t.dim)
          .child("Type to search across the workspace")
      )
    );

  return v_flex()
    .id("files-search-section")
    .flex_none()
    .when(open, (el) => el.flex_1().min_h(0))
    .child(
      renderSidebarSectionHeader({
        id: "files-section-search",
        label: "SEARCH",
        open,
        t,
        onToggle: (cx) => view.toggleSection("search", cx),
      })
    )
    .when(open, (el) => el.child(body));
}
