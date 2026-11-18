/**
 * Mermaid diagrams in the Markdown preview: drawing and caching (see mermaid-svg.js for the
 * pure part).
 *
 * Each ```mermaid block is drawn to SVG by beautiful-mermaid (vendor/, MIT; its layout engine
 * is elkjs, EPL-2.0: see vendor/beautiful-mermaid.LICENSES.txt), entirely in this process, with
 * no browser and no network. The renderer is ~1.5 MB, so it is only loaded the first time a
 * diagram has to be drawn. Each drawing is written once to
 * <app home>/cache/file-editor/mermaid/<key>.svg, keyed by its source and theme colors, and
 * shown with image(): a diagram drawn before (in this session or an earlier one) is shown
 * without loading the renderer at all. Drawings older than 30 days are deleted (and drawn
 * again if still needed).
 */

import { appHome, exec, readTextFile, writeTextFile } from "herdr";
import { mermaidKey, flattenMermaidSvg, readMermaidSvgSize } from "./mermaid-svg.js";

/** Where drawings go, relative to the app home (image() paths resolve against it). */
const CACHE_DIR = "cache/file-editor/mermaid";

/** Diagram states a view keeps: past this, the oldest finished ones are forgotten. */
const MAX_ENTRIES = 200;

/** Drawings older than this are deleted, once per load of this module. */
const PRUNE_DAYS = 30;
let pruned = false;

/**
 * The diagrams one view shows. `get` answers during render and queues what is new; `pump`
 * draws the queue in a task, one diagram at a time, redrawing the view after each.
 */
export class MermaidDiagrams {
  constructor() {
    /** @type {Map<string, { status: "pending" } | { status: "ready", src: string, width: number, height: number } | { status: "error", message: string }>} */
    this.entries = new Map();
    /** @type {Array<{ key: string, source: string, colors: Record<string, string> }>} */
    this.queue = [];
    this.running = false;
    this.closed = false;
  }

  /**
   * One diagram's state; a new one is queued and reported as pending.
   *
   * @param {string} source
   * @param {Record<string, string>} colors
   */
  get(source, colors) {
    const key = mermaidKey(source, colors);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { status: "pending" };
      this.entries.set(key, entry);
      this.queue.push({ key, source, colors });
      this.forgetOldest();
    }
    return entry;
  }

  /**
   * Draws whatever `get` queued. Call it after rendering the document.
   *
   * @param {import("gpui-kit").ViewContext} cx
   */
  pump(cx) {
    if (this.running || this.closed || this.queue.length === 0) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        while (this.queue.length > 0 && !this.closed) {
          const job = this.queue.shift();
          this.entries.set(job.key, await drawDiagram(job));
          if (!this.closed) cx.notify();
        }
      } finally {
        this.running = false;
      }
    });
  }

  /** Keeps `entries` bounded when a document keeps changing (an agent rewriting it). */
  forgetOldest() {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (entry.status !== "pending") this.entries.delete(key);
    }
  }

  /** Stops drawing (the view closed). */
  close() {
    this.closed = true;
    this.queue = [];
  }
}

/**
 * Draws one diagram, or finds it drawn already.
 *
 * @param {{ key: string, source: string, colors: Record<string, string> }} job
 */
async function drawDiagram({ key, source, colors }) {
  const home = appHome();
  const dir = `${home}/${CACHE_DIR}`;
  const rel = `${CACHE_DIR}/${key}.svg`;
  const path = `${home}/${rel}`;
  try {
    const size = readMermaidSvgSize(await readTextFile(path).catch(() => null));
    if (size) return { status: "ready", src: rel, ...size };
    const { renderMermaidSVG } = await import("./vendor/beautiful-mermaid.js");
    const svg = flattenMermaidSvg(renderMermaidSVG(source, { ...colors, transparent: true }));
    await exec("mkdir", ["-p", dir]);
    // null: only if it isn't there. Another tab may have just written the same drawing.
    await writeTextFile(path, svg.text, null).catch(async (error) => {
      if (!readMermaidSvgSize(await readTextFile(path).catch(() => null))) throw error;
    });
    pruneOldDrawings(dir);
    return { status: "ready", src: rel, width: svg.width, height: svg.height };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/** Deletes drawings nobody wrote for PRUNE_DAYS (best effort; `find` is not on Windows). */
function pruneOldDrawings(dir) {
  if (pruned) return;
  pruned = true;
  exec("find", [dir, "-name", "*.svg", "-type", "f", "-mtime", `+${PRUNE_DAYS}`, "-delete"]).catch(() => null);
}

/** The first line of an error, without the renderer's stack. */
function errorMessage(error) {
  const text = String(error?.message ?? error ?? "could not draw this diagram").trim();
  return text.split("\n")[0].slice(0, 300) || "could not draw this diagram";
}
