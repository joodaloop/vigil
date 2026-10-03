-- =============================================================================
-- Vigil schema
--
-- One row per *scrolled* page view, stored as small integers. All text lives
-- once in `strings`; every other column that looks like text is a strings.id.
--
-- Design rules:
--   * One secondary index, hits(visitor_id, host), for per-visitor history.
--     Everything else goes through an INTEGER PRIMARY KEY: time ranges via
--     `days`, trips via `hits.entry_hit_id`, people via `hits.visitor_id`.
--   * `hits.id` and `hits.ts` are both assigned inside the database at insert
--     time, so id order == time order. That's what makes `days` work.
--   * All times are unix seconds, UTC. Days are UTC days (ts / 86400).
--   * Engagement (engaged_s, scroll_pct) arrives later via a beacon and may stay
--     NULL. Averages should ignore NULLs (AVG() already does).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- strings: every distinct piece of text, stored once.
--
-- Values are whatever the collector stores, e.g.:
--   "you.com"                    a site (cookie domain)
--   "blog.you.com"               a host
--   "blog.you.com/posts/sqlite"  a page (host + path, no query string)
--   "news.ycombinator.com"       an external referrer domain ("www." stripped)
--   "US"                         a country (ISO 3166 alpha-2)
--   "Chrome", "macOS", "mobile"  browser / os / device
--   "newsletter"                 a UTM value
--
-- Pages and referrer domains never collide: a page always contains "/" after
-- the host, a referrer domain never does.
-- -----------------------------------------------------------------------------
CREATE TABLE strings (
    id    INTEGER PRIMARY KEY,
    value TEXT NOT NULL UNIQUE
) STRICT;


-- -----------------------------------------------------------------------------
-- visitors: one row per person, i.e. per `_v` cookie (one browser on one
-- device, for one cookie domain). Attributes are captured on the first hit and
-- not updated, so a traveller keeps their first country.
-- -----------------------------------------------------------------------------
CREATE TABLE visitors (
    id         INTEGER PRIMARY KEY,  -- sequential; stored in the _v cookie
    first_seen INTEGER NOT NULL,     -- unix seconds
    country    INTEGER,              -- strings.id, from the browser's timezone; NULL if unknown
    browser    INTEGER,              -- strings.id, e.g. "Chrome"
    os         INTEGER,              -- strings.id, e.g. "macOS"
    device     INTEGER               -- strings.id: "desktop" | "mobile" | "tablet" | ...
) STRICT;


-- -----------------------------------------------------------------------------
-- hits: one row per page view, recorded on the visitor's first real scroll.
--
-- A *trip* is a run of page views that starts with an *arrival* (a hit whose
-- referrer is external or empty) and continues through internal clicks.
--
--   arrival:  entry_hit_id = id,  src = external referrer domain (NULL = direct)
--   internal: entry_hit_id = the trip's arrival hit, src = previous page
--
-- Example: someone comes from Hacker News and clicks through two pages.
--
--   id   page                        src                          entry_hit_id
--   101  blog.you.com/posts/sqlite   news.ycombinator.com         101
--   102  blog.you.com/about          blog.you.com/posts/sqlite    101
--   103  blog.you.com/projects       blog.you.com/about           101
-- -----------------------------------------------------------------------------
CREATE TABLE hits (
    id           INTEGER PRIMARY KEY,
    ts           INTEGER NOT NULL DEFAULT (unixepoch()),  -- unix seconds, set by the DB
    site         INTEGER NOT NULL,   -- strings.id: cookie domain, "you.com"
    host         INTEGER NOT NULL,   -- strings.id: "blog.you.com"
    page         INTEGER NOT NULL,   -- strings.id: "blog.you.com/posts/sqlite"
    visitor_id   INTEGER NOT NULL,   -- visitors.id
    entry_hit_id INTEGER NOT NULL,   -- hits.id of this trip's arrival (= id on arrivals)
    src          INTEGER,            -- strings.id: arrival  -> external referrer domain, NULL = direct
                                     --             internal -> previous page
    utm_source   INTEGER,            -- strings.id, arrivals only, usually NULL
    utm_medium   INTEGER,            -- strings.id, arrivals only, usually NULL
    utm_campaign INTEGER,            -- strings.id, arrivals only, usually NULL
    engaged_s    INTEGER,            -- seconds the page was visible; NULL until the beacon lands
    scroll_pct   INTEGER             -- max scroll depth 0-100; NULL until the beacon lands
) STRICT;


-- A visitor's hits on a host, in id (= time) order. Answers "has this person
-- been here before?", "when did they first see this host?" and visitor
-- timelines without scanning all of history. ~10-12 bytes per hit.
CREATE INDEX hits_visitor_host ON hits (visitor_id, host);


