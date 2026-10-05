import type { Sparse } from "../shared/series";
import type { HostStats, HostSummaries, Overview, PageRow, Referrer } from "../shared/types";
import { countrySums, type Filters, filteredVisitors } from "./hitQueries";
import { configuredSites } from "./sites";

// GET /api/overview?host=blog.example.co.uk&days=30
//   Totals, daily series, referrers and pages for one site.
// GET /api/hosts?days=30
//   Views (with a daily series) and new visitors for every configured site,
//   unfiltered, for the sidebar.
//
// Both cover the last `days` UTC days (today included). The overview takes
// optional `source`, `page` (path) and `country` (ISO code) filters.
//
// Every number is a SUM over `views` (schema.sql), except
// unique visitors: unfiltered, a count of `visitors`; under a filter, a count
// of the filter's hits, since readers can't be summed. `views` only breaks
// the numbers down by page and source, so under a country filter they're all
// summed from that country's hits instead (hitQueries.ts). A source is another site's domain, or on a click within the
// site, the path of the page it came from (paths start with "/").

type DailyRow = { day: number; views: number; visitors: number; new: number; reads: number };
type PageDayRow = { page: string; day: number; views: number; new: number; reads: number };
type SourceDayRow = { source: string; day: number; views: number; new: number; reads: number };
type PeopleRow = { device: string | null; country: string | null; os: string | null; visitors: number; bounced: number };
type SourceInfoRow = { domain: string; name: string | null; icon: number | null };
type PageTitleRow = { path: string; title: string };
type HostDailyRow = { host: string; day: number; views: number; new: number; reads: number };

// The first day (UTC day number) of the last `numDays`, and each day's start
// in unix seconds.
function period(numDays: number) {
    const firstDay = Math.floor(Date.now() / 1000 / 86400) - numDays + 1;
    return { firstDay, days: Array.from({ length: numDays }, (_, i) => (firstDay + i) * 86400) };
}

function emptyHost(n: number): HostStats<Sparse> {
    return {
        totals: {
            views: 0,
            reads: 0,
            visitors: 0,
            devices: { desktop: 0, tablet: 0, mobile: 0 },
            systems: { windows: 0, mac: 0, ios: 0, android: 0, linux: 0, known: 0 },
            countries: [],
            new: 0,
            newBounced: 0,
        },
        daily: { views: Array(n).fill(0), visitors: Array(n).fill(0), new: Array(n).fill(0), reads: Array(n).fill(0) },
        referrers: [],
        pages: [],
    };
}

