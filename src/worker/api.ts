import type { HostStats, HostSummaries, Overview, PageRow, Referrer } from "../shared/types";
import { lookupIds } from "./strings";

// GET /api/overview?site=joodaloop.com&host=map.joodaloop.com&days=30
//   Totals, daily series, referrers and pages for one host.
// GET /api/hosts?site=joodaloop.com&days=30
//   Headline totals and daily series for every host on the site, unfiltered.
//
// Both cover the last `days` UTC days (today included) and run their queries
// in one D1 batch. The overview takes optional `ref` (referrer domain) and
// `page` (path) filters.

// ?1 = lo hit id, ?2 = period start (unix s), ?3 = site id
const RANGE = `h.id >= ?1 AND h.ts >= ?2 AND h.site = ?3`;

// This hit is the visitor's first ever hit on this host (index seek).
const IS_NEW = `NOT EXISTS (SELECT 1 FROM hits p
    WHERE p.visitor_id = h.visitor_id AND p.host = h.host AND p.id < h.id)`;

// ...and they never had another hit on this host afterwards.
const NEVER_AGAIN = `NOT EXISTS (SELECT 1 FROM hits p
    WHERE p.visitor_id = h.visitor_id AND p.host = h.host AND p.id > h.id)`;

type ReferrerRow = { domain: string; day: number; visits: number };
type DailyRow = { day: number; views: number; visitors: number; new: number };
type TotalRow = {
    views: number;
    visitors: number;
    scroll: number | null;
    engaged: number | null;
    new_bounced: number;
};
type DeviceRow = { device: string | null; visitors: number };
type PageDayRow = { page: string; day: number; views: number; visitors: number; new: number };
type HostDailyRow = DailyRow & { host: string };
type HostVisitorsRow = { host: string; visitors: number };

function emptyHost(n: number): HostStats {
    return {
        totals: {
            views: 0,
            avgScrollPct: null,
            avgEngagedS: null,
            visitors: 0,
            devices: { desktop: 0, tablet: 0, mobile: 0 },
            new: 0,
            newBounced: 0,
        },
        daily: { views: Array(n).fill(0), visitors: Array(n).fill(0), new: Array(n).fill(0) },
        referrers: [],
        pages: [],
    };
}

// The period and filters both endpoints share. `ids` are looked up alongside
// the site (and ref); unknown ones come back as -1.
async function period(env: Env, site: string, numDays: number, ref: string | null, names: string[] = []) {
    const today = Math.floor(Date.now() / 1000 / 86400);
    const firstDay = today - numDays + 1;
    const start = firstDay * 86400;
    const days = Array.from({ length: numDays }, (_, i) => (firstDay + i) * 86400);

    const [siteId, ...ids] = await lookupIds(env.DB, [site, ...names, ...(ref ? [ref] : [])]);
    const refId = ref ? ids.pop()! : null;
    const lo = await env.DB.prepare("SELECT first_hit_id FROM days WHERE day >= ? ORDER BY day LIMIT 1")
        .bind(firstDay)
        .first<number>("first_hit_id");

    // The referrer filter keeps hits whose trip arrived from `ref`, bound
    // after the query's own parameters (`n` of them, from ?1).
    //
    // NOT INDEXED: scan `h` by id range only. Otherwise SQLite may count
    // distinct visitors by walking the whole hits_visitor_host index, which
    // reads (and bills) every hit ever recorded instead of just the period.
    const from = (n: number) =>
        ref ? `hits h NOT INDEXED JOIN hits e ON e.id = h.entry_hit_id AND e.src = ?${n + 1}` : `hits h NOT INDEXED`;
    const bind = (sql: string, params: unknown[], filtered = true) =>
        env.DB.prepare(sql).bind(...params, ...(filtered && ref ? [refId] : []));

    return { firstDay, start, days, siteId, ids, lo, from, bind, empty: siteId < 0 || lo === null };
}