-- -----------------------------------------------------------------------------
-- days: the first hit id of each UTC day that had traffic. Turns a time range
-- into an id range on the hits primary key. Written in the same transaction as
-- the hit (INSERT OR IGNORE), so it's exact.
-- -----------------------------------------------------------------------------
CREATE TABLE days (
    day          INTEGER PRIMARY KEY,  -- ts / 86400
    first_hit_id INTEGER NOT NULL
) STRICT;


-- =============================================================================
-- Query recipes
--
-- Every dashboard query starts from the same id range. For [t1, t2) in unix
-- seconds:
--
--   :lo = (SELECT first_hit_id FROM days WHERE day >= :t1 / 86400 ORDER BY day LIMIT 1)
--   :hi = (SELECT first_hit_id FROM days WHERE day >  (:t2 - 1) / 86400 ORDER BY day LIMIT 1)
--         -- NULL when t2 is in the latest day: treat as "no upper bound"
--
--   base range:
--     h.id >= :lo AND (:hi IS NULL OR h.id < :hi)
--     AND h.ts >= :t1 AND h.ts < :t2 AND h.site = :site
--
-- (If :lo is NULL there's no data in range.) Below, RANGE means that clause.
--
-- Filters, added to RANGE as needed:
--   subdomain       AND h.host = :host
--   page            AND h.page = :page
--   referrer        JOIN hits e ON e.id = h.entry_hit_id ... AND e.src = :ref
--   entry page      JOIN hits e ON e.id = h.entry_hit_id ... AND e.page = :entry
--   country         JOIN visitors v ON v.id = h.visitor_id ... AND v.country = :country
--   arrivals only   AND h.entry_hit_id = h.id
--
-- Counts:
--   SELECT COUNT(*)                     AS views,
--          COUNT(DISTINCT h.visitor_id) AS visitors,
--          COUNT(DISTINCT h.entry_hit_id) AS trips
--   FROM hits h WHERE RANGE;
--
-- Bounced trips (one page, then gone):
--   SELECT COUNT(*) FROM (
--     SELECT h.entry_hit_id FROM hits h WHERE RANGE
--     GROUP BY h.entry_hit_id HAVING COUNT(*) = 1
--   );
--
-- Views per UTC day:
--   SELECT h.ts / 86400 AS day, COUNT(*) FROM hits h WHERE RANGE GROUP BY day;
--   -- render with date(day * 86400, 'unixepoch') -> '2026-02-02'
--
-- Top pages, with engagement:
--   SELECT s.value, COUNT(*) AS views, COUNT(DISTINCT h.visitor_id) AS visitors,
--          AVG(h.engaged_s), AVG(h.scroll_pct)
--   FROM hits h JOIN strings s ON s.id = h.page
--   WHERE RANGE GROUP BY h.page ORDER BY views DESC LIMIT 20;
--
-- Top referrers (arrivals only; NULL src = direct):
--   SELECT s.value, COUNT(*) FROM hits h LEFT JOIN strings s ON s.id = h.src
--   WHERE RANGE AND h.entry_hit_id = h.id
--   GROUP BY h.src ORDER BY 2 DESC LIMIT 20;
--
-- Entry pages:
--   ...same as top pages, plus AND h.entry_hit_id = h.id
--
-- Everything readers from a referrer went on to read:
--   SELECT s.value, COUNT(*) FROM hits h
--   JOIN hits e ON e.id = h.entry_hit_id
--   JOIN strings s ON s.id = h.page
--   WHERE RANGE AND e.src = :ref GROUP BY h.page;
--
-- Where readers of page X went next:
--   SELECT s.value, COUNT(*) FROM hits h JOIN strings s ON s.id = h.page
--   WHERE RANGE AND h.src = :page_x GROUP BY h.page;
--
-- Countries / browsers / devices:
--   SELECT s.value, COUNT(DISTINCT h.visitor_id) FROM hits h
--   JOIN visitors v ON v.id = h.visitor_id
--   LEFT JOIN strings s ON s.id = v.country      -- or v.browser / v.device
--   WHERE RANGE GROUP BY v.country;
--
-- New to a host: the hit is the visitor's first ever hit on that host.
--   NOT EXISTS (SELECT 1 FROM hits p
--               WHERE p.visitor_id = h.visitor_id AND p.host = h.host AND p.id < h.id)
--   -- one index seek per hit; SUM() it as "new", or group it by page/source
--
-- Returning visitors (seen before this range):
--   SELECT COUNT(DISTINCT h.visitor_id) FROM hits h
--   JOIN visitors v ON v.id = h.visitor_id
--   WHERE RANGE AND v.first_seen < :t1;
--
-- Filter values arrive as text; resolve them first:
--   SELECT id FROM strings WHERE value = :text   -- no row -> filter matches nothing
-- =============================================================================