async function overview(env: Env, host: string, numDays: number, filters: Filters): Promise<Overview<Sparse>> {
    const { page, source, country } = filters;
    const { firstDay, days } = period(numDays);
    const result: Overview<Sparse> = { days, stats: emptyHost(numDays) };
    // The sums are grouped in SQL, so the Worker gets back a few hundred
    // rows rather than every (day, page, source) one. Every number, lists
    // included, takes every filter.
    const q = (sql: string) => {
        const where = ["host = ?", "day >= ?"];
        const params: unknown[] = [host, firstDay];
        if (page) where.push("page = ?"), params.push(page);
        if (source) where.push("source = ?"), params.push(source);
        return env.DB.prepare(sql.replace("$WHERE", where.join(" AND "))).bind(...params);
    };
    // The same three, from a country's hits.
    const inCountry = country ? countrySums(host, firstDay, { page, source, country }) : null;
    const h = (part: { sql: string; params: unknown[] }) => env.DB.prepare(part.sql).bind(...part.params);
    const filtered = page || source || country;
    const byFilter = filtered ? filteredVisitors(host, firstDay, filters) : null;
    const [daily, pages, sources, everyone, sourceInfo, titles, filteredDaily] = (await env.DB.batch([
        inCountry
            ? h(inCountry.daily)
            : q(
                  `SELECT day, SUM(views) AS views, SUM(visitors) AS visitors, SUM(new) AS new, SUM(reads) AS reads
                   FROM views WHERE $WHERE GROUP BY day`,
              ),
        inCountry
            ? h(inCountry.pages)
            : q(
                  `SELECT page, day, SUM(views) AS views, SUM(new) AS new, SUM(reads) AS reads
                   FROM views WHERE $WHERE GROUP BY page, day`,
              ),
        // Where views came from: another site, or on a click within the site,
        // the previous page.
        inCountry
            ? h(inCountry.sources)
            : q(
                  `SELECT source, day, SUM(views) AS views, SUM(new) AS new, SUM(reads) AS reads
                   FROM views WHERE $WHERE AND source != '' GROUP BY source, day`,
              ),
        // Visitors in the period, by device, country and OS. Unfiltered:
        // everyone whose latest visit is in it, since the period ends today,
        // read from the covering index; filtered, from the filter's hits.
        byFilter
            ? env.DB.prepare(byFilter.people).bind(...byFilter.params)
            : env.DB.prepare(
                  `SELECT device, country, os, COUNT(*) AS visitors, SUM(first_ts >= ?2 AND first_ts = last_ts) AS bounced
                   FROM visitors WHERE host = ?1 AND last_ts >= ?2 GROUP BY device, country, os`,
              ).bind(host, firstDay * 86400),
        // Names and saved icons of the site and the period's other sites
        // (schema.sql).
        env.DB.prepare(
            `SELECT domain, name, icon_ts AS icon FROM sources
             WHERE domain = ?1 OR domain IN (SELECT source FROM views WHERE host = ?1 AND day >= ?2)`,
        ).bind(host, firstDay),
        // Titles of the period's pages, and of those clicked through from.
        env.DB.prepare(
            `SELECT path, title FROM pages
             WHERE host = ?1 AND title IS NOT NULL
               AND path IN (SELECT page FROM views WHERE host = ?1 AND day >= ?2
                            UNION SELECT source FROM views WHERE host = ?1 AND day >= ?2)`,
        ).bind(host, firstDay),
        // Filtered, visitors per day; unfiltered, they're summed from `views`.
        byFilter ? env.DB.prepare(byFilter.daily).bind(...byFilter.params) : null,
    ].filter((s) => s !== null))) as [
        D1Result<DailyRow>,
        D1Result<PageDayRow>,
        D1Result<SourceDayRow>,
        D1Result<PeopleRow>,
        D1Result<SourceInfoRow>,
        D1Result<PageTitleRow>,
        ...D1Result[],
    ];
    const visitorsByDay = filteredDaily as D1Result<{ day: number; visitors: number }> | undefined;

    const stats = result.stats;
    const t = stats.totals;

    for (const r of daily.results) {
        const i = r.day - firstDay;
        stats.daily.views[i] = r.views;
        stats.daily.new[i] = r.new;
        stats.daily.reads[i] = r.reads;
        // Filtered, these are replaced below: summed from `views` they'd count
        // readers on the page of their first hit of the day.
        stats.daily.visitors[i] = byFilter ? 0 : r.visitors;
        t.views += r.views;
        t.new += r.new; // each visitor is new on a site at most once
        t.reads += r.reads;
    }

    // Each row's numbers, added up from its days; its series hold only the
    // days with a value, as the queries return only days with views.
    const add = (row: PageRow<Sparse> | Referrer<Sparse>, r: { day: number; views: number; new: number; reads: number }) => {
        const i = r.day - firstDay;
        row.views += r.views;
        row.new += r.new;
        row.reads += r.reads;
        row.daily.push([i, r.views]);
        if (r.new) row.dailyNew.push([i, r.new]);
        if (r.reads) row.dailyReads.push([i, r.reads]);
    };
    const noNumbers = () => ({ views: 0, new: 0, reads: 0, daily: [], dailyNew: [], dailyReads: [] });

    const byPage = new Map<string, PageRow<Sparse>>();
    for (const r of pages.results) {
        let p = byPage.get(r.page);
        if (!p) byPage.set(r.page, (p = { path: r.page, ...noNumbers() }));
        add(p, r);
    }
    stats.pages = [...byPage.values()].sort((a, b) => b.views - a.views);

    const bySource = new Map<string, Referrer<Sparse>>();
    for (const r of sources.results) {
        let s = bySource.get(r.source);
        if (!s) bySource.set(r.source, (s = { source: r.source, ...noNumbers() }));
        add(s, r);
    }
    for (const r of sourceInfo.results) {
        if (r.domain === host && r.icon !== null) result.icon = r.icon;
        const s = bySource.get(r.domain);
        if (s && r.name) s.name = r.name;
        if (s && r.icon !== null) s.icon = r.icon;
    }
    // A page's title, on its row and as the name of the referrer it is when
    // clicked through from.
    for (const r of titles.results) {
        const p = byPage.get(r.path);
        if (p) p.title = r.title;
        const s = bySource.get(r.path);
        if (s) s.name = r.title;
    }
    stats.referrers = [...bySource.values()].sort((a, b) => b.new - a.new || b.views - a.views);

    for (const r of visitorsByDay?.results ?? []) stats.daily.visitors[r.day - firstDay] = r.visitors;

    for (const r of everyone.results) {
        t.visitors += r.visitors;
        t.newBounced += r.bounced;
        const d = t.devices;
        if (r.device === "mobile" || r.device === "tablet") d[r.device] += r.visitors;
        else d.desktop += r.visitors; // desktop, plus rare types (console, smarttv)
        const os = OS[r.os ?? ""];
        if (os) t.systems[os] += r.visitors;
        if (r.os) t.systems.known += r.visitors;
    }
    const countries = new Map<string, number>();
    for (const r of everyone.results) {
        if (r.country) countries.set(r.country, (countries.get(r.country) ?? 0) + r.visitors);
    }
    t.countries = [...countries].map(([code, visitors]) => ({ code, visitors })).sort((a, b) => b.visitors - a.visitors);

    return result;
}

