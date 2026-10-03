import type { HostStats, HostSummaries, Overview, PageRow, Referrer } from "../shared/types";
import { lookupIds } from "./strings";

// GET /api/overview?host=blog.example.co.uk&days=30
//   Totals, daily series, referrers and pages for one host.
// GET /api/hosts?days=30
//   Headline totals and daily series for every configured host, unfiltered.
//
// Everything is per host. Sites (cookie domains) only matter when collecting.
//
// Both cover the last `days` UTC days (today included) and run their queries
// in one D1 batch. The overview takes optional `ref` (referrer domain) and
// `page` (path) filters.
//
// Unfiltered numbers come from the counter tables (migrations/0002), which
// the collector keeps up to date: a few rows per day plus one per visitor.
// Filtered ones scan `hits` in the period.

// ?1 = lo hit id, ?2 = period start (unix s), ?3 = host id
const RANGE = `h.id >= ?1 AND h.ts >= ?2 AND h.host = ?3`;

// A new visitor's hit that was their only one on the host, ever.
const BOUNCED = `h.is_new AND (SELECT hits FROM visitor_hosts v
    WHERE v.visitor_id = h.visitor_id AND v.host = h.host) = 1`;

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
type PageDayRow = { page: string; day: number; views: number; new: number };
type CountedDayRow = DailyRow & { engaged_sum: number; scroll_sum: number; samples: number };
type CountedDeviceRow = DeviceRow & { bounced: number };
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

// The period and filters both endpoints share. `ids` are the strings ids of
// `names` (and ref, kept separately); unknown ones come back as -1.
async function period(env: Env, numDays: number, ref: string | null, names: string[]) {
    const today = Math.floor(Date.now() / 1000 / 86400);
    const firstDay = today - numDays + 1;
    const start = firstDay * 86400;
    const days = Array.from({ length: numDays }, (_, i) => (firstDay + i) * 86400);

    const ids = await lookupIds(env.DB, [...names, ...(ref ? [ref] : [])]);
    const refId = ref ? ids.pop()! : null;
    const lo = await env.DB.prepare("SELECT first_hit_id FROM days WHERE day >= ? ORDER BY day LIMIT 1")
        .bind(firstDay)
        .first<number>("first_hit_id");

    // The referrer filter keeps hits whose trip arrived from `ref`, bound
    // after the query's own parameters (`n` of them, from ?1).
    //
    // NOT INDEXED: scan `h` by id range only, so a query reads (and is billed
    // for) the period's hits rather than walking an index over all of them.
    const from = (n: number) =>
        ref ? `hits h NOT INDEXED JOIN hits e ON e.id = h.entry_hit_id AND e.src = ?${n + 1}` : `hits h NOT INDEXED`;
    const bind = (sql: string, params: unknown[], filtered = true) =>
        env.DB.prepare(sql).bind(...params, ...(filtered && ref ? [refId] : []));

    return { firstDay, start, days, ids, lo, from, bind, empty: lo === null };
}

