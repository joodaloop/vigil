import type { HostStats, Overview, PageRow, Referrer, Source } from "../shared/types";
import { lookupIds } from "./strings";

// GET /api/overview?site=joodaloop.com&days=30
//
// Per-host totals, daily series and page/source breakdowns over the last
// `days` UTC days (today included). All queries run in one D1 batch.

// ?1 = lo hit id, ?2 = period start (unix s), ?3 = site id
const RANGE = `h.id >= ?1 AND h.ts >= ?2 AND h.site = ?3`;

// This hit is the visitor's first ever hit on this host (index seek).
const IS_NEW = `NOT EXISTS (SELECT 1 FROM hits p
    WHERE p.visitor_id = h.visitor_id AND p.host = h.host AND p.id < h.id)`;

// This hit is the visitor's first ever hit anywhere on the site. Visitor ids
// are per cookie domain, so any earlier hit is on this site.
const IS_NEW_TO_SITE = `NOT EXISTS (SELECT 1 FROM hits p
    WHERE p.visitor_id = h.visitor_id AND p.id < h.id)`;

// ...and they never had another hit on this host afterwards.
const NEVER_AGAIN = `NOT EXISTS (SELECT 1 FROM hits p
    WHERE p.visitor_id = h.visitor_id AND p.host = h.host AND p.id > h.id)`;

type SiteDailyRow = { day: number; views: number; visitors: number; new: number };
type ReferrerRow = { domain: string; day: number; visits: number };
type DailyRow = { host: string; day: number; views: number; visitors: number; new: number };
type TotalRow = {
    host: string;
    views: number;
    visitors: number;
    scroll: number | null;
    engaged: number | null;
    new_bounced: number;
};
type DeviceRow = { host: string; device: string | null; visitors: number };
type BreakdownRow = { host: string; page: string; src: string | null; arrival: number; views: number; new: number };

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
        pages: [],
    };
}

// "blog.you.com/posts/x" -> ["blog.you.com", "/posts/x"]
function splitPage(page: string): [string, string] {
    const slash = page.indexOf("/");
    return slash < 0 ? [page, "/"] : [page.slice(0, slash), page.slice(slash)];
}

const byViews = (a: { views: number }, b: { views: number }) => b.views - a.views;
const KIND_ORDER: Record<Source["kind"], number> = { within: 0, direct: 1, host: 2, referrer: 2 };

function buildPages(rows: BreakdownRow[], host: string): PageRow[] {
    const pages = new Map<string, PageRow>();

    for (const r of rows) {
        const [, path] = splitPage(r.page);
        let page = pages.get(path);
        if (!page) pages.set(path, (page = { path, views: 0, new: 0, sources: [] }));
        page.views += r.views;
        page.new += r.new;

        // Arrivals: src is the referrer domain, or NULL for direct.
        // Internal clicks: src is the previous page, on this host or another.
        let kind: Source["kind"];
        let label: string;
        let child: string | null = null;
        if (r.arrival) {
            kind = r.src ? "referrer" : "direct";
            label = r.src ?? "Direct";
        } else {
            const [srcHost, srcPath] = splitPage(r.src ?? `${host}/(unknown)`);
            kind = srcHost === host ? "within" : "host";
            label = kind === "within" ? "Within site" : srcHost;
            child = srcPath;
        }

        let source = page.sources.find((s) => s.kind === kind && s.label === label);
        if (!source) page.sources.push((source = { kind, label, views: 0, new: 0, children: [] }));
        source.views += r.views;
        source.new += r.new;
        if (child !== null) {
            const existing = source.children.find((c) => c.path === child);
            if (existing) {
                existing.views += r.views;
                existing.new += r.new;
            } else {
                source.children.push({ path: child, views: r.views, new: r.new });
            }
        }
    }

    const result = [...pages.values()].sort(byViews);
    for (const page of result) {
        page.sources.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byViews(a, b));
        for (const s of page.sources) s.children.sort(byViews);
    }
    return result;
}

