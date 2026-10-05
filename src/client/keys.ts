import { onSettled } from "solid-js";

// Calls `handler` with each key pressed anywhere on the page, for the
// calling component's life; but not in a text field or a select, where keys
// type or pick an option, or once something else has taken the key. Only
// without ⌘, Ctrl and Alt, or with `command`, only with ⌘ or Ctrl (and not
// Alt). Shift and held keys' repeats are left to `handler`.
export function onShortcut(handler: (e: KeyboardEvent) => void, options: { command?: boolean } = {}) {
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      if (e.metaKey || e.ctrlKey ? !options.command : options.command) return;
      if ((e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}
