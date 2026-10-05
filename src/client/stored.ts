import { createSignal } from "solid-js";

// An on/off setting kept in this browser's storage under `key`, so it
// survives reloads; `fallback` until it's first set, or wherever storage
// can't be used (it's then kept for the page's life alone).
export function storedFlag(key: string, fallback: boolean) {
  let initial = fallback;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) initial = saved === "on";
  } catch {}
  const [on, setOn] = createSignal(initial);
  // From the value as last set, which a read of `on()` doesn't give until
  // the next flush.
  const set = (next: boolean | ((on: boolean) => boolean)) =>
    setOn((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      try {
        localStorage.setItem(key, value ? "on" : "off");
      } catch {}
      return value;
    });
  return [on, set] as const;
}
