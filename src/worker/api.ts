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
// optional `ref` (source), `page` (path) and `country` (ISO code) filters.
//
// Every number is a SUM over `views` (schema.sql), except
// unique visitors: unfiltered, a count of `visitors`; under a filter, a count
// of the filter's hits, since readers can't be summed. `views` only breaks
// the numbers down by page and source, so under a country filter they're all
// summed from that country's hits instead (hitQueries.ts). A source is another site's domain, or on a click within the
// site, the path of the page it came from (paths start with "/").

type DailyRow = { day: number; views: number; visitors: number; new: number; reads: number };
type PageDayRow = { page: string; day: number; views: number; new: number };
type SourceDayRow = { source: string; day: number; views: number; new: number };
type PeopleRow = { device: string | null; country: string | null; os: string | null; visitors: number; bounced: number };
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

async function overview(env: Env, host: string, numDays: number, filters: Filters): Promise<Overview> {
    const { page, source: ref, country } = filters;
    const { firstDay, days } = period(numDays);
    const result: Overview = { days, ref, page, country, stats: emptyHost(numDays) };
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
    // The same three, from a country's hits.
    const inCountry = country ? countrySums(host, firstDay, { page, source: ref, country }) : null;
    const h = (part: { sql: string; params: unknown[] }) => env.DB.prepare(part.sql).bind(...part.params);
    // Visitors in the period, by device, country and OS, under `f`. Unfiltered:
    // everyone whose latest visit is in it, since the period ends today, read
    // from the covering index; filtered, from the filter's hits.
    const people = (f: Filters) => {
        if (f.page || f.source || f.country) {
            const u = filteredVisitors(host, firstDay, f);
            return env.DB.prepare(u.people).bind(...u.params);
        }
        return env.DB.prepare(
            `SELECT device, country, os, COUNT(*) AS visitors, SUM(first_ts >= ?2 AND first_ts = last_ts) AS bounced
             FROM visitors WHERE host = ?1 AND last_ts >= ?2 GROUP BY device, country, os`,
        ).bind(host, firstDay * 86400);
    };

    const filtered = page || ref || country;
    const byFilter = filtered ? filteredVisitors(host, firstDay, filters) : null;
    const [daily, pages, sources, everyone, filteredDaily, byCountry] = (await env.DB.batch([
        inCountry
            ? h(inCountry.daily)
            : q(
                  `SELECT day, SUM(views) AS views, SUM(visitors) AS visitors, SUM(new) AS new, SUM(reads) AS reads
                   FROM views WHERE $WHERE GROUP BY day`,
                  true,
                  true,
              ),
        inCountry
            ? h(inCountry.pages)
            : q(`SELECT page, day, SUM(views) AS views, SUM(new) AS new FROM views WHERE $WHERE GROUP BY page, day`, false, true),
        // Where views came from: another site, or on a click within the site,
        // the previous page. With a page filter, where that page's readers
        // came from.
        inCountry
            ? h(inCountry.sources)
            : q(`SELECT source, day, SUM(views) AS views, SUM(new) AS new FROM views WHERE $WHERE AND source != '' GROUP BY source, day`, true, false),
        people(filters),
        // Filtered, visitors per day; unfiltered, they're summed from `views`.
        byFilter ? env.DB.prepare(byFilter.daily).bind(...byFilter.params) : null,
        // The countries' flags ignore the country filter, so with one picked
        // they need their own count.
        country ? people({ page, source: ref, country: null }) : null,
    ].filter((s) => s !== null))) as [
        D1Result<DailyRow>,
        D1Result<PageDayRow>,
        D1Result<SourceDayRow>,
        D1Result<PeopleRow>,
        ...D1Result[],
    ];
    const visitorsByDay = filteredDaily as D1Result<{ day: number; visitors: number }> | undefined;
    const flagsFrom = (country ? byCountry : everyone) as D1Result<PeopleRow>;

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

    const byPage = new Map<string, PageRow>();
    for (const r of pages.results) {
        let p = byPage.get(r.page);
        if (!p) {
            const zeros = () => Array(numDays).fill(0);
            byPage.set(r.page, (p = { path: r.page, views: 0, new: 0, daily: zeros(), dailyNew: zeros() }));
        }
        p.views += r.views;
        p.new += r.new;
        p.daily[r.day - firstDay] = r.views;
        p.dailyNew[r.day - firstDay] = r.new;
    }
    stats.pages = [...byPage.values()].sort((a, b) => b.views - a.views);

    const bySource = new Map<string, Referrer>();
    for (const r of sources.results) {
        let s = bySource.get(r.source);
        if (!s) bySource.set(r.source, (s = { domain: r.source, visits: 0, new: 0, daily: Array(numDays).fill(0), dailyNew: Array(numDays).fill(0) }));
        s.visits += r.views;
        s.new += r.new;
        s.daily[r.day - firstDay] = r.views;
        s.dailyNew[r.day - firstDay] = r.new;
    }
    stats.referrers = [...bySource.values()].sort((a, b) => b.new - a.new || b.visits - a.visits);

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
    for (const r of flagsFrom.results) {
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
        const filters = {
            page: url.searchParams.get("page") || null,
            source: url.searchParams.get("ref") || null,
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
