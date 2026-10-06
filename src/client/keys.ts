import { createSignal, onSettled } from "solid-js";

// Calls `handler` with each key pressed anywhere on the page, for the
// calling component's life; but not in a text field or a select, where keys
// type or pick an option, or once something else has taken the key. Only
// without ⌘ and Ctrl, or with `command`, only with ⌘ or Ctrl. Shift and Alt
// (Option) only for a key that types a character (`e.key` is that
// character): many layouts need them for punctuation and even digits ("="
// is Shift+0 in German, "[" Option+5 on a German Mac, "1" Shift+& in
// French), so a shortcut is the character typed, however it's typed; but
// Shift+Escape isn't Escape. AltGr (Windows' Ctrl+Alt for those characters)
// counts as Alt, not Ctrl. Held keys' repeats are left to `handler`.
export function onShortcut(handler: (e: KeyboardEvent) => void, options: { command?: boolean } = {}) {
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typed = e.key.length === 1;
      const altGraph = e.getModifierState("AltGraph");
      if ((e.metaKey || (e.ctrlKey && !altGraph)) ? !options.command : options.command) return;
      if ((e.shiftKey || e.altKey) && !typed) return;
      if ((e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

// Calls `handler` with how many times a finger tapped in quick succession
// (within `gap` ms of each other, near the same spot), once the taps stop,
// for the calling component's life. Only taps on nothing that takes them
// itself (a button, link, field, or chart) count, and a finger that moved
// isn't a tap.
export function onTaps(handler: (taps: number) => void, gap = 300) {
  onSettled(() => {
    let down: { x: number; y: number } | null = null;
    let last: { x: number; y: number } | null = null;
    let taps = 0;
    let timer: number | undefined;
    const near = (a: { x: number; y: number }, b: { x: number; y: number }, by: number) =>
      Math.abs(a.x - b.x) < by && Math.abs(a.y - b.y) < by;
    const onDown = (e: PointerEvent) => {
      const free = e.pointerType !== "mouse" && e.isPrimary && !(e.target as Element).closest("button, a, input, textarea, select, label, [contenteditable], .chart");
      down = free ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const at = { x: e.clientX, y: e.clientY };
      if (!down || !near(down, at, 10)) return;
      down = null;
      window.clearTimeout(timer);
      taps = last && taps > 0 && near(last, at, 40) ? taps + 1 : 1;
      last = at;
      timer = window.setTimeout(() => {
        const n = taps;
        taps = 0;
        handler(n);
      }, gap);
    };
    const onCancel = () => (down = null);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  });
}

// The arrow key pressed along `axis` ("y" for up and down, "x" for left and
// right), as a step: -1 for up or left, 1 for down or right. Null for any
// other key, or with a modifier.
export function arrowStep(e: KeyboardEvent, axis: "x" | "y"): -1 | 1 | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === (axis === "y" ? "ArrowUp" : "ArrowLeft")) return -1;
  if (e.key === (axis === "y" ? "ArrowDown" : "ArrowRight")) return 1;
  return null;
}

// Which of `list`'s children `node` is (or is in), or -1.
export function indexIn(list: Element, node: Node | null): number {
  for (let n = node; n && n !== list; n = n.parentNode) {
    if (n.parentNode === list) return Array.prototype.indexOf.call(list.children, n);
  }
  return -1;
}

// Focuses `list`'s child at `i`, or its nearest if there are fewer.
export function focusAt(list: Element, i: number) {
  const items = list.children;
  (items[Math.max(0, Math.min(i, items.length - 1))] as HTMLElement | undefined)?.focus();
}

// A list of focusable items (its element's children) as one tab stop, the
// one last focused (or the nearest, if there are fewer now): `tabindex` for
// each item, given its place and how many there are, and `onFocusIn` for the
// list's element, to know which was focused. The arrows that move between
// them are the list's own (see arrowStep and focusAt).
export function createRoving() {
  const [at, setAt] = createSignal(0);
  return {
    at,
    tabindex: (i: number, count: number) => (i === Math.min(at(), count - 1) ? 0 : -1),
    onFocusIn: (e: FocusEvent & { currentTarget: Element }) => {
      const i = indexIn(e.currentTarget, e.target as Node);
      if (i >= 0) setAt(i);
    },
  };
}

// Whether a click on a link is a plain one (the main button, no modifier),
// to be followed in the page; any other (for a new tab or window) is left to
// the browser.
export const plainClick = (e: MouseEvent) =>
  e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
