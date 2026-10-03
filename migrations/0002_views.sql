-- =============================================================================
-- Per-site counts, kept up to date as hits arrive, so the dashboard reads a
-- few summary rows instead of scanning `hits` (except for unique visitors
-- under a filter, which read an index on it).
--
-- Each site (hostname) is counted on its own, with its own visitors and
-- cookie. The collector updates these tables in the same batch (one
-- transaction) as the hit; the SQL is in src/worker/counters.ts. `hits` stays
-- as the raw record everything here can be rebuilt from.
--
-- Text is stored as text. (0001 kept each string once in `strings` and stored
-- ids; the space it saved isn't worth a lookup per hit and a join per query.)
--
-- Days are UTC day numbers (ts / 86400).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- hits: one row per scrolled page view.
--
--   source      where the view came from: the referring site's domain, or on
--               a click within the site, the previous page's path ("/..."); ''
--               when direct. Trips aren't tracked, so a click isn't credited to
--               how the reader first arrived.
--   read        the page was visible long enough to count as read (30 seconds
--               unless the tracker says otherwise); for old hits, 30 seconds
--               of their recorded visible time
--
-- Rebuilt in one pass rather than by dropping columns, which would rewrite
-- every row once per column. Dropped: `site` (now the same as `host`); `src`,
-- `entry_hit_id` and the other UTM values (replaced by `source`, or unused);
-- `engaged_s` and `scroll_pct` (replaced by `read`).
-- -----------------------------------------------------------------------------
CREATE TABLE hits_0002 (
    id         INTEGER PRIMARY KEY,
    ts         INTEGER NOT NULL DEFAULT (unixepoch()),  -- unix seconds, set by the DB
    host       TEXT NOT NULL,              -- "blog.you.com"
    page       TEXT NOT NULL,              -- "/posts/sqlite"
    visitor_id INTEGER NOT NULL,           -- visitors.id on this host
    source     TEXT NOT NULL DEFAULT '',   -- "news.ycombinator.com" or "/previous/page", '' = direct
    utm_source TEXT,
    read       INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO hits_0002 (id, ts, host, page, visitor_id, source, utm_source, read)
SELECT h.id, h.ts, host.value, substr(page.value, length(host.value) + 1), h.visitor_id,
       CASE WHEN h.entry_hit_id = h.id THEN IFNULL(src.value, '')
            -- a click within the site: its previous page, when it was on
            -- the same host (0001 stored pages as host + path)
            WHEN substr(src.value, 1, length(host.value) + 1) = host.value || '/'
            THEN substr(src.value, length(host.value) + 1)
            ELSE '' END,
       utm.value, IFNULL(h.engaged_s >= 30, 0)
FROM hits h
JOIN strings host ON host.id = h.host
JOIN strings page ON page.id = h.page
LEFT JOIN strings src ON src.id = h.src
LEFT JOIN strings utm ON utm.id = h.utm_source;

DROP INDEX hits_visitor_host;
DROP TABLE hits;
ALTER TABLE hits_0002 RENAME TO hits;

-- Unique visitors under a dashboard filter (src/worker/filtered.ts): a page's
-- or a source's hits in a period, with who made them, read from the index
-- alone. The dashboard's other numbers come from `views` and `visitors`.
CREATE INDEX hits_page ON hits (host, page, ts, visitor_id);
CREATE INDEX hits_source ON hits (host, source, ts, visitor_id);

-- Turned time ranges into id ranges for scans of hits, which nothing does now.
DROP TABLE days;


-- -----------------------------------------------------------------------------
-- visitors: one row per person per site, i.e. per cookie. Attributes come from
-- their first hit there.
--
-- Every dashboard period ends today, so "visited in the last N days" is
-- "last_day >= the first day": unique visitors are a count of rows here.
--
--   new in the period:          first_day >= first day
--   ...and never came back:     ... AND NOT returned
--
-- A row is only written on a visitor's first hit of a day (to move last_day
-- on) or their second hit ever (to set returned); other hits leave it alone.
--
-- Replaces 0001's `visitors`, which was shared by a site's subdomains; those
-- ids carry over, one row for each host they visited.
-- -----------------------------------------------------------------------------
CREATE TABLE visitors_0002 (
    host      TEXT NOT NULL,
    id        INTEGER NOT NULL,  -- stored in the cookie; random for new visitors
    first_day INTEGER NOT NULL,
    last_day  INTEGER NOT NULL,
    returned  INTEGER NOT NULL,  -- had more than one hit on the host
    country   TEXT,              -- from the browser's timezone, e.g. "DE"
    browser   TEXT,              -- e.g. "Chrome"
    os        TEXT,              -- e.g. "macOS"
    device    TEXT,              -- "desktop" | "mobile" | "tablet" | ...
    PRIMARY KEY (host, id)
) STRICT, WITHOUT ROWID;

INSERT INTO visitors_0002 (host, id, first_day, last_day, returned, country, browser, os, device)
SELECT h.host, h.visitor_id, MIN(h.ts) / 86400, MAX(h.ts) / 86400, COUNT(*) > 1,
       country.value, browser.value, os.value, device.value
FROM hits h
LEFT JOIN visitors o ON o.id = h.visitor_id
LEFT JOIN strings country ON country.id = o.country
LEFT JOIN strings browser ON browser.id = o.browser
LEFT JOIN strings os ON os.id = o.os
LEFT JOIN strings device ON device.id = o.device
GROUP BY h.host, h.visitor_id;

DROP TABLE visitors;
ALTER TABLE visitors_0002 RENAME TO visitors;

-- Everything the dashboard's visitor counts need, so they read only this.
CREATE INDEX visitors_recent ON visitors (host, last_day, first_day, returned, device);

DROP TABLE strings;


-- -----------------------------------------------------------------------------
-- views: counts per site, day, page and source (a referring site, or the
-- previous page on clicks within the site). Every number on the dashboard
-- except unique visitors is a SUM over these rows.
--
--   new       visitors' first hit on the site
--   visitors  each visitor once a day, on the row of their first hit that
--             day: SUM by day (unfiltered) is the day's unique visitors
--   reads     hits with read
-- -----------------------------------------------------------------------------
CREATE TABLE views (
    host     TEXT NOT NULL,
    day      INTEGER NOT NULL,
    page     TEXT NOT NULL,
    source   TEXT NOT NULL,  -- domain, "/path", or '' = direct
    views    INTEGER NOT NULL DEFAULT 0,
    new      INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0,
    reads    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host, day, page, source)
) STRICT, WITHOUT ROWID;

INSERT INTO views (host, day, page, source, views, new, visitors, reads)
SELECT host, day, page, source, COUNT(*), SUM(first_ever), SUM(first_today), SUM(read)
FROM (
    SELECT *, ts / 86400 AS day,
           ROW_NUMBER() OVER (PARTITION BY visitor_id, host ORDER BY id) = 1 AS first_ever,
           ROW_NUMBER() OVER (PARTITION BY visitor_id, host, ts / 86400 ORDER BY id) = 1 AS first_today
    FROM hits
)
GROUP BY host, day, page, source;
