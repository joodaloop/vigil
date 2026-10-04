import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COUNT_READ, COUNT_VIEW, COUNT_VISITOR, READ_HIT } from "../src/worker/counters.ts";
import { filteredVisitors } from "../src/worker/uniques.ts";
import { canonicalSource } from "../src/shared/referrers.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// Deterministic pseudo-random numbers, so a failure reproduces.
function random(seed) {
    return () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
    };
}

const HOSTS = ["a.test", "b.test", "c.test"];
const SITES = ["news.example", "search.example", "mail.example"];
const PAGES = ["/", "/one", "/two/", "/three", "/four"];
const DEVICES = ["desktop", "mobile", "tablet"];
const device = (visitor) => DEVICES[visitor % 3];

// Hits over 60 days on 3 hosts, in time order like the collector's: returning
// visitors, clicks within a site, and arrivals that are direct or from a few
// other sites. Some visitors use more than one host (as old site-wide cookies
// did); each host counts them separately.
function traffic(n = 3000) {
    const rand = random(42);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const hits = [];
    let ts = 20000 * 86400;
    for (let id = 1; id <= n; id++) {
        ts += 1 + Math.floor(rand() * ((60 * 86400) / n)) * 2; // no two hits in the same second
        const arrival = rand() < 0.4;
        hits.push({
            id,
            ts,
            host: pick(HOSTS),
            page: pick(PAGES),
            visitor: 1 + Math.floor(rand() * 400),
            // The referring site, '' if direct, or the previous page.
            source: arrival ? pick(["", ...SITES]) : pick(PAGES),
        });
    }
    return hits;
}

// What the collector does per hit (see handleHit): insert it, then count it.
function collect(sql, hits) {
    const insert = sql.prepare("INSERT INTO hits (id, ts, host, page, visitor_id, source) VALUES (?, ?, ?, ?, ?, ?)");
    const view = sql.prepare(COUNT_VIEW);
    const visitor = sql.prepare(COUNT_VISITOR);
    for (const h of hits) {
        sql.exec("BEGIN");
        insert.run(h.id, h.ts, h.host, h.page, h.visitor, h.source);
        view.run();
        visitor.run({ 1: null, 2: null, 3: null, 4: device(h.visitor) });
        sql.exec("COMMIT");
    }
}

// Marks a hit read as /_v/read does; returns the rows each statement changed.
function read(sql, id, visitor) {
    const params = { 1: id, 2: visitor };
    sql.exec("BEGIN");
    const changes = [sql.prepare(COUNT_READ).run(params).changes, sql.prepare(READ_HIT).run(params).changes];
    sql.exec("COMMIT");
    return changes;
}

// Reads, repeated, and some for other visitors' hits.
function reads(sql, hits, n = 3000) {
    const rand = random(7);
    for (let i = 0; i < n; i++) {
        const h = hits[Math.floor(rand() * hits.length)];
        read(sql, h.id, rand() < 0.05 ? h.visitor + 1 : h.visitor);
    }
}

function live(hits) {
    const sql = new DatabaseSync(":memory:");
    sql.exec(schema);
    collect(sql, hits);
    return sql;
}

