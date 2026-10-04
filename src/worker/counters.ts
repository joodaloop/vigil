// SQL that keeps `views` and `visitors` (schema.sql) in step
// with `hits`. Kept free of imports so tests can run it against SQLite.

// The hit just inserted in the same batch.
const LATEST = `FROM hits h WHERE h.id = (SELECT MAX(id) FROM hits)`;

// Run right after inserting a hit, before COUNT_VISITOR: it's new if the
// visitor has no row yet, and their first today if their last hit was
// before today. No parameters. (The SELECT needs its WHERE, or SQLite can't tell
// its ON CONFLICT from a join's ON.)
export const COUNT_VIEW = `INSERT INTO views (host, day, page, source, views, new, visitors)
    SELECT h.host, h.ts / 86400, h.page, h.source, 1,
           NOT EXISTS (SELECT 1 FROM visitors v WHERE v.host = h.host AND v.id = h.visitor_id),
           NOT EXISTS (SELECT 1 FROM visitors v
                       WHERE v.host = h.host AND v.id = h.visitor_id AND v.last_ts >= h.ts / 86400 * 86400)
    ${LATEST}
    ON CONFLICT (host, day, page, source) DO UPDATE SET
        views = views + 1, new = new + excluded.new, visitors = visitors + excluded.visitors`;

// Run last. Creates the visitor, with attributes bound as ?1 country,
// ?2 browser, ?3 os, ?4 device, or moves their last_ts on.
export const COUNT_VISITOR = `INSERT INTO visitors (host, id, first_ts, last_ts, country, browser, os, device)
    SELECT h.host, h.visitor_id, h.ts, h.ts, ?1, ?2, ?3, ?4
    ${LATEST}
    ON CONFLICT (host, id) DO UPDATE SET last_ts = excluded.last_ts`;

// Marking a hit read: run COUNT_READ, then READ_HIT, with ?1 = hit id and
// ?2 = visitor id (so nobody can mark someone else's hits). Both match
// nothing once the hit is read, so repeats write nothing.
export const COUNT_READ = `UPDATE views SET reads = reads + 1
WHERE (host, day, page, source) = (
    SELECT host, ts / 86400, page, source FROM hits WHERE id = ?1 AND visitor_id = ?2 AND read = 0
)`;

export const READ_HIT = `UPDATE hits SET read = 1 WHERE id = ?1 AND visitor_id = ?2 AND read = 0`;
