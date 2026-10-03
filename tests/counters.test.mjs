import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COUNT_END, COUNT_HIT, newToHost } from "../src/worker/counters.ts";

const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const init = migration("0001_init.sql");
const counters = migration("0002_counters.sql");
const collector = readFileSync(new URL("../src/worker/collect.ts", import.meta.url), "utf8");
const endSql = collector.match(/`(UPDATE hits SET[\s\S]*?)`/)[1];

// Deterministic pseudo-random numbers, so a failure reproduces.
function random(seed) {
    return () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
    };
}

// Hits over 60 days: 3 hosts on 2 sites, returning visitors, internal clicks
// and arrivals from a few referrers, in time order like the collector's.
// Host 3 moves from site 1 to its own root (site 6) halfway through, as if the
// config changed; its history should carry over, since counters are per host.
function traffic(n = 3000) {
    const rand = random(42);
    const pick = (k) => Math.floor(rand() * k);
    const day0 = 20000;
    const hosts = [
        { site: 1, host: 2 },
        { site: 1, host: 3 },
        { site: 4, host: 5 },
    ];
    const hits = [];
    const lastTrip = new Map();
    let ts = day0 * 86400;
    for (let id = 1; id <= n; id++) {
        ts += pick((60 * 86400) / n) * 2;
        const visitor = 1 + pick(400);
        const { site: configured, host } = hosts[pick(3)];
        const site = host === 3 && id > n / 2 ? 6 : configured;
        const trip = lastTrip.get(visitor);
        const arrival = !trip || rand() < 0.4;
        const entry = arrival ? id : trip;
        if (arrival) lastTrip.set(visitor, id);
        hits.push({
            id,
            ts,
            site,
            host,
            page: 100 + host * 10 + pick(8),
            visitor,
            entry,
            src: arrival ? [null, 200, 201, 202][pick(4)] : 100,
        });
    }
    return hits;
}

function insertVisitors(sql) {
    sql.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 400)
        INSERT INTO visitors (id, first_seen, device) SELECT i, 0, 300 + i % 3 FROM n`);
}

// What the collector does per hit: insert it with is_new, then the counters.
function collect(sql, hits) {
    const insert = sql.prepare(
        `INSERT INTO hits (id, ts, site, host, page, visitor_id, entry_hit_id, src, is_new)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${newToHost("?6", "?4")})`,
    );
    const count = COUNT_HIT.map((s) => sql.prepare(s));
    for (const h of hits) {
        sql.exec("BEGIN");
        insert.run({ 1: h.id, 2: h.ts, 3: h.site, 4: h.host, 5: h.page, 6: h.visitor, 7: h.entry, 8: h.src });
        for (const s of count) s.run();
        sql.exec("COMMIT");
    }
}

// End beacons, repeated, out of order, and some for other visitors' hits.
function beacons(sql, hits, n = 4000) {
    const rand = random(7);
    const pick = (k) => Math.floor(rand() * k);
    const counted = sql.prepare(COUNT_END);
    const update = sql.prepare(endSql);
    for (let i = 0; i < n; i++) {
        const h = hits[pick(hits.length)];
        const visitor = rand() < 0.05 ? h.visitor + 1 : h.visitor;
        const args = [pick(300), pick(101), h.id, visitor];
        sql.exec("BEGIN");
        const params = Object.fromEntries(args.map((v, i) => [i + 1, v])); // ?1..?4
        counted.run(params);
        update.run(params);
        sql.exec("COMMIT");
    }
}

const dump = (sql, table) => sql.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all();
const TABLES = ["host_daily", "page_daily", "ref_daily", "visitor_hosts"];

test("counters kept per hit match the migration's backfill from raw hits", () => {
    const hits = traffic();

    const live = new DatabaseSync(":memory:");
    live.exec(init);
    live.exec(counters);
    insertVisitors(live);
    collect(live, hits);
    beacons(live, hits);

    // Same hits and engagement, counted all at once by the migration.
    const backfilled = new DatabaseSync(":memory:");
    backfilled.exec(init);
    insertVisitors(backfilled);
    const insert = backfilled.prepare(
        `INSERT INTO hits (id, ts, site, host, page, visitor_id, entry_hit_id, src, engaged_s, scroll_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of live.prepare("SELECT * FROM hits ORDER BY id").all()) {
        insert.run(h.id, h.ts, h.site, h.host, h.page, h.visitor_id, h.entry_hit_id, h.src, h.engaged_s, h.scroll_pct);
    }
    backfilled.exec(counters);

    assert.ok(live.prepare("SELECT COUNT(*) AS n FROM hits WHERE engaged_s IS NOT NULL").get().n > 1000);
    assert.deepEqual(
        live.prepare("SELECT id, is_new FROM hits ORDER BY id").all(),
        backfilled.prepare("SELECT id, is_new FROM hits ORDER BY id").all(),
    );
    for (const table of TABLES) {
        assert.deepEqual(dump(live, table), dump(backfilled, table), table);
    }
});