test("sums over views and counts of visitors match scans of hits", () => {
    const hits = traffic();
    const sql = live(hits);
    reads(sql, hits);
    const today = Math.floor(hits.at(-1).ts / 86400);
    const all = (query, params) => sql.prepare(query).all(params).map((r) => ({ ...r }));
    // Each hit, and whether it's the visitor's first on the host.
    const RAW = `(SELECT h.*, h.ts / 86400 AS day,
                         NOT EXISTS (SELECT 1 FROM hits p WHERE p.visitor_id = h.visitor_id
                                     AND p.host = h.host AND p.id < h.id) AS first
                  FROM hits h)`;

    for (const days of [1, 7, 30, 60]) {
        const first = today - days + 1;
        for (const host of HOSTS) {
            const label = `${host}, ${days} days`;
            const where = { 1: host, 2: first };

            // Unique visitors, new visitors, bounces and devices in the period.
            assert.deepEqual(
                all(`SELECT COUNT(*) AS visitors, IFNULL(SUM(first_ts >= ?2 * 86400), 0) AS new,
                            IFNULL(SUM(first_ts >= ?2 * 86400 AND first_ts = last_ts), 0) AS bounced,
                            IFNULL(SUM(device = 'mobile'), 0) AS mobile
                     FROM visitors WHERE host = ?1 AND last_ts >= ?2 * 86400`, where),
                all(`SELECT COUNT(DISTINCT visitor_id) AS visitors, IFNULL(SUM(first), 0) AS new,
                            IFNULL(SUM(first AND NOT EXISTS (SELECT 1 FROM hits p WHERE p.visitor_id = r.visitor_id
                                       AND p.host = r.host AND p.id > r.id)), 0) AS bounced,
                            (SELECT COUNT(DISTINCT visitor_id) FROM hits WHERE host = ?1 AND ts / 86400 >= ?2
                             AND visitor_id % 3 = 1) AS mobile
                     FROM ${RAW} r WHERE host = ?1 AND day >= ?2`, where),
                label,
            );
            // The chart: views, unique visitors, new visitors and reads per day.
            assert.deepEqual(
                all(`SELECT day, SUM(views) AS views, SUM(visitors) AS visitors, SUM(new) AS new, SUM(reads) AS reads
                     FROM views WHERE host = ?1 AND day >= ?2 GROUP BY day`, where),
                all(`SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, SUM(first) AS new,
                            SUM(read) AS reads
                     FROM ${RAW} WHERE host = ?1 AND day >= ?2 GROUP BY day`, where),
                label,
            );
            // Pages, filtered by a source: where readers went from a site or a page.
            for (const source of ["", ...SITES, ...PAGES]) {
                assert.deepEqual(
                    all(`SELECT page, SUM(views) AS views, SUM(new) AS new FROM views
                         WHERE host = ?1 AND day >= ?2 AND source = ?3 GROUP BY page`, { ...where, 3: source }),
                    all(`SELECT page, COUNT(*) AS views, SUM(first) AS new FROM ${RAW}
                         WHERE host = ?1 AND day >= ?2 AND source = ?3 GROUP BY page`, { ...where, 3: source }),
                    `${label}, from ${source}`,
                );
            }
            // Sources, filtered by a page: where its readers came from.
            for (const page of PAGES) {
                assert.deepEqual(
                    all(`SELECT source, SUM(views) AS views FROM views
                         WHERE host = ?1 AND day >= ?2 AND page = ?3 AND source != '' GROUP BY source`, { ...where, 3: page }),
                    all(`SELECT source, COUNT(*) AS views FROM ${RAW}
                         WHERE host = ?1 AND day >= ?2 AND page = ?3 AND source != '' GROUP BY source`, { ...where, 3: page }),
                    `${label}, to ${page}`,
                );
            }
        }
    }
});

test("a hit is read once, and only by its own visitor", () => {
    const hits = traffic(1);
    const sql = live(hits);
    const visitor = hits[0].visitor;
    const row = () => ({ ...sql.prepare("SELECT reads FROM views").get() });

    assert.deepEqual(read(sql, 1, visitor + 1), [0, 0], "someone else's hit");
    assert.deepEqual(read(sql, 1, visitor), [1, 1]);
    assert.deepEqual(read(sql, 1, visitor), [0, 0], "a repeat writes nothing");
    assert.deepEqual(row(), { reads: 1 });
});

