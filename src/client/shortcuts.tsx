import { For, Show } from "solid-js";
import { onShortcut } from "./keys";
import { storedFlag } from "./stored";

// Every keyboard shortcut, as listed at the bottom of the sidebar: first
// those that pick which days and stats are shown, then those that move
// around, then those that change how things are shown.
type Shortcut = [keys: string[], what: string];
const GROUPS: Shortcut[][] = [
  [
    [["[", "]"], "Switch months"],
    [["\\"], 'Back to "Last 30 days"'],
    [["←", "→"], "Move the pinned day around"],
    [["Esc"], "Unpin the pinned day"],
    [["Backspace"], "Clear all filters"],
  ],
  [
    [["1–0"], "Paginate pages list"],
    [["q–p", "a–l"], "Paginate referrer list"],
    [["↑", "↓"], "Move through a list"],
    [["Esc Esc"], "Focus first site in sidebar"],
  ],
  [
    [["/"], "Show engaged views"],
    [["."], "Show percentages"],
    [[","], "Show raw paths"],
    [["⌘/"], "Hide this list of shortcuts"],
  ],
];

// The shortcuts, stacked; ⌘/ (or Ctrl+/) hides and shows them, which is
// remembered in this browser.
export function Shortcuts() {
  const [shown, setShown] = storedFlag("vigil:shortcuts", true);
  onShortcut(
    (e) => {
      if (e.key !== "/" || e.repeat) return;
      e.preventDefault();
      setShown((on) => !on);
    },
    { command: true },
  );
  return (
    <Show when={shown()}>
      <section class="shortcuts" aria-label="Keyboard shortcuts">
        <For each={GROUPS}>
          {(group) => (
            <div class="shortcuts-list">
              <For each={group}>
                {([keys, what]) => (
                  <div class="shortcut">
                    <span class="shortcut-keys">
                      <For each={keys}>{(k) => <kbd>{k}</kbd>}</For>
                    </span>
                    <span>{what}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}