async function overview(
    env: Env,
    host: string,
    numDays: number,
    ref: string | null,
    page: string | null,
): Promise<Overview> {
    const p = await period(env, numDays, ref, page ? [host, host + page] : [host]);
    const result: Overview = { days: p.days, ref, page, stats: emptyHost(numDays) };
    const [hostId, pageId] = p.ids;
    if (p.empty || hostId < 0) return result;

    // Raw queries: ?4 = referrer, when filtering.
    const params = [p.lo, p.start, hostId];
    const FROM = p.from(3);
    const SEL = RANGE;
    // The page filter. Ids come from the database as integers, so it's safe
    // to put in the SQL; an unknown page (-1) matches nothing.
    const ON_PAGE = page ? `AND h.page = ${pageId}` : "";
    const q = (sql: string, filtered = true) => p.bind(sql, params, filtered);
    // Counter queries: ?1 = first day, ?2 = host id.
    const c = (sql: string) => env.DB.prepare(sql).bind(p.firstDay, hostId);

    // Each list ignores its own filter, so every option stays listed while
    // one is picked; a list with no other filter on it reads the counters.
    const counted = !ref && !page;
    const [referrers, pages, daily, people, totals] = (await env.DB.batch([
        // Visits (trips) by the referrer they arrived from: those that start on
        // this host or, with a page picked, that reach that page.
        page
            ? q(
                  `SELECT s.value AS domain, g.day, g.visits FROM (
                       SELECT e.src, h.ts / 86400 AS day, COUNT(DISTINCT h.entry_hit_id) AS visits
                       FROM hits h NOT INDEXED JOIN hits e ON e.id = h.entry_hit_id
                       WHERE ${SEL} ${ON_PAGE} AND e.src IS NOT NULL
                       GROUP BY e.src, day
                   ) g JOIN strings s ON s.id = g.src`,
                  false,
              )
            : c(`SELECT s.value AS domain, r.day, r.visits
                 FROM ref_daily r JOIN strings s ON s.id = r.src
                 WHERE r.host = ?2 AND r.day >= ?1`),
        // Views and new visitors per page and day.
        ref
            ? q(`SELECT p.value AS page, g.day, g.views, g.new FROM (
                     SELECT h.page, h.ts / 86400 AS day, COUNT(*) AS views, SUM(h.is_new) AS new
                     FROM ${FROM} WHERE ${SEL} GROUP BY h.page, day
                 ) g JOIN strings p ON p.id = g.page`)
            : c(`SELECT p.value AS page, d.day, d.views, d.new
                 FROM page_daily d JOIN strings p ON p.id = d.page
                 WHERE d.host = ?2 AND d.day >= ?1`),
        counted
            ? c(`SELECT day, views, visitors, new, engaged_sum, scroll_sum, samples
                 FROM host_daily WHERE host = ?2 AND day >= ?1`)
            : q(`SELECT h.ts / 86400 AS day, COUNT(*) AS views,
                        COUNT(DISTINCT h.visitor_id) AS visitors, SUM(h.is_new) AS new
                 FROM ${FROM} WHERE ${SEL} ${ON_PAGE} GROUP BY day`),
        // Visitors in the period by device: everyone whose latest visit to
        // the host is in it, since the period ends today.
        counted
            ? c(`SELECT d.value AS device, COUNT(*) AS visitors,
                        SUM(vh.first_seen >= ?1 AND vh.hits = 1) AS bounced
                 FROM visitor_hosts vh JOIN visitors v ON v.id = vh.visitor_id
                 LEFT JOIN strings d ON d.id = v.device
                 WHERE vh.host = ?2 AND vh.last_seen >= ?1 GROUP BY v.device`)
            : q(`SELECT d.value AS device, g.visitors FROM (
                     SELECT v.device, COUNT(DISTINCT h.visitor_id) AS visitors
                     FROM ${FROM} JOIN visitors v ON v.id = h.visitor_id
                     WHERE ${SEL} ${ON_PAGE} GROUP BY v.device
                 ) g LEFT JOIN strings d ON d.id = g.device`),
        ...(counted
            ? []
            : [
                  q(`SELECT COUNT(*) AS views, COUNT(DISTINCT h.visitor_id) AS visitors,
                            AVG(h.scroll_pct) AS scroll, AVG(h.engaged_s) AS engaged,
                            SUM(${BOUNCED}) AS new_bounced
                     FROM ${FROM} WHERE ${SEL} ${ON_PAGE}`),
              ]),
    ])) as [
        D1Result<ReferrerRow>,
        D1Result<PageDayRow>,
        D1Result<CountedDayRow>, // only views, visitors and new when filtered
        D1Result<CountedDeviceRow>, // no bounced when filtered
        D1Result<TotalRow> | undefined, // filtered only
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

    let engaged = 0;
    let scroll = 0;
    let samples = 0;
    for (const r of daily.results) {
        const i = r.day - p.firstDay;
        stats.daily.views[i] = r.views;
        stats.daily.visitors[i] = r.visitors;
        stats.daily.new[i] = r.new;
        stats.totals.views += r.views;
        stats.totals.new += r.new; // each visitor is new on a host at most once
        engaged += r.engaged_sum ?? 0;
        scroll += r.scroll_sum ?? 0;
        samples += r.samples ?? 0;
    }
    for (const r of people.results) {
        const d = stats.totals.devices;
        if (r.device === "mobile" || r.device === "tablet") d[r.device] += r.visitors;
        else d.desktop += r.visitors; // desktop, plus rare types (console, smarttv)
    }
    if (counted) {
        Object.assign(stats.totals, {
            visitors: people.results.reduce((n, r) => n + r.visitors, 0),
            avgScrollPct: samples ? scroll / samples : null,
            avgEngagedS: samples ? engaged / samples : null,
            newBounced: people.results.reduce((n, r) => n + r.bounced, 0),
        });
    } else if (totals?.results[0]) {
        const t = totals.results[0];
        Object.assign(stats.totals, {
            visitors: t.visitors,
            avgScrollPct: t.scroll,
            avgEngagedS: t.engaged,
            newBounced: t.new_bounced ?? 0,
        });
    }

    const byPage = new Map<string, PageRow>();
    for (const r of pages.results) {
        let row = byPage.get(r.page);
        if (!row) {
            const path = r.page.slice(host.length) || "/"; // "blog.you.com/posts/x" -> "/posts/x"
            byPage.set(r.page, (row = { path, views: 0, new: 0, daily: Array(numDays).fill(0) }));
        }
        row.views += r.views;
        row.new += r.new;
        row.daily[r.day - p.firstDay] = r.views;
    }
    stats.pages = [...byPage.values()].sort((a, b) => b.views - a.views);

    return result;
}

async function hostSummaries(env: Env, hosts: string[], numDays: number): Promise<HostSummaries> {
    const p = await period(env, numDays, null, hosts);
    const result: HostSummaries = { days: p.days, hosts: {} };
    const ids = p.ids.filter((id) => id >= 0);
    if (p.empty || ids.length === 0) return result;

    // ?1 = first day, then the host ids.
    const IN = ids.map((_, i) => `?${i + 2}`).join(",");
    const c = (sql: string) => env.DB.prepare(sql).bind(p.firstDay, ...ids);
    const [daily, visitors] = (await env.DB.batch([
        c(`SELECT s.value AS host, d.day, d.views, d.visitors, d.new
           FROM host_daily d JOIN strings s ON s.id = d.host
           WHERE d.host IN (${IN}) AND d.day >= ?1`),
        // Distinct over the whole period; per-day counts would overlap.
        c(`SELECT s.value AS host, COUNT(*) AS visitors
           FROM visitor_hosts vh JOIN strings s ON s.id = vh.host
           WHERE vh.host IN (${IN}) AND vh.last_seen >= ?1
           GROUP BY vh.host`),
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
    const json = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });
    if (url.pathname === "/api/config") return json({ sites: env.SITES ?? [] });

    const days = Math.min(366, Math.max(1, Number(url.searchParams.get("days")) || 30));
    const ref = url.searchParams.get("ref") || null;

    if (url.pathname === "/api/overview") {
        const host = (url.searchParams.get("host") ?? "").toLowerCase();
        const page = url.searchParams.get("page") || null;
        return json(await overview(env, host, days, ref, page));
    }
    if (url.pathname === "/api/hosts") {
        const hosts = (env.SITES ?? []).flatMap((s) => s.hosts.map((h) => h.host.toLowerCase()));
        return json(await hostSummaries(env, hosts, days));
    }
    return new Response("Not found", { status: 404 });
}