async function overview(env: Env, site: string, numDays: number, ref: string | null): Promise<Overview> {
    const today = Math.floor(Date.now() / 1000 / 86400);
    const firstDay = today - numDays + 1;
    const start = firstDay * 86400;
    const days = Array.from({ length: numDays }, (_, i) => (firstDay + i) * 86400);
    const zeros = () => Array(numDays).fill(0);
    const result: Overview = {
        days,
        ref,
        site: { totals: { views: 0, visitors: 0, new: 0 }, daily: { views: zeros(), visitors: zeros(), new: zeros() } },
        referrers: [],
        hosts: {},
    };

    const [siteId, refId] = await lookupIds(env.DB, ref ? [site, ref] : [site]);
    const lo = await env.DB.prepare("SELECT first_hit_id FROM days WHERE day >= ? ORDER BY day LIMIT 1")
        .bind(firstDay)
        .first<number>("first_hit_id");
    if (siteId < 0 || lo === null) return result;

    // The referrer filter keeps hits whose trip arrived from `ref`.
    //
    // NOT INDEXED: scan `h` by id range only. Otherwise SQLite may count
    // distinct visitors by walking the whole hits_visitor_host index, which
    // reads (and bills) every hit ever recorded instead of just the period.
    const FROM = ref ? `hits h NOT INDEXED JOIN hits e ON e.id = h.entry_hit_id AND e.src = ?4` : `hits h NOT INDEXED`;
    const q = (sql: string) =>
        env.DB.prepare(sql).bind(...(ref ? [lo, start, siteId, refId] : [lo, start, siteId]));
    const unfiltered = (sql: string) => env.DB.prepare(sql).bind(lo, start, siteId);

    const [siteVisitors, siteDaily, referrers, daily, totals, devices, breakdown] = (await env.DB.batch([
        q(`SELECT COUNT(DISTINCT h.visitor_id) AS n FROM ${FROM} WHERE ${RANGE}`),
        q(`SELECT h.ts / 86400 AS day, COUNT(*) AS views, COUNT(DISTINCT h.visitor_id) AS visitors,
                  SUM(${IS_NEW_TO_SITE}) AS new
           FROM ${FROM} WHERE ${RANGE} GROUP BY day`),
        unfiltered(`SELECT s.value AS domain, g.day, g.visits FROM (
               SELECT h.src, h.ts / 86400 AS day, COUNT(*) AS visits
               FROM hits h NOT INDEXED WHERE ${RANGE} AND h.entry_hit_id = h.id AND h.src IS NOT NULL
               GROUP BY h.src, day
           ) g JOIN strings s ON s.id = g.src`),
        q(`SELECT s.value AS host, g.day, g.views, g.visitors, g.new FROM (
               SELECT h.host, h.ts / 86400 AS day, COUNT(*) AS views,
                      COUNT(DISTINCT h.visitor_id) AS visitors, SUM(${IS_NEW}) AS new
               FROM ${FROM} WHERE ${RANGE} GROUP BY h.host, day
           ) g JOIN strings s ON s.id = g.host`),
        q(`SELECT s.value AS host, g.views, g.visitors, g.scroll, g.engaged, g.new_bounced FROM (
               SELECT h.host, COUNT(*) AS views, COUNT(DISTINCT h.visitor_id) AS visitors,
                      AVG(h.scroll_pct) AS scroll, AVG(h.engaged_s) AS engaged,
                      SUM(${IS_NEW} AND ${NEVER_AGAIN}) AS new_bounced
               FROM ${FROM} WHERE ${RANGE} GROUP BY h.host
           ) g JOIN strings s ON s.id = g.host`),
        q(`SELECT s.value AS host, d.value AS device, g.visitors FROM (
               SELECT h.host, v.device, COUNT(DISTINCT h.visitor_id) AS visitors
               FROM ${FROM} JOIN visitors v ON v.id = h.visitor_id
               WHERE ${RANGE} GROUP BY h.host, v.device
           ) g JOIN strings s ON s.id = g.host LEFT JOIN strings d ON d.id = g.device`),
        q(`SELECT s.value AS host, p.value AS page, r.value AS src, g.arrival, g.views, g.new FROM (
               SELECT h.host, h.page, h.src, h.entry_hit_id = h.id AS arrival,
                      COUNT(*) AS views, SUM(${IS_NEW}) AS new
               FROM ${FROM} WHERE ${RANGE} GROUP BY h.host, h.page, h.src, arrival
           ) g JOIN strings s ON s.id = g.host JOIN strings p ON p.id = g.page
           LEFT JOIN strings r ON r.id = g.src`),
    ])) as [
        D1Result<{ n: number }>,
        D1Result<SiteDailyRow>,
        D1Result<ReferrerRow>,
        D1Result<DailyRow>,
        D1Result<TotalRow>,
        D1Result<DeviceRow>,
        D1Result<BreakdownRow>,
    ];

    for (const r of siteDaily.results) {
        const i = r.day - firstDay;
        result.site.daily.views[i] = r.views;
        result.site.daily.visitors[i] = r.visitors;
        result.site.daily.new[i] = r.new;
        result.site.totals.views += r.views;
        result.site.totals.new += r.new;
    }
    // Distinct over the whole period; per-day or per-host counts would overlap.
    result.site.totals.visitors = siteVisitors.results[0]?.n ?? 0;

    const refs = new Map<string, Referrer>();
    for (const r of referrers.results) {
        let entry = refs.get(r.domain);
        if (!entry) refs.set(r.domain, (entry = { domain: r.domain, visits: 0, daily: zeros() }));
        entry.visits += r.visits;
        entry.daily[r.day - firstDay] = r.visits;
    }
    result.referrers = [...refs.values()].sort((a, b) => b.visits - a.visits);

    const host = (name: string) => (result.hosts[name] ??= emptyHost(numDays));

    for (const r of daily.results) {
        const h = host(r.host);
        const i = r.day - firstDay;
        h.daily.views[i] = r.views;
        h.daily.visitors[i] = r.visitors;
        h.daily.new[i] = r.new;
        h.totals.new += r.new; // each visitor is new on a host at most once
    }
    for (const r of totals.results) {
        Object.assign(host(r.host).totals, {
            views: r.views,
            visitors: r.visitors,
            avgScrollPct: r.scroll,
            avgEngagedS: r.engaged,
            newBounced: r.new_bounced,
        });
    }
    for (const r of devices.results) {
        const d = host(r.host).totals.devices;
        if (r.device === "mobile" || r.device === "tablet") d[r.device] += r.visitors;
        else d.desktop += r.visitors; // desktop, plus rare types (console, smarttv)
    }

    const rowsByHost = new Map<string, BreakdownRow[]>();
    for (const r of breakdown.results) {
        if (!rowsByHost.has(r.host)) rowsByHost.set(r.host, []);
        rowsByHost.get(r.host)!.push(r);
    }
    for (const [name, rows] of rowsByHost) host(name).pages = buildPages(rows, name);

    return result;
}

export async function handleApi(url: URL, env: Env): Promise<Response> {
    if (url.pathname === "/api/overview") {
        const site = url.searchParams.get("site") ?? "";
        const days = Math.min(366, Math.max(1, Number(url.searchParams.get("days")) || 30));
        const ref = url.searchParams.get("ref") || null;
        return Response.json(await overview(env, site, days, ref), {
            headers: { "Cache-Control": "no-store" },
        });
    }
    return new Response("Not found", { status: 404 });
}
