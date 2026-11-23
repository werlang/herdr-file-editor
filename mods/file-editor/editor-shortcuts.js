/** Records logical line contents without their separators or the document BOM. */
function editorLines(text) {
  const lines = [];
  let start = text.startsWith("\uFEFF") ? 1 : 0;
  for (const newline of text.matchAll(/\r?\n/g)) {
    lines.push({ start, end: newline.index });
    start = newline.index + newline[0].length;
  }
  lines.push({ start, end: text.length });
  return lines;
}

/** Resolves a one-based line or line:column to a UTF-16 editor offset. */
export function editorPosition(text, input) {
  const match = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(input.trim());
  if (!match) return null;
  const line = editorLines(text)[Number(match[1]) - 1];
  const column = Number(match[2] ?? 1) - 1;
  if (!line || column > line.end - line.start) return null;
  const offset = line.start + column;
  const splitsSurrogate = /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1]);
  return splitsSurrogate ? offset - 1 : offset;
}

/** Plans one native undoable replacement around the selected logical lines. */
export function planLineEdit(text, selection, operation, direction) {
  const lines = editorLines(text);
  const first = lines.findLastIndex((line) => line.start <= Math.max(selection.start, lines[0].start));
  // A selection ending at the start of the next line does not include that line.
  const lastOffset = Math.max(selection.start, selection.end - 1, lines[0].start);
  const last = lines.findLastIndex((line) => line.start <= lastOffset);
  const { start } = lines[first];
  const { end } = lines[last];
  const previous = lines[first - 1];
  const next = lines[last + 1];
  const separatorAfter = next ? text.slice(end, next.start) : "";
  const separatorBefore = previous ? text.slice(previous.end, start) : "";

  if (operation === "delete") {
    const from = next ? start : previous?.end ?? start;
    return { range: { start: from, end: next?.start ?? end }, text: "", selection: { start: from, end: from } };
  }

  const block = text.slice(start, end);
  if (operation === "duplicate") {
    const separator = separatorAfter || separatorBefore || "\n";
    const insertAt = direction < 0 ? start : end;
    return {
      range: { start: insertAt, end: insertAt },
      text: direction < 0 ? block + separator : separator + block,
      selection: shiftLineSelection(selection, start, end, direction < 0 ? 0 : separator.length + block.length),
    };
  }

  if (direction < 0 && previous) {
    const neighbor = text.slice(previous.start, previous.end);
    return {
      range: { start: previous.start, end },
      text: block + separatorBefore + neighbor,
      selection: shiftLineSelection(selection, start, end, previous.start - start),
    };
  }
  if (direction > 0 && next) {
    const neighbor = text.slice(next.start, next.end);
    return {
      range: { start, end: next.end },
      text: neighbor + separatorAfter + block,
      selection: shiftLineSelection(selection, start, end, neighbor.length + separatorAfter.length),
    };
  }
  return null;
}

/** Keeps caret and selection offsets relative to the affected lines. */
function shiftLineSelection(selection, start, end, delta) {
  return {
    start: Math.min(Math.max(selection.start, start), end) + delta,
    end: Math.min(Math.max(selection.end, start), end) + delta,
  };
}
