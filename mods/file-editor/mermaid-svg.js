/**
 * Mermaid diagrams in the Markdown preview: the pure part (no host calls, so it also runs under
 * Node for tests). Which fences are Mermaid, a stable key per drawing, the theme colors a
 * drawing uses, and the rewrite that makes beautiful-mermaid's SVG drawable by the host.
 *
 * beautiful-mermaid themes its SVG with CSS custom properties and color-mix(), and asks for
 * Inter from Google Fonts. The host rasterizes SVG with resvg, which supports none of that: it
 * would draw every node black. So the rewrite resolves each var() and color-mix() to a plain
 * color, drops the @import, names fonts the machine has, and sizes the root for a crisp bitmap.
 */

/** Bump when the renderer or the rewrite changes: cached drawings are keyed by it. */
export const MERMAID_RENDER_VERSION = "beautiful-mermaid@1.1.3/1";

/** Fonts for diagram text, first installed wins. beautiful-mermaid sizes its boxes for Inter. */
export const MERMAID_FONTS = "Inter, 'Helvetica Neue', Helvetica, Arial, 'Noto Sans', 'DejaVu Sans', sans-serif";

/** The rasterized bitmap: up to 3x the diagram's own size, its longest side at most 2400 px. */
const MAX_RASTER_SCALE = 3;
const MAX_RASTER_SIDE = 2400;

/**
 * True for a fenced block whose info string is `mermaid` (any case).
 *
 * @param {string | null | undefined} lang
 * @returns {boolean}
 */
export function isMermaidLang(lang) {
  return typeof lang === "string" && lang.trim().toLowerCase() === "mermaid";
}

/**
 * The colors a diagram is drawn with, from the Herdr theme: the preview's background and text,
 * the accent for arrow heads and the muted text for labels. Lines, fills and strokes are mixed
 * from these by beautiful-mermaid.
 *
 * @param {Record<string, string>} t Herdr theme
 * @returns {{ bg: string, fg: string, accent?: string, muted?: string }}
 */
export function mermaidColors(t) {
  const colors = { bg: t?.background || "#ffffff", fg: t?.foreground || "#27272a" };
  if (t?.accent) colors.accent = t.accent;
  if (t?.muted) colors.muted = t.muted;
  return colors;
}

/**
 * A stable 64-bit hex key for one drawing: renderer version, colors and source.
 *
 * @param {string} source
 * @param {Record<string, string>} colors
 * @returns {string}
 */
