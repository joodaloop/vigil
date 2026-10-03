-- =============================================================================
-- Counters kept up to date as hits arrive, so the dashboard's unfiltered view
-- reads a few summary rows instead of scanning every hit in the period.
--
-- The collector updates these in the same batch (one transaction) as the hit;
-- the SQL is in src/worker/counters.ts. Filtered views (by referrer or page)
-- still query `hits` directly.
--
-- Days are UTC day numbers (ts / 86400), like `days.day`.
-- =============================================================================


-- Whether the hit is the visitor's first ever hit on its host. Set on insert,
-- from `visitor_hosts`, so queries never look back through a visitor's history.
--
-- Everything here is kept per host, which is what the dashboard shows. The
-- site (cookie domain) only matters when collecting, so a host keeps its
-- history if its site changes in the config.
ALTER TABLE hits ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0;

UPDATE hits SET is_new = 1
WHERE id IN (SELECT MIN(id) FROM hits GROUP BY visitor_id, host);


-- -----------------------------------------------------------------------------
-- visitor_hosts: one row per visitor per host they've viewed.
--
-- Every dashboard period ends today, so "visited in the last N days" is
-- "last_seen >= the first day", which makes unique visitors a count of rows
-- here rather than a COUNT(DISTINCT) over hits. (It can't answer a range that
-- ends in the past; those need `hits`.)
--
--   new in the period:          first_seen >= first day
--   ...and never came back:     ... AND hits = 1
-- -----------------------------------------------------------------------------
CREATE TABLE visitor_hosts (
    visitor_id INTEGER NOT NULL,  -- visitors.id
    host       INTEGER NOT NULL,  -- strings.id
    first_seen INTEGER NOT NULL,  -- day of their first hit on the host
    last_seen  INTEGER NOT NULL,  -- day of their latest hit on the host
    hits       INTEGER NOT NULL,  -- hits on the host, ever
    PRIMARY KEY (visitor_id, host)
) STRICT, WITHOUT ROWID;

CREATE INDEX visitor_hosts_recent ON visitor_hosts (host, last_seen);

INSERT INTO visitor_hosts (visitor_id, host, first_seen, last_seen, hits)
SELECT visitor_id, host, MIN(ts) / 86400, MAX(ts) / 86400, COUNT(*)
FROM hits GROUP BY visitor_id, host;


-- -----------------------------------------------------------------------------
-- host_daily: per host per day. `visitors` counts each visitor once a day (on
-- their first hit on the host that day), so it doesn't add up across days. Engagement is kept as sums over the hits whose beacon has
-- landed (`samples`), credited to the hit's day; averages are sum / samples.
-- -----------------------------------------------------------------------------
CREATE TABLE host_daily (
    host        INTEGER NOT NULL,  -- strings.id
    day         INTEGER NOT NULL,
    views       INTEGER NOT NULL DEFAULT 0,
    visitors    INTEGER NOT NULL DEFAULT 0,
    new         INTEGER NOT NULL DEFAULT 0,  -- hits with is_new
    engaged_sum INTEGER NOT NULL DEFAULT 0,  -- seconds
    scroll_sum  INTEGER NOT NULL DEFAULT 0,  -- percent
    samples     INTEGER NOT NULL DEFAULT 0,  -- hits with engagement
    PRIMARY KEY (host, day)
) STRICT, WITHOUT ROWID;

INSERT INTO host_daily (host, day, views, visitors, new, engaged_sum, scroll_sum, samples)
SELECT host, ts / 86400 AS day, COUNT(*), COUNT(DISTINCT visitor_id), SUM(is_new),
       IFNULL(SUM(engaged_s), 0), IFNULL(SUM(scroll_pct), 0), COUNT(engaged_s)
FROM hits GROUP BY host, day;


-- page_daily: views and new visitors per page per day.
CREATE TABLE page_daily (
    host  INTEGER NOT NULL,  -- strings.id
    day   INTEGER NOT NULL,
    page  INTEGER NOT NULL,  -- strings.id
    views INTEGER NOT NULL DEFAULT 0,
    new   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host, day, page)
) STRICT, WITHOUT ROWID;

INSERT INTO page_daily (host, day, page, views, new)
SELECT host, ts / 86400 AS day, page, COUNT(*), SUM(is_new)
FROM hits GROUP BY host, day, page;


-- ref_daily: arrivals on a host from each external referrer, per day. Direct
-- arrivals (src NULL) aren't counted.
CREATE TABLE ref_daily (
    host   INTEGER NOT NULL,  -- strings.id
    day    INTEGER NOT NULL,
    src    INTEGER NOT NULL,  -- strings.id: referrer domain
    visits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host, day, src)
) STRICT, WITHOUT ROWID;

INSERT INTO ref_daily (host, day, src, visits)
SELECT host, ts / 86400 AS day, src, COUNT(*)
FROM hits WHERE entry_hit_id = id AND src IS NOT NULL GROUP BY host, day, src;


-- Was only used to look back through a visitor's hits ("new", "never came
-- back"), which `is_new` and `visitor_hosts` now answer. Dropping it saves an
-- index write per hit.
DROP INDEX hits_visitor_host;
