/**
 * GitHub-style Markdown preview. Block structure (headings with rules, code boxes,
 * bordered tables, quote bars, list markers and task boxes) is drawn here, because
 * TextView.markdown takes no styling. Inline runs (emphasis, code, links) go through
 * TextView.markdown, which does handle them. ```mermaid blocks are drawn as diagrams when the
 * caller passes `ctx.diagram` (mermaid.js).
 */

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { parseMarkdownBlocks } from "./file-logic.js";
import { isMermaidLang, mermaidDisplaySize } from "./mermaid-svg.js";

/** Font sizes for h1..h6, following GitHub's 2em/1.5em/1.25em/1em/0.875em/0.85em scale on a 16px body. */
const HEADING_SIZE = { 1: 32, 2: 24, 3: 20, 4: 16, 5: 14, 6: 13.6 };

/** Body text size and line height for paragraphs and list items. */
const BODY_SIZE = 16;
const BODY_LINE = "24px";

/**
 * Renders Markdown source as a GitHub-style document.
 *
 * @param {string} source
 * @param {{ t: Record<string, string>, codeFont: string | null, idPrefix: string, maxWidth?: number,
 *   diagram?: (source: string) => { status: string, src?: string, width?: number, height?: number, message?: string } }} ctx
 *   `t` is the theme; `codeFont` the editor font for code; `idPrefix` keeps TextView ids unique;
 *   `maxWidth` the column width diagrams shrink to fit; `diagram` the state of a Mermaid drawing.
 * @returns {import("gpui-kit").Element}
 */
export function renderMarkdownDocument(source, ctx) {
  return renderBlocks(parseMarkdownBlocks(source), ctx, ctx.idPrefix, 16);
}

/**
 * Renders a list of blocks stacked vertically.
 *
 * @param {import("./file-logic.js").MarkdownBlock[]} blocks
 * @param {object} ctx
 * @param {string} path Stable path for TextView ids.
 * @param {number} gap Space between blocks.
 * @returns {import("gpui-kit").Element}
 */
function renderBlocks(blocks, ctx, path, gap) {
  return v_flex()
    .w_full()
    .gap(gap)
    .children(blocks.map((block, i) => renderBlock(block, ctx, `${path}.${i}`)));
}

/**
 * Dispatches one block to its renderer.
 *
 * @param {import("./file-logic.js").MarkdownBlock} block
 * @param {object} ctx
 * @param {string} path
 * @returns {import("gpui-kit").Element}
 */
function renderBlock(block, ctx, path) {
  switch (block.type) {
    case "heading":
      return renderHeading(block, ctx, path);
    case "paragraph":
      return renderInline(block.text, ctx, path, BODY_SIZE, ctx.t.foreground);
    case "code":
      return ctx.diagram && isMermaidLang(block.lang) ? renderDiagram(block, ctx) : renderCode(block, ctx);
    case "quote":
      return renderQuote(block, ctx, path);
    case "list":
      return renderList(block, ctx, path);
    case "table":
      return renderTable(block, ctx, path);
    case "hr":
      return div().w_full().h(4).rounded(2).bg(ctx.t.border);
    default:
      return div();
  }
}

/**
 * Inline text: TextView handles emphasis, code spans and links.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {string} path
 * @param {number} size
 * @param {string} color
 * @param {boolean} [fill=true] Stretch to the container width; false keeps the text at its natural width (table cells).
 * @returns {import("gpui-kit").Element}
 */
function renderInline(text, ctx, path, size, color, fill = true) {
  const wrap = div().min_w(0).text_size(size).line_height(BODY_LINE).text_color(color).when(fill, (e) => e.w_full());
  if (text.trim() === "") return wrap;
  return wrap.child(TextView.markdown(path, text).selectable(true));
}

/**
 * A heading with GitHub's rule under h1 and h2.
 *
 * @param {{ level: number, text: string }} block
 * @param {object} ctx
 * @param {string} path
 * @returns {import("gpui-kit").Element}
 */
function renderHeading(block, ctx, path) {
  const size = HEADING_SIZE[block.level] ?? HEADING_SIZE[6];
  const el = div()
    .w_full()
    .min_w(0)
    .font_weight(600)
    .text_size(size)
    .line_height(`${Math.round(size * 1.25)}px`)
    .text_color(block.level === 6 ? ctx.t.muted : ctx.t.foreground)
    .when(block.level <= 2, (e) => e.border_b_1().border_color(ctx.t.border).pb(6));
  return el.child(TextView.markdown(path, block.text).selectable(true));
}

/**
 * A fenced code block: monospace lines on a raised background, scrolling sideways.
 *
 * @param {{ text: string }} block
 * @param {object} ctx
 * @returns {import("gpui-kit").Element}
 */
function renderCode(block, ctx) {
  const lines = block.text.split("\n");
  return div()
    .w_full()
    .rounded(6)
    .bg(ctx.t.raised)
    .p(16)
    .overflow_x_scroll()
    .child(
      v_flex()
        .font_family(ctx.codeFont || "monospace")
        .text_size(13.6)
        .line_height("20px")
        .text_color(ctx.t.foreground)
        .children(lines.map((line) => div().whitespace_nowrap().child(line === "" ? " " : line)))
    );
}