async function overview(
    env: Env,
    site: string,
    host: string,
    numDays: number,
    ref: string | null,
    page: string | null,
): Promise<Overview> {
    const p = await period(env, site, numDays, ref, page ? [host, host + page] : [host]);
    const result: Overview = { days: p.days, ref, page, stats: emptyHost(numDays) };
    const [hostId, pageId] = p.ids;
    if (p.empty || hostId < 0) return result;

    // ?4 = host id; ?5 = referrer, when filtering.
    const params = [p.lo, p.start, p.siteId, hostId];
    const FROM = p.from(4);
    const SEL = `${RANGE} AND h.host = ?4`;
    // The page filter. Ids come from the database as integers, so it's safe
    // to put in the SQL; an unknown page (-1) matches nothing.
    const ON_PAGE = page ? `AND h.page = ${pageId}` : "";
    const q = (sql: string, filtered = true) => p.bind(sql, params, filtered);

    // Each list ignores its own filter, so every option stays listed while
    // one is picked.
    const [referrers, daily, totals, devices, pages] = (await env.DB.batch([
        // Visits (trips) by the referrer they arrived from: those that start on
        // this host or, with a page picked, that reach that page.
        q(
            page
                ? `SELECT s.value AS domain, g.day, g.visits FROM (
                       SELECT e.src, h.ts / 86400 AS day, COUNT(DISTINCT h.entry_hit_id) AS visits
                       FROM hits h NOT INDEXED JOIN hits e ON e.id = h.entry_hit_id
                       WHERE ${SEL} ${ON_PAGE} AND e.src IS NOT NULL
                       GROUP BY e.src, day
                   ) g JOIN strings s ON s.id = g.src`
                : `SELECT s.value AS domain, g.day, g.visits FROM (
                       SELECT h.src, h.ts / 86400 AS day, COUNT(*) AS visits
                       FROM hits h NOT INDEXED
                       WHERE ${SEL} AND h.entry_hit_id = h.id AND h.src IS NOT NULL
                       GROUP BY h.src, day
                   ) g JOIN strings s ON s.id = g.src`,
            false,
        ),
        q(`SELECT h.ts / 86400 AS day, COUNT(*) AS views,
                  COUNT(DISTINCT h.visitor_id) AS visitors, SUM(${IS_NEW}) AS new
           FROM ${FROM} WHERE ${SEL} ${ON_PAGE} GROUP BY day`),
        q(`SELECT COUNT(*) AS views, COUNT(DISTINCT h.visitor_id) AS visitors,
                  AVG(h.scroll_pct) AS scroll, AVG(h.engaged_s) AS engaged,
                  SUM(${IS_NEW} AND ${NEVER_AGAIN}) AS new_bounced
           FROM ${FROM} WHERE ${SEL} ${ON_PAGE}`),
        q(`SELECT d.value AS device, g.visitors FROM (
               SELECT v.device, COUNT(DISTINCT h.visitor_id) AS visitors
               FROM ${FROM} JOIN visitors v ON v.id = h.visitor_id
               WHERE ${SEL} ${ON_PAGE} GROUP BY v.device
           ) g LEFT JOIN strings d ON d.id = g.device`),
        // Per page and day. Each visitor counts on the day of their first view
        // of the page, so the days add up to the period's distinct visitors.
        q(`SELECT p.value AS page, g.day, g.views, g.visitors, g.new FROM (
               SELECT page, day, COUNT(*) AS views, SUM(first) AS visitors, SUM(new) AS new FROM (
                   SELECT h.page, h.ts / 86400 AS day, ${IS_NEW} AS new,
                          ROW_NUMBER() OVER (PARTITION BY h.page, h.visitor_id ORDER BY h.id) = 1 AS first
                   FROM ${FROM} WHERE ${SEL}
               ) GROUP BY page, day
           ) g JOIN strings p ON p.id = g.page`),
    ])) as [
        D1Result<ReferrerRow>,
        D1Result<DailyRow>,
        D1Result<TotalRow>,
        D1Result<DeviceRow>,
        D1Result<PageDayRow>,
    ];

    const stats = result.stats;

    const refs = new Map<string, Referrer>();
    for (const r of referrers.results) {
        let entry = refs.get(r.domain);
        if (!entry) refs.set(r.domain, (entry = { domain: r.domain, visits: 0, daily: Array(numDays).fill(0) }));
        entry.visits += r.visits;
        entry.daily[r.day - p.firstDay] = r.visits;
    }
    stats.referrers = [...refs.values()].sort((a, b) => b.visits - a.visits);

    for (const r of daily.results) {
        const i = r.day - p.firstDay;
        stats.daily.views[i] = r.views;
        stats.daily.visitors[i] = r.visitors;
        stats.daily.new[i] = r.new;
        stats.totals.new += r.new; // each visitor is new on a host at most once
    }
    const t = totals.results[0];
    if (t) {
        Object.assign(stats.totals, {
            views: t.views,
            visitors: t.visitors,
            avgScrollPct: t.scroll,
            avgEngagedS: t.engaged,
            newBounced: t.new_bounced ?? 0,
        });
    }
    for (const r of devices.results) {
        const d = stats.totals.devices;
        if (r.device === "mobile" || r.device === "tablet") d[r.device] += r.visitors;
        else d.desktop += r.visitors; // desktop, plus rare types (console, smarttv)
    }
    const byPage = new Map<string, PageRow>();
    for (const r of pages.results) {
        let row = byPage.get(r.page);
        if (!row) {
            const path = r.page.slice(host.length) || "/"; // "blog.you.com/posts/x" -> "/posts/x"
            byPage.set(r.page, (row = { path, views: 0, visitors: 0, new: 0, daily: Array(numDays).fill(0) }));
        }
        row.views += r.views;
        row.visitors += r.visitors;
        row.new += r.new;
        row.daily[r.day - p.firstDay] = r.views;
    }
    stats.pages = [...byPage.values()].sort((a, b) => b.views - a.views);

    return result;
}

