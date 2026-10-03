// SQL that keeps the counter tables (migrations/0002_counters.sql) in step
// with `hits`. Kept free of imports so tests can run it against SQLite.

// Whether `visitor` has never been seen on `host`: the hit's is_new. Both are
// SQL expressions.
export const newToHost = (visitor: string, host: string) =>
    `NOT EXISTS (SELECT 1 FROM visitor_hosts WHERE visitor_id = ${visitor} AND host = ${host})`;

// The hit just inserted in the same batch.
const LATEST = `FROM hits h WHERE h.id = (SELECT MAX(id) FROM hits)`;

// Run, in this order, right after inserting a hit (no parameters). The
// host_daily statement reads the visitor's previous last_seen, so it must come
// before visitor_hosts is updated. (Each SELECT needs its WHERE, or SQLite
// can't tell its ON CONFLICT from a join's ON.)
export const COUNT_HIT = [
    `INSERT INTO host_daily (host, day, views, visitors, new)
     SELECT h.host, h.ts / 86400, 1,
            NOT EXISTS (SELECT 1 FROM visitor_hosts v
                        WHERE v.visitor_id = h.visitor_id AND v.host = h.host AND v.last_seen >= h.ts / 86400),
            h.is_new
     ${LATEST}
     ON CONFLICT (host, day) DO UPDATE SET
         views = views + 1, visitors = visitors + excluded.visitors, new = new + excluded.new`,

    `INSERT INTO page_daily (host, day, page, views, new)
     SELECT h.host, h.ts / 86400, h.page, 1, h.is_new
     ${LATEST}
     ON CONFLICT (host, day, page) DO UPDATE SET views = views + 1, new = new + excluded.new`,

    `INSERT INTO ref_daily (host, day, src, visits)
     SELECT h.host, h.ts / 86400, h.src, 1
     ${LATEST} AND h.entry_hit_id = h.id AND h.src IS NOT NULL
     ON CONFLICT (host, day, src) DO UPDATE SET visits = visits + 1`,

    `INSERT INTO visitor_hosts (visitor_id, host, first_seen, last_seen, hits)
     SELECT h.visitor_id, h.host, h.ts / 86400, h.ts / 86400, 1
     ${LATEST}
     ON CONFLICT (visitor_id, host) DO UPDATE SET last_seen = excluded.last_seen, hits = hits + 1`,
];

// Run just before the end beacon's UPDATE of the hit, with the same
// parameters (?1 engaged s, ?2 scroll %, ?3 hit id, ?4 visitor id). Adds how
// much each value goes up to the hit's day, and counts the hit as a sample
// the first time its engagement lands. Matches no row, so writes nothing,
// when the hit's UPDATE would change nothing.
export const COUNT_END = `UPDATE host_daily SET
    engaged_sum = engaged_sum + (SELECT MAX(IFNULL(engaged_s, 0), ?1) - IFNULL(engaged_s, 0) FROM hits WHERE id = ?3),
    scroll_sum = scroll_sum + (SELECT MAX(IFNULL(scroll_pct, 0), ?2) - IFNULL(scroll_pct, 0) FROM hits WHERE id = ?3),
    samples = samples + (SELECT engaged_s IS NULL FROM hits WHERE id = ?3)
WHERE (host, day) = (
    SELECT host, ts / 86400 FROM hits
    WHERE id = ?3 AND visitor_id = ?4
      AND (engaged_s IS NULL OR scroll_pct IS NULL OR engaged_s < ?1 OR scroll_pct < ?2)
)`;