/**
 * A Mermaid diagram, centered and shrunk to the column. Until it is drawn the block shows its
 * source; if it can't be drawn, the source under the renderer's message.
 *
 * @param {{ text: string }} block
 * @param {object} ctx
 * @returns {import("gpui-kit").Element}
 */
function renderDiagram(block, ctx) {
  const drawing = ctx.diagram(block.text);
  if (drawing.status === "ready") {
    const size = mermaidDisplaySize(drawing, ctx.maxWidth);
    return h_flex().w_full().justify_center().child(image(drawing.src).flex_none().w(size.width).h(size.height));
  }
  if (drawing.status === "error") {
    return v_flex()
      .w_full()
      .gap(6)
      .child(
        div()
          .w_full()
          .text_size(13)
          .line_height("18px")
          .text_color(ctx.t.muted)
          .child(`Mermaid: ${drawing.message}`)
      )
      .child(renderCode(block, ctx));
  }
  return renderCode(block, ctx);
}

/**
 * A narrower copy of ctx for nested blocks, so diagrams fit beside a quote bar or list marker.
 *
 * @param {object} ctx
 * @param {number} inset
 * @returns {object}
 */
function insetCtx(ctx, inset) {
  return Number.isFinite(ctx.maxWidth) ? { ...ctx, maxWidth: Math.max(100, ctx.maxWidth - inset) } : ctx;
}

/**
 * A block quote: nested blocks beside a muted bar.
 *
 * @param {{ blocks: import("./file-logic.js").MarkdownBlock[] }} block
 * @param {object} ctx
 * @param {string} path
 * @returns {import("gpui-kit").Element}
 */
function renderQuote(block, ctx, path) {
  return h_flex()
    .w_full()
    .gap(16)
    .child(div().w(4).h_full().flex_none().rounded(2).bg(ctx.t.muted))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .text_color(ctx.t.muted)
        .child(renderBlocks(block.blocks, insetCtx(ctx, 24), path, 16))
    );
}

/**
 * A bulleted, numbered or task list. Nested blocks are indented under their marker.
 *
 * @param {{ ordered: boolean, start: number, items: Array<{ checked: boolean | null, blocks: import("./file-logic.js").MarkdownBlock[] }> }} block
 * @param {object} ctx
 * @param {string} path
 * @returns {import("gpui-kit").Element}
 */
function renderList(block, ctx, path) {
  return v_flex()
    .w_full()
    .gap(4)
    .pl(8)
    .children(
      block.items.map((item, i) =>
        h_flex()
          .w_full()
          .items_start()
          .gap(8)
          .child(renderMarker(block, item, i, ctx))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .child(renderBlocks(item.blocks, insetCtx(ctx, 40), `${path}.${i}`, 8))
          )
      )
    );
}

/**
 * The bullet, number or task box that starts a list item.
 *
 * @param {{ ordered: boolean, start: number }} list
 * @param {{ checked: boolean | null }} item
 * @param {number} index
 * @param {object} ctx
 * @returns {import("gpui-kit").Element}
 */
function renderMarker(list, item, index, ctx) {
  if (item.checked !== null) {
    const box = div().w(14).h(14).mt(5).flex_none().rounded(3).border_1().border_color(ctx.t.border);
    return item.checked
      ? box
          .bg(ctx.t.accent)
          .border_color(ctx.t.accent)
          .items_center()
          .justify_center()
          .child(div().text_size(10).text_color(ctx.t.background).child("✓"))
      : box;
  }
  const label = list.ordered ? `${list.start + index}.` : "•";
  return div()
    .w(list.ordered ? 24 : 12)
    .flex_none()
    .text_size(BODY_SIZE)
    .line_height(BODY_LINE)
    .text_color(ctx.t.muted)
    .child(label);
}

/**
 * A GitHub table: header row on a raised background, cell rules, per-column alignment.
 *
 * @param {{ align: string[], header: string[], rows: string[][] }} block
 * @param {object} ctx
 * @param {string} path
 * @returns {import("gpui-kit").Element}
 */
function renderTable(block, ctx, path) {
  const columns = block.header.length;
  const renderRow = (cells, rowIndex, isHeader) => {
    const rowPath = `${path}.r${rowIndex}`;
    return h_flex()
      .w_full()
      .when(isHeader, (e) => e.bg(ctx.t.raised))
      .when(!isHeader && rowIndex > 1, (e) => e.border_t_1().border_color(ctx.t.border))
      .children(
        Array.from({ length: columns }, (_, c) => {
          const align = block.align[c] || "left";
          const content = cells[c] ?? "";
          return div()
            .flex_1()
            .min_w(0)
            .px(13)
            .py(6)
            .when(c < columns - 1, (e) => e.border_r_1().border_color(ctx.t.border))
            .child(
              h_flex()
                .w_full()
                .when(align === "right", (e) => e.justify_end())
                .when(align === "center", (e) => e.justify_center())
                .child(
                  renderInline(content, ctx, `${rowPath}.c${c}`, 14, ctx.t.foreground, false).when(isHeader, (e) =>
                    e.font_weight(600)
                  )
                )
            );
        })
      );
  };

  return div()
    .w_full()
    .overflow_x_scroll()
    .child(
      v_flex()
        .min_w(360)
        .border_1()
        .border_color(ctx.t.border)
        .rounded(6)
        .overflow_hidden()
        .child(renderRow(block.header, 0, true))
        .children(block.rows.map((cells, r) => renderRow(cells, r + 1, false)))
    );
}