test("a visitor's row keeps their first and latest hit's time", () => {
    const sql = new DatabaseSync(":memory:");
    sql.exec(schema);
    const insert = sql.prepare("INSERT INTO hits (ts, host, page, visitor_id) VALUES (?, 'a.test', '/', 1)");
    const visitor = sql.prepare(COUNT_VISITOR);
    const row = () => ({ ...sql.prepare("SELECT first_ts, last_ts FROM visitors").get() });
    for (const ts of [1000, 1060, 90000]) {
        insert.run(ts);
        visitor.run({ 1: null, 2: null, 3: null, 4: "desktop" });
        assert.deepEqual(row(), { first_ts: 1000, last_ts: ts });
    }
});

test("visitors under a filter match a scan of the hits, through the covering indexes", () => {
    const hits = traffic();
    const sql = live(hits);
    const today = Math.floor(hits.at(-1).ts / 86400);
    const all = (query, params) => sql.prepare(query).all(...params).map((r) => ({ ...r }));
    // node:sqlite binds ?N placeholders by name rather than position, and only
    // the ones a query uses (D1 binds by position).
    const numbered = (query, params) => [
        Object.fromEntries(params.map((v, i) => [i + 1, v]).filter(([n]) => query.includes(`?${n}`))),
    ];
    const sorted = (rows) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    for (const days of [1, 30, 60]) {
        const first = today - days + 1;
        for (const host of HOSTS) {
            for (const [page, source] of [["/one", null], [null, "news.example"], [null, "/two/"], ["/", ""]]) {
                const f = filteredVisitors(host, first, page, source);
                const label = `${host}, ${days} days, page ${page}, source ${source}`;
                // Without the indexes, and with "never came back" from the hits.
                const match = `NOT INDEXED WHERE host = ? AND ts >= ? * 86400 ${page === null ? "" : "AND page = ?"}
                               ${source === null ? "" : "AND source = ?"}`;
                const params = [host, first, ...(page === null ? [] : [page]), ...(source === null ? [] : [source])];
                assert.deepEqual(
                    all(f.daily, numbered(f.daily, f.params)),
                    all(`SELECT ts / 86400 AS day, COUNT(DISTINCT visitor_id) AS visitors FROM hits ${match} GROUP BY day`, params),
                    label,
                );
                assert.deepEqual(
                    sorted(all(f.people, numbered(f.people, f.params))),
                    sorted(all(
                        `SELECT v.device, COUNT(*) AS visitors,
                                SUM((SELECT MIN(ts) / 86400 FROM hits p WHERE p.host = v.host AND p.visitor_id = v.id) >= ?
                                    AND (SELECT COUNT(*) FROM hits p WHERE p.host = v.host AND p.visitor_id = v.id) = 1) AS bounced
                         FROM (SELECT DISTINCT visitor_id FROM hits ${match}) f
                         JOIN visitors v ON v.host = ? AND v.id = f.visitor_id GROUP BY v.device`,
                        [first, ...params, host],
                    )),
                    label,
                );
            }
        }
    }

    const plan = (page, source) => {
        const f = filteredVisitors("a.test", today, page, source);
        return sql.prepare(`EXPLAIN QUERY PLAN ${f.daily}`).all(...numbered(f.daily, f.params)).map((r) => r.detail).join("; ");
    };
    assert.match(plan("/one", null), /COVERING INDEX hits_page/);
    assert.match(plan(null, "news.example"), /COVERING INDEX hits_source/);
});

test("referring sites are recorded under one domain each", () => {
    assert.equal(canonicalSource("t.co"), "x.com");
    assert.equal(canonicalSource("twitter.com"), "x.com");
    assert.equal(canonicalSource("mobile.twitter.com"), "x.com");
    assert.equal(canonicalSource("lnkd.in"), "linkedin.com");
    assert.equal(canonicalSource("old.reddit.com"), "reddit.com");
    assert.equal(canonicalSource("news.google.com"), "google.com");
    assert.equal(canonicalSource("someone.substack.com"), "someone.substack.com", "names the newsletter");
    assert.equal(canonicalSource("news.ycombinator.com"), "news.ycombinator.com");
    assert.equal(canonicalSource("example.org"), "example.org");
});
