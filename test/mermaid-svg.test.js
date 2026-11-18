import test from "node:test";
import assert from "node:assert/strict";
import {
  MERMAID_FONTS,
  isMermaidLang,
  mermaidColors,
  mermaidKey,
  mermaidDisplaySize,
  flattenMermaidSvg,
  readMermaidSvgSize,
  parseColor,
} from "../mods/file-editor/mermaid-svg.js";
import { renderMermaidSVG } from "../mods/file-editor/vendor/beautiful-mermaid.js";

const THEME = { background: "#181825", foreground: "#cdd6f4", accent: "#60b9fc", muted: "#a6adc8", border: "#ffffff24" };

const DIAGRAMS = {
  "a flowchart": "graph TD\n  A[Client] -->|HTTP| B{Signed in?}\n  B -->|Yes| C[API]\n  B -->|No| D[Login]\n  C --> E[(Postgres)]",
  "a sequence diagram": "sequenceDiagram\n  participant U as User\n  U->>H: opens README.md\n  H-->>U: draws it",
  "a state diagram": "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Working : task\n  Working --> [*]",
  "a class diagram": "classDiagram\n  class Space {\n    +string name\n    +select()\n  }\n  Space *-- Tab",
  "an ER diagram": "erDiagram\n  SPACE ||--o{ TAB : has",
  "an xychart": 'xychart-beta\n  title "Per week"\n  x-axis [w1, w2, w3]\n  y-axis "Count" 0 --> 10\n  bar [2, 5, 9]\n  line [1, 4, 8]',
};

test("isMermaidLang - only the mermaid info string, any case", () => {
  assert.equal(isMermaidLang("mermaid"), true);
  assert.equal(isMermaidLang(" Mermaid "), true);
  assert.equal(isMermaidLang("mermaidjs"), false);
  assert.equal(isMermaidLang(""), false);
  assert.equal(isMermaidLang(undefined), false);
});

test("mermaidColors - background, text, accent and muted from the theme", () => {
  assert.deepEqual(mermaidColors(THEME), { bg: "#181825", fg: "#cdd6f4", accent: "#60b9fc", muted: "#a6adc8" });
  assert.deepEqual(mermaidColors({}), { bg: "#ffffff", fg: "#27272a" });
});

test("mermaidKey - stable per source and colors", () => {
  const colors = mermaidColors(THEME);
  assert.equal(mermaidKey("graph TD\nA-->B", colors), mermaidKey("graph TD\nA-->B", { ...colors }));
  assert.notEqual(mermaidKey("graph TD\nA-->B", colors), mermaidKey("graph TD\nA-->C", colors));
  assert.notEqual(mermaidKey("graph TD\nA-->B", colors), mermaidKey("graph TD\nA-->B", { ...colors, bg: "#000000" }));
  assert.match(mermaidKey("x", colors), /^[0-9a-f]{16}$/);
});

test("mermaidDisplaySize - natural size, shrunk to fit the column", () => {
  assert.deepEqual(mermaidDisplaySize({ width: 300, height: 400 }, 880), { width: 300, height: 400 });
  assert.deepEqual(mermaidDisplaySize({ width: 1760, height: 400 }, 880), { width: 880, height: 200 });
  assert.deepEqual(mermaidDisplaySize({ width: 300, height: 400 }), { width: 300, height: 400 });
});

test("parseColor - hex, alpha hex, rgb()/rgba() and names", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#ffffff24"), { r: 255, g: 255, b: 255, a: 36 / 255 });
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor("var(--x)"), null);
});

test("flattenMermaidSvg - resolves custom properties and color-mix() to plain colors", () => {
  const svg =
    '<svg viewBox="0 0 10 20" style="--fg:#ffffff;--bg:#000000;background:var(--bg)">' +
    "<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500&amp;display=swap');" +
    " text { font-family: 'Inter', system-ui, sans-serif; }" +
    " svg { --_line: color-mix(in srgb, var(--fg) 50%, var(--bg)); --_fill: var(--surface, color-mix(in srgb, var(--fg) 25%, var(--bg))); }" +
    " .edge { stroke: var(--_line); }</style>" +
    '<rect fill="var(--_fill)" stroke="var(--missing, var(--fg))"/></svg>';
  const flat = flattenMermaidSvg(svg);
  assert.equal(flat.width, 10);
  assert.equal(flat.height, 20);
  assert.match(flat.text, /^<svg width="30" height="60"/);
  assert.match(flat.text, /viewBox="0 0 10 20"/);
  assert.doesNotMatch(flat.text, /style="/);
  assert.match(flat.text, /fill="#404040"/);
  assert.match(flat.text, /stroke="#ffffff"/);
  assert.match(flat.text, /\.edge \{ stroke: #808080; \}/);
  assert.ok(flat.text.includes(`font-family: ${MERMAID_FONTS}`));
  assert.doesNotMatch(flat.text, /var\(|color-mix\(|@import|googleapis|display=swap/);
});

test("flattenMermaidSvg - leaves label text and data attributes alone", () => {
  const flat = flattenMermaidSvg(
    '<svg viewBox="0 0 10 10" style="--fg:#ffffff"><text fill="var(--fg)" data-label="var(--fg)">uses var(--fg)</text></svg>'
  );
  assert.match(flat.text, /fill="#ffffff"/);
  assert.match(flat.text, /data-label="var\(--fg\)"/);
  assert.match(flat.text, />uses var\(--fg\)</);
});

test("flattenMermaidSvg - caps the rasterized size of big diagrams", () => {
  const flat = flattenMermaidSvg('<svg viewBox="0 0 4800 1200"></svg>');
  assert.match(flat.text, /width="2400" height="600"/);
  assert.deepEqual(readMermaidSvgSize(flat.text), { width: 4800, height: 1200 });
  assert.equal(readMermaidSvgSize("<svg></svg>"), null);
  assert.equal(readMermaidSvgSize(null), null);
  assert.throws(() => flattenMermaidSvg("not svg"), /no <svg>/);
});

for (const [name, source] of Object.entries(DIAGRAMS)) {
  test(`vendored beautiful-mermaid draws ${name} the host can rasterize`, () => {
    const flat = flattenMermaidSvg(renderMermaidSVG(source, { ...mermaidColors(THEME), transparent: true }));
    assert.ok(flat.width > 0 && flat.height > 0);
    assert.deepEqual(readMermaidSvgSize(flat.text), { width: flat.width, height: flat.height });
    assert.doesNotMatch(flat.text, /var\(|color-mix\(|@import/);
    assert.match(flat.text, /<text\b/);
  });
}

test("vendored beautiful-mermaid rejects diagram types it does not draw", () => {
  assert.throws(() => renderMermaidSVG('pie title Pets\n  "Dogs" : 3', {}), /Invalid mermaid header/);
});