test("counters answer periods ending today like a scan of the host's hits", () => {
    const hits = traffic();
    const sql = new DatabaseSync(":memory:");
    sql.exec(init);
    sql.exec(counters);
    insertVisitors(sql);
    collect(sql, hits);

    const today = Math.floor(hits.at(-1).ts / 86400);
    for (const days of [1, 7, 30, 60]) {
        const first = today - days + 1;
        for (const host of [2, 3, 5]) {
            const where = { 1: first, 2: host };
            const counted = sql
                .prepare(
                    `SELECT COUNT(*) AS visitors, IFNULL(SUM(first_seen >= ?1), 0) AS new,
                            IFNULL(SUM(first_seen >= ?1 AND hits = 1), 0) AS bounced
                     FROM visitor_hosts WHERE host = ?2 AND last_seen >= ?1`,
                )
                .get(where);
            // The old queries: distinct visitors, and the first-ever-hit and
            // no-later-hit checks against all of history.
            const scanned = sql
                .prepare(
                    `SELECT COUNT(DISTINCT h.visitor_id) AS visitors,
                            IFNULL(SUM(NOT EXISTS (SELECT 1 FROM hits p WHERE p.visitor_id = h.visitor_id
                                                   AND p.host = h.host AND p.id < h.id)), 0) AS new,
                            IFNULL(SUM(NOT EXISTS (SELECT 1 FROM hits p WHERE p.visitor_id = h.visitor_id
                                                   AND p.host = h.host AND p.id < h.id)
                                   AND NOT EXISTS (SELECT 1 FROM hits p WHERE p.visitor_id = h.visitor_id
                                                   AND p.host = h.host AND p.id > h.id)), 0) AS bounced
                     FROM hits h WHERE h.ts >= ?1 * 86400 AND h.host = ?2`,
                )
                .get(where);
            assert.deepEqual({ ...counted }, { ...scanned }, `host ${host}, ${days} days`);

            // Daily visitors (once per visitor per day), and page views and
            // arrivals from referrers in total.
            const one = (query) => ({ ...sql.prepare(query).get(where) });
            assert.deepEqual(
                sql.prepare("SELECT day, visitors FROM host_daily WHERE host = ?2 AND day >= ?1 ORDER BY day").all(where),
                sql.prepare(
                    `SELECT ts / 86400 AS day, COUNT(DISTINCT visitor_id) AS visitors FROM hits
                     WHERE host = ?2 AND ts / 86400 >= ?1 GROUP BY day ORDER BY day`,
                ).all(where),
            );
            assert.deepEqual(
                one("SELECT IFNULL(SUM(views), 0) AS n FROM page_daily WHERE host = ?2 AND day >= ?1"),
                one("SELECT COUNT(*) AS n FROM hits WHERE host = ?2 AND ts / 86400 >= ?1"),
            );
            assert.deepEqual(
                one("SELECT IFNULL(SUM(visits), 0) AS n FROM ref_daily WHERE host = ?2 AND day >= ?1"),
                one(`SELECT COUNT(*) AS n FROM hits WHERE host = ?2 AND ts / 86400 >= ?1
                     AND entry_hit_id = id AND src IS NOT NULL`),
            );
        }
    }
});

test("an end beacon that changes nothing writes nothing", () => {
    const sql = new DatabaseSync(":memory:");
    sql.exec(init);
    sql.exec(counters);
    insertVisitors(sql);
    collect(sql, traffic(1));
    const counted = sql.prepare(COUNT_END);
    const changes = (e, s, visitor = traffic(1)[0].visitor) => counted.run({ 1: e, 2: s, 3: 1, 4: visitor }).changes;
    const row = () => sql.prepare("SELECT engaged_sum, scroll_sum, samples FROM host_daily").get();

    assert.equal(changes(10, 50), 1);
    sql.prepare(endSql).run({ 1: 10, 2: 50, 3: 1, 4: traffic(1)[0].visitor });
    assert.deepEqual({ ...row() }, { engaged_sum: 10, scroll_sum: 50, samples: 1 });
    assert.equal(changes(10, 50), 0, "a repeat beacon");
    assert.equal(changes(5, 20), 0, "an older beacon");
    assert.equal(changes(99, 100, 999), 0, "someone else's hit");
});
