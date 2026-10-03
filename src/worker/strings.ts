// Interns strings into the `strings` table. Ids never change once assigned, so
// they're cached for the life of the isolate and most hits skip the lookup.
const cache = new Map<string, number>();
const MAX_CACHE = 50_000;

export async function internAll(
    db: D1Database,
    values: (string | null | undefined)[],
): Promise<(number | null)[]> {
    const missing = [
        ...new Set(values.filter((v): v is string => !!v && !cache.has(v))),
    ];

    if (missing.length > 0) {
        const stmt = db.prepare(
            "INSERT INTO strings (value) VALUES (?) ON CONFLICT (value) DO UPDATE SET value = excluded.value RETURNING id",
        );
        const results = await db.batch<{ id: number }>(
            missing.map((v) => stmt.bind(v)),
        );
        if (cache.size + missing.length > MAX_CACHE) cache.clear();
        missing.forEach((v, i) => cache.set(v, results[i].results[0].id));
    }

    return values.map((v) => (v ? cache.get(v)! : null));
}

// Looks up ids for filter values without creating them. Unknown values map to
// -1 so the filter matches nothing rather than being ignored.
export async function lookupIds(
    db: D1Database,
    values: string[],
): Promise<number[]> {
    const unknown = values.filter((v) => !cache.has(v));
    if (unknown.length > 0) {
        const rows = await db
            .prepare(
                `SELECT id, value FROM strings WHERE value IN (${unknown.map(() => "?").join(",")})`,
            )
            .bind(...unknown)
            .all<{ id: number; value: string }>();
        for (const r of rows.results) cache.set(r.value, r.id);
    }
    return values.map((v) => cache.get(v) ?? -1);
}
