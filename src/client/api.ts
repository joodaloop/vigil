// Reads the Worker's API. A demo build (`vite build --mode demo`) answers
// from made-up numbers in the page instead (demo.ts); in any other build the
// check is always false, so demo.ts is left out of it.
export async function get<T>(path: string, params: URLSearchParams | Record<string, string> = {}): Promise<T> {
  if (import.meta.env.MODE === "demo") {
    const demo = await import("./demo");
    return demo.get(path, new URLSearchParams(params)) as T;
  }
  const r = await fetch(`${path}?${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// What's been loaded, by the address it was loaded from, and when. Asked
// for again within a few minutes, it's reused rather than fetched again (two
// asks while it loads share the one fetch), so going back to a site, period
// or filters seen recently is instant; after that it's fetched afresh, so a
// dashboard left open catches up. A failed load isn't kept.
const FRESH_MS = 5 * 60_000;
const kept = new Map<string, { at: number; value: Promise<unknown> }>();

export function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [k, e] of kept) if (now - e.at > FRESH_MS) kept.delete(k);
  const e = kept.get(key);
  if (e) return e.value as Promise<T>;
  const value = load();
  kept.set(key, { at: now, value });
  value.catch(() => kept.delete(key));
  return value;
}
