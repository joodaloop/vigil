-- =============================================================================
-- Vigil schema. Safe to run on every deploy: it only creates what's missing.
--
--   hits      one row per scrolled page view: the raw record
--   visitors  one row per reader per site: unique visitors, new, bounced
--   views     counts per site, day, page and source: every other number
--
-- Each site (hostname) is counted on its own, with its own visitors and
-- cookie. The collector adds to `views` and `visitors` in the same batch (one
-- transaction) as the hit; that SQL is in src/worker/counters.ts. Unique
-- visitors under a dashboard filter are counted from `hits` through its
-- indexes (src/worker/uniques.ts).
--
-- Times are unix seconds, UTC; days are UTC day numbers (ts / 86400).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- hits: one row per page view, recorded on the visitor's first real scroll.
--
--   source  where the view came from: the referring site's domain, one per
--           site ("t.co" is recorded as "x.com", "old.reddit.com" as
--           "reddit.com"; see src/shared/referrers.ts), or on a click within
--           the site, the previous page's path ("/..."); '' when direct
--   read    the page was visible long enough to count as read (30 seconds
--           unless the tracker's data-read-after says otherwise)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hits (
    id         INTEGER PRIMARY KEY,
    ts         INTEGER NOT NULL DEFAULT (unixepoch()),  -- set by the DB, so id order is time order
    host       TEXT NOT NULL,              -- "blog.you.com"
    page       TEXT NOT NULL,              -- "/posts/sqlite"
    visitor_id INTEGER NOT NULL,           -- visitors.id on this host
    source     TEXT NOT NULL DEFAULT '',   -- "news.ycombinator.com" or "/previous/page", '' = direct
    utm_source TEXT,
    read       INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Unique visitors under a dashboard filter: a page's or a source's hits in a
-- period, with who made them, read from the index alone.
CREATE INDEX IF NOT EXISTS hits_page ON hits (host, page, ts, visitor_id);
CREATE INDEX IF NOT EXISTS hits_source ON hits (host, source, ts, visitor_id);


-- -----------------------------------------------------------------------------
-- visitors: one row per person per site, i.e. per cookie. Attributes come from
-- their first hit there.
--
-- Every dashboard period ends today, so "visited in the period" is
-- "last_ts >= its start": unique visitors are a count of rows here.
--
--   new in the period:          first_ts >= start
--   ...and never came back:     ... AND first_ts = last_ts (one hit, ever)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visitors (
    host      TEXT NOT NULL,
    id        INTEGER NOT NULL,  -- stored in the cookie; random for new visitors
    first_ts  INTEGER NOT NULL,  -- their first hit on the host
    last_ts   INTEGER NOT NULL,  -- ...and their latest
    country   TEXT,              -- from the browser's timezone, e.g. "DE"
    browser   TEXT,              -- e.g. "Chrome"
    os        TEXT,              -- e.g. "macOS"
    device    TEXT,              -- "desktop" | "mobile" | "tablet" | ...
    PRIMARY KEY (host, id)
) STRICT, WITHOUT ROWID;

-- Everything the dashboard's visitor counts need, so they read only this.
CREATE INDEX IF NOT EXISTS visitors_recent ON visitors (host, last_ts, first_ts, device);


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
CREATE TABLE IF NOT EXISTS views (
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
