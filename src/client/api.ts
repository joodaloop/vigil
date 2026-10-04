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
