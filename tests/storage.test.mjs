import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

let moduleId = 0;
const freshStrings = () => import(`../src/worker/strings.ts?test=${moduleId++}`);
const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

// Run the real string SQL against SQLite behind the small D1 interface it uses.
function database(t) {
    const sql = new DatabaseSync(":memory:");
    sql.exec(schema);
    t.after(() => sql.close());
    const calls = [];
    const db = {
        sql,
        calls,
        prepare(query) {
            return {
                bind(...params) {
                    return {
                        async all() {
                            calls.push(query);
                            return { results: sql.prepare(query).all(...params) };
                        },
                    };
                },
            };
        },
        async batch(statements) {
            sql.exec("BEGIN");
            try {
                const results = [];
                for (const statement of statements) results.push(await statement.all());
                sql.exec("COMMIT");
                return results;
            } catch (error) {
                sql.exec("ROLLBACK");
                throw error;
            }
        },
    };
    return db;
}

function seed(db) {
    db.sql.exec(`WITH RECURSIVE n(i) AS (
        VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 50000
    ) INSERT INTO strings(id, value) SELECT i + 1, 's' || i FROM n`);
}

async function warm(lookupIds, db, start = 0) {
    for (let i = start; i < 50000; i += 100) {
        const values = Array.from({ length: Math.min(100, 50000 - i) }, (_, j) => `s${i + j}`);
        await lookupIds(db, values);
    }
}

test("interning inserts only new strings, preserves order, and caches results", async (t) => {
    const db = database(t);
    db.sql.exec(`INSERT INTO strings(id, value) VALUES (7, 'existing');
        CREATE TABLE writes(kind TEXT);
        CREATE TRIGGER track_insert AFTER INSERT ON strings BEGIN INSERT INTO writes VALUES ('insert'); END;
        CREATE TRIGGER track_update AFTER UPDATE ON strings BEGIN INSERT INTO writes VALUES ('update'); END;`);
    const { internAll, lookupIds } = await freshStrings();
    assert.deepEqual(await internAll(db, ["existing", "new", "existing", null, undefined, ""]), [7, 8, 7, null, null, null]);
    assert.deepEqual(db.sql.prepare("SELECT kind FROM writes").all().map((r) => r.kind), ["insert"]);
    assert.equal(db.calls.length, 2);

    assert.deepEqual(await internAll(db, ["new", "existing"]), [8, 7]);
    assert.equal(db.calls.length, 2, "warm lookups should not query D1");
    assert.deepEqual(await lookupIds(db, ["absent", "existing", "absent"]), [-1, 7, -1]);
    assert.deepEqual(await internAll(db, ["absent"]), [9], "a previous miss must not hide a new string");

    db.sql.exec("DELETE FROM writes");
    const cold = await freshStrings();
    assert.deepEqual(await cold.internAll(db, ["new", "existing"]), [8, 7]);
    assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM writes").get().n, 0);
});

test("crossing the cache limit keeps warm and newly interned IDs", async (t) => {
    const db = database(t);
    seed(db);
    const { internAll, lookupIds } = await freshStrings();
    await warm(lookupIds, db);
    assert.deepEqual(await internAll(db, ["s0", "new"]), [1, 50002]);
    const calls = db.calls.length;
    assert.deepEqual(await lookupIds(db, ["s0", "s49999", "new"]), [1, 50000, 50002]);
    assert.equal(db.calls.length, calls, "eviction should retain recently used entries");
});

test("read-only lookups also evict the least recently used entry", async (t) => {
    const db = database(t);
    seed(db);
    const { lookupIds } = await freshStrings();
    await warm(lookupIds, db);
    assert.deepEqual(await lookupIds(db, ["s50000"]), [50001]);
    const calls = db.calls.length;
    assert.deepEqual(await lookupIds(db, ["s0"]), [1]);
    assert.equal(db.calls.length, calls + 1, "the oldest entry should have been evicted");
    assert.deepEqual(await lookupIds(db, ["s49999"]), [50000]);
    assert.equal(db.calls.length, calls + 1, "recent entries should remain cached");
});

test("another request can evict an ID while interning is awaiting D1", async (t) => {
    const db = database(t);
    seed(db);
    const { internAll, lookupIds } = await freshStrings();
    await warm(lookupIds, db);
    const batch = db.batch.bind(db);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    db.batch = async (statements) => {
        const result = await batch(statements);
        await gate;
        return result;
    };

    const pending = internAll(db, ["s0", "new"]);
    try {
        await warm(lookupIds, db, 1);
        await lookupIds(db, ["s50000"]);
    } finally {
        release();
    }
    assert.deepEqual(await pending, [1, 50002]);
});

// Exercise the collector's actual UPDATE rather than keeping a second SQL copy.
const collector = readFileSync(new URL("../src/worker/collect.ts", import.meta.url), "utf8");
const endSql = collector.match(/`(UPDATE hits SET[\s\S]*?)`/)[1];

test("end updates initialize nulls, skip duplicates and older values, and enforce ownership", (t) => {
    const db = database(t);
    db.sql.exec("INSERT INTO hits(id, site, host, page, visitor_id, entry_hit_id) VALUES (1, 1, 1, 1, 7, 1)");
    const end = db.sql.prepare(endSql);
    const update = (engaged, scroll, visitor = 7) => end.run({ 1: engaged, 2: scroll, 3: 1, 4: visitor }).changes;
    const values = () => Object.values(db.sql.prepare("SELECT engaged_s, scroll_pct FROM hits WHERE id = 1").get());

    assert.equal(update(0, 0), 1, "zero metrics should replace NULLs");
    assert.deepEqual(values(), [0, 0]);
    assert.equal(update(0, 0), 0);
    assert.equal(update(20, 60), 1);
    assert.equal(update(20, 60), 0);
    assert.equal(update(10, 40), 0);
    assert.equal(update(30, 50), 1);
    assert.deepEqual(values(), [30, 60], "an increasing time must not lower scroll depth");
    assert.equal(update(25, 90), 1);
    assert.deepEqual(values(), [30, 90]);
    assert.equal(update(99, 100, 8), 0);
    assert.deepEqual(values(), [30, 90]);

    db.sql.exec("UPDATE hits SET engaged_s = NULL WHERE id = 1");
    assert.equal(update(0, 0), 1);
    assert.deepEqual(values(), [0, 90]);
});
