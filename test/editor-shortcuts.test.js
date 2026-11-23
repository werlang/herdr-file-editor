import assert from "node:assert/strict";
import test from "node:test";
import { editorPosition, planLineEdit } from "../mods/file-editor/editor-shortcuts.js";

test("Go to Line accepts positions in a CRLF buffer with Unicode and a final empty line", () => {
  const text = "\uFEFFa\r\n😀b\r\n";
  assert.equal(editorPosition(text, " 1 "), 1);
  assert.equal(editorPosition(text, "2:3"), 6);
  assert.equal(editorPosition(text, "2:2"), 4);
  assert.equal(editorPosition(text, "3"), 9);
  assert.equal(editorPosition("", "1"), 0);
  for (const invalid of ["", "0", "4", "2:0", "2:5", "1:", "1.5", "1e2"]) {
    assert.equal(editorPosition(text, invalid), null);
  }
});

/** Applies the planned patch to exercise the same range contract as EditorState.replace. */
function lineEdit(text, selection, operation, direction) {
  const edit = planLineEdit(text, selection, operation, direction);
  if (!edit) return null;
  const edited = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
  return [edited, edit.selection];
}

test("moving a selection ending at the next line moves only the selected lines", () => {
  assert.deepEqual(lineEdit("one\r\ntwo\r\nthree", { start: 0, end: 10 }, "move", 1), [
    "three\r\none\r\ntwo", { start: 7, end: 15 },
  ]);
  assert.deepEqual(lineEdit("\uFEFFone\ntwo", { start: 6, end: 6 }, "move", -1), [
    "\uFEFFtwo\none", { start: 2, end: 2 },
  ]);
  assert.equal(lineEdit("one\ntwo", { start: 1, end: 1 }, "move", -1), null);
  assert.equal(lineEdit("one\ntwo", { start: 6, end: 6 }, "move", 1), null);
});

test("duplicating moves the selection to the copy and preserves the existing newline convention", () => {
  assert.deepEqual(lineEdit("top\r\nend", { start: 6, end: 8 }, "duplicate", 1), [
    "top\r\nend\r\nend", { start: 11, end: 13 },
  ]);
  assert.deepEqual(lineEdit("a\nb\n", { start: 0, end: 3 }, "duplicate", -1), [
    "a\nb\na\nb\n", { start: 0, end: 3 },
  ]);
});

test("deleting uses one range and removes the adjacent separator, including at EOF", () => {
  assert.deepEqual(lineEdit("a\r\nb\r\nc", { start: 3, end: 6 }, "delete", 0), [
    "a\r\nc", { start: 3, end: 3 },
  ]);
  assert.deepEqual(lineEdit("a\r\nb", { start: 3, end: 3 }, "delete", 0), [
    "a", { start: 1, end: 1 },
  ]);
  assert.deepEqual(lineEdit("\uFEFFa", { start: 0, end: 0 }, "delete", 0), [
    "\uFEFF", { start: 1, end: 1 },
  ]);
});
