// Injected by build.sh for Herdr's QuickJS, which has no usable setTimeout (it throws: mods
// use cx.timer) and whose `window` is Herdr's, not a browser's.
//
// elkjs runs its layout in an in-process "fake worker" that defers each message with
// setTimeout(fn, 0). Running those jobs at once keeps layout synchronous, which is what
// beautiful-mermaid expects (it already drains them itself right after creating ELK).
function bmSetTimeout(fn) {
  fn();
  return 0;
}

function bmClearTimeout() {}

// elkjs's GWT code takes its globals (Math, Date, setTimeout) from `window`, else `global`:
// build.sh hides `window` and points `global` here, so nothing on globalThis is changed.
const bmGlobal = Object.create(globalThis, {
  setTimeout: { value: bmSetTimeout },
  clearTimeout: { value: bmClearTimeout },
});

export { bmSetTimeout as setTimeout, bmClearTimeout as clearTimeout, bmGlobal as __bm_global };