export function mermaidKey(source, colors) {
  const text = `${MERMAID_RENDER_VERSION}\n${JSON.stringify(colors ?? {})}\n${source ?? ""}`;
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * The size to show a diagram at: its own size, scaled down to fit `maxWidth`.
 *
 * @param {{ width: number, height: number }} natural
 * @param {number} [maxWidth]
 * @returns {{ width: number, height: number }}
 */
export function mermaidDisplaySize(natural, maxWidth) {
  const w = Math.max(1, natural?.width || 1);
  const h = Math.max(1, natural?.height || 1);
  const fit = Number.isFinite(maxWidth) && maxWidth > 0 && w > maxWidth ? maxWidth / w : 1;
  return { width: Math.max(1, Math.round(w * fit)), height: Math.max(1, Math.round(h * fit)) };
}

/**
 * Rewrites beautiful-mermaid's SVG into one resvg draws as intended.
 *
 * @param {string} svg
 * @returns {{ text: string, width: number, height: number }} The SVG and the diagram's own size.
 */
export function flattenMermaidSvg(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) throw new Error("the renderer returned no <svg>");
  const tag = root[0];

  // Custom properties: the root's inline style (--bg, --fg, ...) wins over the <style> block's
  // derived ones (--_text, --_line, ...).
  const vars = new Map();
  for (const block of svg.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []) collectCustomProperties(block, vars);
  collectCustomProperties(attribute(tag, "style") ?? "", vars);

  const viewBox = (attribute(tag, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  const width = hasViewBox ? viewBox[2] : Number.parseFloat(attribute(tag, "width") ?? "") || 300;
  const height = hasViewBox ? viewBox[3] : Number.parseFloat(attribute(tag, "height") ?? "") || 150;
  const scale = Math.min(MAX_RASTER_SCALE, MAX_RASTER_SIDE / Math.max(width, height));

  let rootTag = tag
    .replace(/\s(?:width|height|style)\s*=\s*(["'])[^"']*\1/gi, "")
    .replace(/^<svg/i, `<svg width="${Math.max(1, Math.round(width * scale))}" height="${Math.max(1, Math.round(height * scale))}"`);
  if (!hasViewBox) rootTag = rootTag.replace(/^<svg/i, `<svg viewBox="0 0 ${width} ${height}"`);

  let body = svg.slice(0, root.index) + rootTag + svg.slice(root.index + tag.length);
  // Only stylesheets and attribute values are rewritten: a label may say "var(" too.
  const resolve = (css) => resolveColorMix(resolveVars(css, vars, 0));
  body = body.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, css) => {
    const cleaned = css
      .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/g, "")
      .replace(/(^|[;{\s])--[\w-]+\s*:[^;{}]*;/g, "$1")
      .replace(/font-family\s*:[^;}]*/g, `font-family: ${MERMAID_FONTS}`);
    return `<style${attrs}>${resolve(cleaned)}</style>`;
  });
  body = body.replace(/(<[A-Za-z][^<>]*>)/g, (tag) =>
    tag.replace(/(\s)([\w:-]+)(\s*=\s*)(["'])([^"']*)\4/g, (m, sp, name, eq, q, value) =>
      name.startsWith("data-") || !/var\(|color-mix\(/.test(value) ? m : `${sp}${name}${eq}${q}${resolve(value)}${q}`
    )
  );
  return { text: body, width: round2(width), height: round2(height) };
}

/**
 * A cached drawing's own size, from the viewBox flattenMermaidSvg kept.
 *
 * @param {string} svg
 * @returns {{ width: number, height: number } | null}
 */
export function readMermaidSvgSize(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg ?? "");
  if (!root) return null;
  const viewBox = (attribute(root[0], "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) return null;
  return { width: round2(viewBox[2]), height: round2(viewBox[3]) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** An attribute's value in one tag, or null. */
function attribute(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(tag);
  return m ? m[2] : null;
}

/** Adds every `--name: value` declaration in `css` to `vars`. */
function collectCustomProperties(css, vars) {
  const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(css))) vars.set(m[1], m[2].trim());
}

/** The index of the parenthesis closing the one at `open`, or -1. */
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Splits at the commas not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** Replaces each var(--name[, fallback]) with its value, resolved in turn. */
function resolveVars(text, vars, depth) {
  if (depth > 16 || !text.includes("var(")) return text;
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf("var(", i);
    if (at < 0) return out + text.slice(i);
    const end = closingParen(text, at + 3);
    if (end < 0) return out + text.slice(i);
    const [name, ...rest] = splitTopLevel(text.slice(at + 4, end));
    const fallback = rest.length ? rest.join(", ") : null;
    const value = vars.has(name) ? vars.get(name) : fallback ?? "";
    out += text.slice(i, at) + resolveVars(value, vars, depth + 1);
    i = end + 1;
  }
}

/** Replaces each color-mix(in srgb, A p%, B q%) with the mixed color, innermost first. */
function resolveColorMix(text) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf("color-mix(", i);
    if (at < 0) return out + text.slice(i);
    const end = closingParen(text, at + 9);
    if (end < 0) return out + text.slice(i);
    out += text.slice(i, at) + mixColors(resolveColorMix(text.slice(at + 10, end)));
    i = end + 1;
  }
}

/** Evaluates the inside of one color-mix() whose arguments are plain colors. */
function mixColors(args) {
  const [, first = "", second = ""] = splitTopLevel(args);
  const a = colorStop(first);
  const b = colorStop(second);
  if (!a.color || !b.color) return a.color ? formatColor(a.color) : b.color ? formatColor(b.color) : "#000000";
  let pa = a.pct;
  let pb = b.pct;
  if (pa == null && pb == null) pa = pb = 50;
  else if (pa == null) pa = 100 - pb;
  else if (pb == null) pb = 100 - pa;
  const total = pa + pb;
  if (total <= 0) return formatColor(a.color);
  pa /= total;
  pb /= total;
  // Premultiplied, as CSS mixes colors with alpha.
  const alpha = a.color.a * pa + b.color.a * pb;
  const channel = (k) => (alpha > 0 ? (a.color[k] * a.color.a * pa + b.color[k] * b.color.a * pb) / alpha : 0);
  return formatColor({ r: channel("r"), g: channel("g"), b: channel("b"), a: alpha });
}

/** A color-mix argument: a color and an optional percentage. */
function colorStop(text) {
  const m = /^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/.exec(text.trim());
  return { color: parseColor(m?.[1] ?? ""), pct: m?.[2] != null ? Number(m[2]) : null };
}

/**
 * Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and a few names.
 *
 * @param {string} text
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function parseColor(text) {
  const s = String(text ?? "").trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0, a: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p) => (p.endsWith("%") ? (Number.parseFloat(p) * 255) / 100 : Number.parseFloat(p));
    const alpha = parts[3] == null ? 1 : parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
    const c = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
    return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? c : null;
  }
  return null;
}

/** #rrggbb when opaque, rgba() otherwise (resvg reads both). */
function formatColor(c) {
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const a = Math.max(0, Math.min(1, c.a));
  if (a >= 0.999) return "#" + [c.r, c.g, c.b].map((v) => byte(v).toString(16).padStart(2, "0")).join("");
  return `rgba(${byte(c.r)},${byte(c.g)},${byte(c.b)},${Math.round(a * 1000) / 1000})`;
}