// The operating systems shown, by the name ua-parser-js gives them. iPadOS
// reports itself as iOS; desktop Linux is often named by its distribution.
const OS: Record<string, "windows" | "mac" | "ios" | "android" | "linux"> = {
    Windows: "windows",
    "Mac OS": "mac",
    macOS: "mac",
    iOS: "ios",
    Android: "android",
    Linux: "linux",
    Ubuntu: "linux",
    Debian: "linux",
    Fedora: "linux",
    Arch: "linux",
    Mint: "linux",
    Gentoo: "linux",
    "Red Hat": "linux",
    SUSE: "linux",
    Manjaro: "linux",
    "elementary OS": "linux",
};

async function hostSummaries(env: Env, hosts: string[], numDays: number): Promise<HostSummaries> {
    const { firstDay, days } = period(numDays);
    const result: HostSummaries = { days, hosts: {} };
    if (hosts.length === 0) return result;

    // ?1 = first day, then the hosts.
    const IN = hosts.map((_, i) => `?${i + 2}`).join(",");
    const { results } = await env.DB.prepare(
        `SELECT host, day, SUM(views) AS views, SUM(new) AS new, SUM(reads) AS reads
         FROM views WHERE host IN (${IN}) AND day >= ?1 GROUP BY host, day`,
    )
        .bind(firstDay, ...hosts)
        .all<HostDailyRow>();

    for (const r of results) {
        const h = (result.hosts[r.host] ??= {
            totals: { views: 0, reads: 0, new: 0 },
            daily: { views: Array(numDays).fill(0), reads: Array(numDays).fill(0), new: Array(numDays).fill(0) },
        });
        h.daily.views[r.day - firstDay] = r.views;
        h.daily.reads[r.day - firstDay] = r.reads;
        h.daily.new[r.day - firstDay] = r.new;
        h.totals.views += r.views;
        h.totals.reads += r.reads;
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
        const filters = {
            page: url.searchParams.get("page") || null,
            source: url.searchParams.get("source") || null,
            country: url.searchParams.get("country") || null,
        };
        return json(await overview(env, host, days, filters));
    }
    if (url.pathname === "/api/hosts") {
        const hosts = configuredSites(env).map((s) => s.host);
        return json(await hostSummaries(env, hosts, days));
    }
    return new Response("Not found", { status: 404 });
}
