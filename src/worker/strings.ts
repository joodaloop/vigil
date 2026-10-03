// IDs are immutable. Keep a bounded LRU cache, but retain each request's IDs
// separately so eviction (including by another request) can't lose its results.
const cache = new Map<string, number>();
const MAX_CACHE = 50_000;

function remember(value: string, id: number) {
    cache.delete(value);
    cache.set(value, id);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}

function cachedIds(values: string[]): Map<string, number> {
    const ids = new Map<string, number>();
    for (const value of values) {
        const id = cache.get(value);
        if (id !== undefined) {
            ids.set(value, id);
            remember(value, id);
        }
    }
    return ids;
}

export async function internAll(
    db: D1Database,
    values: (string | null | undefined)[],
): Promise<(number | null)[]> {
    const strings = [...new Set(values.filter((v): v is string => !!v))];
    const ids = cachedIds(strings);
    const missing = strings.filter((v) => !ids.has(v));

    if (missing.length > 0) {
        // A cold cache shouldn't rewrite strings already in the database.
        // Insert and lookup share one transaction and one round trip.
        const [, rows] = await db.batch<{ id: number; value: string }>([
            db.prepare(
                `INSERT INTO strings (value) VALUES ${missing.map(() => "(?)").join(",")}
                 ON CONFLICT (value) DO NOTHING`,
            ).bind(...missing),
            db.prepare(
                `SELECT id, value FROM strings WHERE value IN (${missing.map(() => "?").join(",")})`,
            ).bind(...missing),
        ]);
        for (const r of rows.results) {
            ids.set(r.value, r.id);
            remember(r.value, r.id);
        }
    }

    return values.map((v) => (v ? ids.get(v)! : null));
}

// Looks up ids for filter values without creating them. Unknown values map to
// -1 so the filter matches nothing rather than being ignored.
export async function lookupIds(
    db: D1Database,
    values: string[],
): Promise<number[]> {
    const names = [...new Set(values)];
    const ids = cachedIds(names);
    const unknown = names.filter((v) => !ids.has(v));
    if (unknown.length > 0) {
        const rows = await db
            .prepare(
                `SELECT id, value FROM strings WHERE value IN (${unknown.map(() => "?").join(",")})`,
            )
            .bind(...unknown)
            .all<{ id: number; value: string }>();
        for (const r of rows.results) {
            ids.set(r.value, r.id);
            remember(r.value, r.id);
        }
    }
    return values.map((v) => ids.get(v) ?? -1);
}