async function hostSummaries(env: Env, site: string, numDays: number): Promise<HostSummaries> {
    const p = await period(env, site, numDays, null);
    const result: HostSummaries = { days: p.days, hosts: {} };
    if (p.empty) return result;

    const params = [p.lo, p.start, p.siteId];
    const FROM = p.from(3);
    const q = (sql: string) => p.bind(sql, params);

    const [daily, visitors] = (await env.DB.batch([
        q(`SELECT s.value AS host, g.day, g.views, g.visitors, g.new FROM (
               SELECT h.host, h.ts / 86400 AS day, COUNT(*) AS views,
                      COUNT(DISTINCT h.visitor_id) AS visitors, SUM(${IS_NEW}) AS new
               FROM ${FROM} WHERE ${RANGE} GROUP BY h.host, day
           ) g JOIN strings s ON s.id = g.host`),
        // Distinct over the whole period; per-day counts would overlap.
        q(`SELECT s.value AS host, g.visitors FROM (
               SELECT h.host, COUNT(DISTINCT h.visitor_id) AS visitors
               FROM ${FROM} WHERE ${RANGE} GROUP BY h.host
           ) g JOIN strings s ON s.id = g.host`),
    ])) as [D1Result<HostDailyRow>, D1Result<HostVisitorsRow>];

    const zeros = () => Array(numDays).fill(0);
    const host = (name: string) =>
        (result.hosts[name] ??= {
            totals: { views: 0, visitors: 0, new: 0 },
            daily: { views: zeros(), visitors: zeros(), new: zeros() },
        });
    for (const r of daily.results) {
        const h = host(r.host);
        const i = r.day - p.firstDay;
        h.daily.views[i] = r.views;
        h.daily.visitors[i] = r.visitors;
        h.daily.new[i] = r.new;
        h.totals.views += r.views;
        h.totals.new += r.new;
    }
    for (const r of visitors.results) host(r.host).totals.visitors = r.visitors;

    return result;
}

export async function handleApi(url: URL, env: Env): Promise<Response> {
    const site = url.searchParams.get("site") ?? "";
    const days = Math.min(366, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const ref = url.searchParams.get("ref") || null;
    const json = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });

    if (url.pathname === "/api/overview") {
        const host = url.searchParams.get("host") ?? "";
        const page = url.searchParams.get("page") || null;
        return json(await overview(env, site, host, days, ref, page));
    }
    if (url.pathname === "/api/hosts") {
        return json(await hostSummaries(env, site, days));
    }
    return new Response("Not found", { status: 404 });
}
