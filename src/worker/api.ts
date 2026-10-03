import type { HostStats, HostSummaries, Overview, PageRow, Referrer } from "../shared/types";
import { filteredVisitors } from "./filtered";
import { configuredSites } from "./sites";

// GET /api/overview?host=blog.example.co.uk&days=30
//   Totals, daily series, referrers and pages for one site.
// GET /api/hosts?days=30
//   Headline totals and daily series for every configured site, unfiltered.
//
// Both cover the last `days` UTC days (today included). The overview takes
// optional `ref` (referrer domain) and `page` (path) filters.
//
// Every number is a SUM over `views` (migrations/0002_views.sql), except
// unique visitors: unfiltered, a count of `visitors`; under a filter, a count
// of the filter's hits (filtered.ts), since readers can't be summed. A source is another site's domain, or on a click within the
// site, the path of the page it came from (paths start with "/").

type ViewsRow = { day: number; page: string; source: string; views: number; new: number; visitors: number; reads: number };
type DeviceRow = { device: string | null; visitors: number; bounced: number };
type HostDailyRow = { host: string; day: number; views: number; visitors: number; new: number };
type HostVisitorsRow = { host: string; visitors: number };

// The first day (UTC day number) of the last `numDays`, and each day's start
// in unix seconds.
function period(numDays: number) {
    const firstDay = Math.floor(Date.now() / 1000 / 86400) - numDays + 1;
    return { firstDay, days: Array.from({ length: numDays }, (_, i) => (firstDay + i) * 86400) };
}

function emptyHost(n: number): HostStats {
    return {
        totals: {
            views: 0,
            reads: 0,
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

async function overview(
    env: Env,
    host: string,
    numDays: number,
    ref: string | null,
    page: string | null,
): Promise<Overview> {
    const { firstDay, days } = period(numDays);
    const result: Overview = { days, ref, page, stats: emptyHost(numDays) };
    const byFilter = ref || page ? filteredVisitors(host, firstDay, page, ref) : null;
    const [rows, people, filteredDaily] = (await env.DB.batch([
        // The period's rows, read once; everything below is summed from them.
        env.DB.prepare(
            "SELECT day, page, source, views, new, visitors, reads FROM views WHERE host = ? AND day >= ?",
        ).bind(host, firstDay),
        // Visitors in the period, by device. Unfiltered: everyone whose
        // latest visit is in it, since the period ends today, read from the
        // covering index.
        byFilter
            ? env.DB.prepare(byFilter.people).bind(...byFilter.params)
            : env.DB.prepare(
                  `SELECT device, COUNT(*) AS visitors, SUM(first_day >= ?2 AND NOT returned) AS bounced
                   FROM visitors WHERE host = ?1 AND last_day >= ?2 GROUP BY device`,
              ).bind(host, firstDay),
        // Filtered, visitors per day; unfiltered, they're summed from `views`.
        ...(byFilter ? [env.DB.prepare(byFilter.daily).bind(...byFilter.params)] : []),
    ])) as [D1Result<ViewsRow>, D1Result<DeviceRow>, D1Result<{ day: number; visitors: number }> | undefined];

    const stats = result.stats;
    const t = stats.totals;
    const byPage = new Map<string, PageRow>();
    const bySource = new Map<string, Referrer>();

    // Each list ignores its own filter, so every option stays listed while
    // one is picked.
    for (const r of rows.results) {
        const i = r.day - firstDay;
        const onPage = !page || r.page === page;
        const onRef = !ref || r.source === ref;

        // The chart and totals: both filters.
        if (onPage && onRef) {
            stats.daily.views[i] += r.views;
            stats.daily.new[i] += r.new;
            t.views += r.views;
            t.new += r.new; // each visitor is new on a site at most once
            t.reads += r.reads;
            // Unfiltered, each visitor counts once a day across all rows.
            if (!byFilter) stats.daily.visitors[i] += r.visitors;
        }
        // Pages: the source filter only.
        if (onRef) {
            let p = byPage.get(r.page);
            if (!p) byPage.set(r.page, (p = { path: r.page, views: 0, new: 0, daily: Array(numDays).fill(0) }));
            p.views += r.views;
            p.new += r.new;
            p.daily[i] += r.views;
        }
        // Where views came from (another site, or the previous page): the
        // page filter only.
        if (onPage && r.source) {
            let s = bySource.get(r.source);
            if (!s) bySource.set(r.source, (s = { domain: r.source, visits: 0, daily: Array(numDays).fill(0) }));
            s.visits += r.views;
            s.daily[i] += r.views;
        }
    }
    stats.pages = [...byPage.values()].sort((a, b) => b.views - a.views);
    stats.referrers = [...bySource.values()].sort((a, b) => b.visits - a.visits);

    for (const r of filteredDaily?.results ?? []) stats.daily.visitors[r.day - firstDay] = r.visitors;

    for (const r of people.results) {
        t.visitors += r.visitors;
        t.newBounced += r.bounced;
        const d = t.devices;
        if (r.device === "mobile" || r.device === "tablet") d[r.device] += r.visitors;
        else d.desktop += r.visitors; // desktop, plus rare types (console, smarttv)
    }

    return result;
}

async function hostSummaries(env: Env, hosts: string[], numDays: number): Promise<HostSummaries> {
    const { firstDay, days } = period(numDays);
    const result: HostSummaries = { days, hosts: {} };
    if (hosts.length === 0) return result;

    // ?1 = first day, then the hosts.
    const IN = hosts.map((_, i) => `?${i + 2}`).join(",");
    const q = (sql: string) => env.DB.prepare(sql).bind(firstDay, ...hosts);
    const [daily, visitors] = (await env.DB.batch([
        q(`SELECT host, day, SUM(views) AS views, SUM(visitors) AS visitors, SUM(new) AS new
           FROM views WHERE host IN (${IN}) AND day >= ?1 GROUP BY host, day`),
        // Distinct over the whole period; per-day counts would overlap.
        q(`SELECT host, COUNT(*) AS visitors FROM visitors WHERE host IN (${IN}) AND last_day >= ?1 GROUP BY host`),
    ])) as [D1Result<HostDailyRow>, D1Result<HostVisitorsRow>];

    const zeros = () => Array(numDays).fill(0);
    const host = (name: string) =>
        (result.hosts[name] ??= {
            totals: { views: 0, visitors: 0, new: 0 },
            daily: { views: zeros(), visitors: zeros(), new: zeros() },
        });
    for (const r of daily.results) {
        const h = host(r.host);
        const i = r.day - firstDay;
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
    if (url.pathname === "/api/config") return json({ sites: configuredSites(env) });

    const days = Math.min(366, Math.max(1, Number(url.searchParams.get("days")) || 30));

    if (url.pathname === "/api/overview") {
        const host = (url.searchParams.get("host") ?? "").toLowerCase();
        const ref = url.searchParams.get("ref") || null;
        const page = url.searchParams.get("page") || null;
        return json(await overview(env, host, days, ref, page));
    }
    if (url.pathname === "/api/hosts") {
        const hosts = configuredSites(env).map((s) => s.host);
        return json(await hostSummaries(env, hosts, days));
    }
    return new Response("Not found", { status: 404 });
}
