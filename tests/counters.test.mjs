import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COUNT_READ, COUNT_VIEW, COUNT_VISITOR, READ_HIT } from "../src/worker/counters.ts";
import { filteredVisitors } from "../src/worker/filtered.ts";
import { canonicalSource } from "../src/shared/referrers.ts";

const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const init = migration("0001_init.sql");
const views = migration("0002_views.sql");

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
        ts += Math.floor(rand() * ((60 * 86400) / n)) * 2;
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
    sql.exec(init);
    sql.exec(views);
    collect(sql, hits);
    return sql;
}

// Hits as the old collector (0001) recorded them, then migrated: text as ids
// into `strings`, pages as host + path, arrivals pointing at themselves with
// the referring site in `src`, clicks within the site pointing elsewhere with
// the previous page in `src`, and visible time standing in for reads (30
// seconds is a read).
function migrated(rows) {
    const sql = new DatabaseSync(":memory:");
    sql.exec(init);
    const intern = (value) => {
        if (value == null || value === "") return null;
        sql.prepare("INSERT OR IGNORE INTO strings (value) VALUES (?)").run(value);
        return sql.prepare("SELECT id FROM strings WHERE value = ?").get(value).id;
    };
    const visitor = sql.prepare("INSERT OR IGNORE INTO visitors (id, first_seen, device) VALUES (?, 0, ?)");
    const insert = sql.prepare(
        `INSERT INTO hits (id, ts, site, host, page, visitor_id, entry_hit_id, src, engaged_s)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of rows) {
        visitor.run(h.visitor_id, intern(device(h.visitor_id)));
        const click = h.source.startsWith("/");
        const engaged = h.read ? 30 + (h.id % 100) : h.id % 2 ? null : 29;
        insert.run(
            h.id,
            h.ts,
            intern(h.host),
            intern(h.host + h.page),
            h.visitor_id,
            click ? 0 : h.id,
            intern(click ? h.host + h.source : h.source),
            engaged,
        );
    }
    sql.exec(views);
    return sql;
}

const dump = (sql, table) => sql.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4`).all();

test("counting per hit matches the migration's backfill from raw hits", () => {
    const hits = traffic();
    const sql = live(hits);
    reads(sql, hits);
    const rows = sql.prepare("SELECT * FROM hits ORDER BY id").all();
    const backfilled = migrated(rows);

    assert.ok(rows.filter((h) => h.read).length > 1000);
    for (const table of ["hits", "views", "visitors"]) {
        assert.deepEqual(dump(sql, table), dump(backfilled, table), table);
    }
});

test("the backfill keeps arrivals' referrers and clicks' previous pages, and splits visitors by host", () => {
    // An old trip: an arrival from news.example, a click within the site,
    // then a click across to another host.
    const old = new DatabaseSync(":memory:");
    old.exec(init);
    old.exec(`
        INSERT INTO strings (id, value) VALUES (1, 'a.test'), (2, 'b.test'), (3, 'a.test/one'), (4, 'a.test/two'),
            (5, 'b.test/three'), (6, 'news.example');
        INSERT INTO visitors (id, first_seen) VALUES (7, 0);
        INSERT INTO hits (id, ts, site, host, page, visitor_id, entry_hit_id, src, engaged_s) VALUES
            (1, 86400, 1, 1, 3, 7, 1, 6, 45),
            (2, 86401, 1, 1, 4, 7, 1, 3, NULL),
            (3, 86402, 1, 2, 5, 7, 1, 4, 10);`);
    old.exec(views);
    assert.deepEqual(
        old.prepare("SELECT id, host, page, source, read FROM hits ORDER BY id").all().map((r) => ({ ...r })),
        [
            { id: 1, host: "a.test", page: "/one", source: "news.example", read: 1 },
            { id: 2, host: "a.test", page: "/two", source: "/one", read: 0 },
            { id: 3, host: "b.test", page: "/three", source: "", read: 0 },
        ],
    );
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM visitors").get().n, 2, "one visitor per host");
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'strings'").get().n, 0);
});

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
                all(`SELECT COUNT(*) AS visitors, IFNULL(SUM(first_day >= ?2), 0) AS new,
                            IFNULL(SUM(first_day >= ?2 AND NOT returned), 0) AS bounced,
                            IFNULL(SUM(device = 'mobile'), 0) AS mobile
                     FROM visitors WHERE host = ?1 AND last_day >= ?2`, where),
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

test("a visitor's row is only written on their first hit of a day or their second ever", () => {
    const sql = new DatabaseSync(":memory:");
    sql.exec(init);
    sql.exec(views);
    const insert = sql.prepare("INSERT INTO hits (ts, host, page, visitor_id) VALUES (?, 'a.test', '/', 1)");
    const visitor = sql.prepare(COUNT_VISITOR);
    const hit = (ts) => {
        insert.run(ts);
        return visitor.run({ 1: null, 2: null, 3: null, 4: "desktop" }).changes;
    };
    const day = 20000 * 86400;
    assert.equal(hit(day), 1, "first ever");
    assert.equal(hit(day + 60), 1, "second ever");
    assert.equal(hit(day + 120), 0, "again the same day");
    assert.equal(hit(day + 86400), 1, "first of the next day");
    assert.equal(hit(day + 86460), 0, "again that day");
    assert.deepEqual({ ...sql.prepare("SELECT first_day, last_day, returned FROM visitors").get() }, {
        first_day: 20000,
        last_day: 20001,
        returned: 1,
    });
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

test("the migration records each referring site under the same domain as the collector", () => {
    const domains = ["google.com", "news.google.com", "t.co", "twitter.com", "mobile.twitter.com", "x.com", "lnkd.in",
        "linkedin.com", "old.reddit.com", "l.facebook.com", "m.youtube.com", "someone.substack.com", "news.ycombinator.com",
        "search.brave.com", "mastodon.social", "example.org", "blog.example.net"];
    const old = new DatabaseSync(":memory:");
    old.exec(init);
    old.exec("INSERT INTO strings (id, value) VALUES (1, 'a.test'), (2, 'a.test/')");
    domains.forEach((d, i) => {
        old.prepare("INSERT INTO strings (id, value) VALUES (?, ?)").run(10 + i, d);
        old.prepare(`INSERT INTO hits (id, ts, site, host, page, visitor_id, entry_hit_id, src)
                     VALUES (?, 86400, 1, 1, 2, 1, ?, ?)`).run(i + 1, i + 1, 10 + i);
    });
    old.exec(views);
    assert.deepEqual(
        old.prepare("SELECT source FROM hits ORDER BY id").all().map((r) => r.source),
        domains.map(canonicalSource),
    );
    assert.equal(canonicalSource("t.co"), "x.com");
    assert.equal(canonicalSource("someone.substack.com"), "someone.substack.com");
});
