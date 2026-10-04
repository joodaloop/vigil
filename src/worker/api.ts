import type { HostStats, HostSummaries, Overview, PageRow, Referrer } from "../shared/types";
import { filteredVisitors } from "./uniques";
import { configuredSites } from "./sites";

// GET /api/overview?host=blog.example.co.uk&days=30
//   Totals, daily series, referrers and pages for one site.
// GET /api/hosts?days=30
//   Views (with a daily series) and new visitors for every configured site,
//   unfiltered, for the sidebar.
//
// Both cover the last `days` UTC days (today included). The overview takes
// optional `ref` (referrer domain) and `page` (path) filters.
//
// Every number is a SUM over `views` (schema.sql), except
// unique visitors: unfiltered, a count of `visitors`; under a filter, a count
// of the filter's hits (uniques.ts), since readers can't be summed. A source is another site's domain, or on a click within the
// site, the path of the page it came from (paths start with "/").

type DailyRow = { day: number; views: number; visitors: number; new: number; reads: number };
type PageDayRow = { page: string; day: number; views: number; new: number };
type SourceDayRow = { source: string; day: number; views: number };
type DeviceRow = { device: string | null; visitors: number; bounced: number };
type HostDailyRow = { host: string; day: number; views: number; new: number };

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
    // The sums are grouped in SQL, so the Worker gets back a few hundred
    // rows rather than every (day, page, source) one. Each list ignores its
    // own filter, so every option stays listed while one is picked.
    const q = (sql: string, onPage: boolean, onRef: boolean) => {
        const where = ["host = ?", "day >= ?"];
        const params: unknown[] = [host, firstDay];
        if (onPage && page) where.push("page = ?"), params.push(page);
        if (onRef && ref) where.push("source = ?"), params.push(ref);
        return env.DB.prepare(sql.replace("$WHERE", where.join(" AND "))).bind(...params);
    };

    const byFilter = ref || page ? filteredVisitors(host, firstDay, page, ref) : null;
    const [daily, pages, sources, people, filteredDaily] = (await env.DB.batch([
        q(
            `SELECT day, SUM(views) AS views, SUM(visitors) AS visitors, SUM(new) AS new, SUM(reads) AS reads
             FROM views WHERE $WHERE GROUP BY day`,
            true,
            true,
        ),
        q(`SELECT page, day, SUM(views) AS views, SUM(new) AS new FROM views WHERE $WHERE GROUP BY page, day`, false, true),
        // Where views came from: another site, or on a click within the site,
        // the previous page. With a page filter, where that page's readers
        // came from.
        q(`SELECT source, day, SUM(views) AS views FROM views WHERE $WHERE AND source != '' GROUP BY source, day`, true, false),
        // Visitors in the period, by device. Unfiltered: everyone whose
        // latest visit is in it, since the period ends today, read from the
        // covering index.
        byFilter
            ? env.DB.prepare(byFilter.people).bind(...byFilter.params)
            : env.DB.prepare(
                  `SELECT device, COUNT(*) AS visitors, SUM(first_ts >= ?2 AND first_ts = last_ts) AS bounced
                   FROM visitors WHERE host = ?1 AND last_ts >= ?2 GROUP BY device`,
              ).bind(host, firstDay * 86400),
        // Filtered, visitors per day; unfiltered, they're summed from `views`.
        ...(byFilter ? [env.DB.prepare(byFilter.daily).bind(...byFilter.params)] : []),
    ])) as [
        D1Result<DailyRow>,
        D1Result<PageDayRow>,
        D1Result<SourceDayRow>,
        D1Result<DeviceRow>,
        D1Result<{ day: number; visitors: number }> | undefined,
    ];

    const stats = result.stats;
    const t = stats.totals;

    for (const r of daily.results) {
        const i = r.day - firstDay;
        stats.daily.views[i] = r.views;
        stats.daily.new[i] = r.new;
        // Filtered, these are replaced below: summed from `views` they'd count
        // readers on the page of their first hit of the day.
        stats.daily.visitors[i] = byFilter ? 0 : r.visitors;
        t.views += r.views;
        t.new += r.new; // each visitor is new on a site at most once
        t.reads += r.reads;
    }

    const byPage = new Map<string, PageRow>();
    for (const r of pages.results) {
        let p = byPage.get(r.page);
        if (!p) byPage.set(r.page, (p = { path: r.page, views: 0, new: 0, daily: Array(numDays).fill(0) }));
        p.views += r.views;
        p.new += r.new;
        p.daily[r.day - firstDay] = r.views;
    }
    stats.pages = [...byPage.values()].sort((a, b) => b.views - a.views);

    const bySource = new Map<string, Referrer>();
    for (const r of sources.results) {
        let s = bySource.get(r.source);
        if (!s) bySource.set(r.source, (s = { domain: r.source, visits: 0, daily: Array(numDays).fill(0) }));
        s.visits += r.views;
        s.daily[r.day - firstDay] = r.views;
    }
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
    const { results } = await env.DB.prepare(
        `SELECT host, day, SUM(views) AS views, SUM(new) AS new
         FROM views WHERE host IN (${IN}) AND day >= ?1 GROUP BY host, day`,
    )
        .bind(firstDay, ...hosts)
        .all<HostDailyRow>();

    for (const r of results) {
        const h = (result.hosts[r.host] ??= { totals: { views: 0, new: 0 }, daily: { views: Array(numDays).fill(0) } });
        h.daily.views[r.day - firstDay] = r.views;
        h.totals.views += r.views;
        h.totals.new += r.new;
    }
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
