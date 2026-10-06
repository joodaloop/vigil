import { isWellKnown } from "../shared/referrers";
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
// Both cover the last `days` UTC days (today included), or with `ago`, the
// `days` days that ended `ago` days before today. The overview takes
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
type PeopleRow = {
    device: string | null;
    country: string | null;
    os: string | null;
    browser: string | null;
    visitors: number;
    bounced: number;
};
type SourceInfoRow = { domain: string; name: string | null; icon: number | null };
type PageTitleRow = { path: string; title: string };
type HostDailyRow = { host: string; day: number; views: number; new: number; reads: number };

// The first and last days (UTC day numbers) of the `numDays` ending `ago`
// days before today, and each day's start in unix seconds.
function period(numDays: number, ago: number) {
    const lastDay = Math.floor(Date.now() / 1000 / 86400) - ago;
    const firstDay = lastDay - numDays + 1;
    return { firstDay, lastDay, days: Array.from({ length: numDays }, (_, i) => (firstDay + i) * 86400) };
}

function emptyHost(n: number): HostStats<Sparse> {
    return {
        totals: {
            views: 0,
            reads: 0,
            visitors: 0,
            devices: { desktop: 0, tablet: 0, mobile: 0 },
            systems: { windows: 0, mac: 0, ios: 0, android: 0, linux: 0, known: 0 },
            engines: { blink: 0, webkit: 0, gecko: 0, known: 0 },
            countries: [],
            new: 0,
            newBounced: 0,
        },
        daily: { views: Array(n).fill(0), visitors: Array(n).fill(0), new: Array(n).fill(0), reads: Array(n).fill(0) },
        referrers: [],
        pages: [],
    };
}

async function overview(env: Env, host: string, numDays: number, ago: number, filters: Filters): Promise<Overview<Sparse>> {
    const { page, source, country } = filters;
    const { firstDay, lastDay, days } = period(numDays, ago);
    const result: Overview<Sparse> = { days, stats: emptyHost(numDays) };
    // The sums are grouped in SQL, so the Worker gets back a few hundred
    // rows rather than every (day, page, source) one. Every number, lists
    // included, takes every filter.
    const q = (sql: string) => {
        const where = ["host = ?", "day >= ?", "day <= ?"];
        const params: unknown[] = [host, firstDay, lastDay];
        if (page) where.push("page = ?"), params.push(page);
        if (source) where.push("source = ?"), params.push(source);
        return env.DB.prepare(sql.replace("$WHERE", where.join(" AND "))).bind(...params);
    };
    // The same three, from a country's hits.
    const inCountry = country ? countrySums(host, firstDay, { page, source, country }, lastDay) : null;
    const h = (part: { sql: string; params: unknown[] }) => env.DB.prepare(part.sql).bind(...part.params);
    // Visitors are counted from hits under a filter, or in a period that
    // ended before today (when `visitors` only says who came since).
    const fromHits = page || source || country || ago > 0;
    const byFilter = fromHits ? filteredVisitors(host, firstDay, filters, lastDay) : null;
    const [daily, pages, sources, everyone, filteredDaily] = (await env.DB.batch([
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
        // Visitors in the period, by device, country, OS and browser. Unfiltered and
        // ending today: everyone whose latest visit is in it, read from the
        // covering index; otherwise, from the period's (and filter's) hits.
        byFilter
            ? env.DB.prepare(byFilter.people).bind(...byFilter.params)
            : env.DB.prepare(
                  `SELECT device, country, os, browser, COUNT(*) AS visitors, SUM(first_ts >= ?2 AND first_ts = last_ts) AS bounced
                   FROM visitors WHERE host = ?1 AND last_ts >= ?2 GROUP BY device, country, os, browser`,
              ).bind(host, firstDay * 86400),
        // From hits, visitors per day; otherwise they're summed from `views`.
        byFilter ? env.DB.prepare(byFilter.daily).bind(...byFilter.params) : null,
    ].filter((s) => s !== null))) as [
        D1Result<DailyRow>,
        D1Result<PageDayRow>,
        D1Result<SourceDayRow>,
        D1Result<PeopleRow>,
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
    // What's been read from pages (schema.sql), for exactly the rows above:
    // the site's icon, other sites' names and icons (not the well-known
    // ones', which have none), and pages' titles, for their rows and for
    // the referrers they are when clicked through from. Each list is one
    // JSON parameter, and each lookup reads only the rows it finds.
    const sourceKeys = [...bySource.keys()];
    const domains = [host, ...sourceKeys.filter((s) => !s.startsWith("/") && !isWellKnown(s))];
    const paths = [...new Set([...byPage.keys(), ...sourceKeys.filter((s) => s.startsWith("/"))])];
    const [sourceInfo, titles] = (await env.DB.batch([
        env.DB.prepare(
            `SELECT domain, name, icon_ts AS icon FROM sources WHERE domain IN (SELECT value FROM json_each(?1))`,
        ).bind(JSON.stringify(domains)),
        env.DB.prepare(
            `SELECT path, title FROM pages
             WHERE host = ?1 AND path IN (SELECT value FROM json_each(?2)) AND title IS NOT NULL`,
        ).bind(host, JSON.stringify(paths)),
    ])) as [D1Result<SourceInfoRow>, D1Result<PageTitleRow>];
    for (const r of sourceInfo.results) {
        if (r.domain === host && r.icon !== null) result.icon = r.icon;
        const s = bySource.get(r.domain);
        if (s && r.name) s.name = r.name;
        if (s && r.icon !== null) s.icon = r.icon;
    }
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
        const engine = engineOf(r.browser, r.os);
        if (engine) t.engines[engine] += r.visitors;
        if (r.browser) t.engines.known += r.visitors;
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

// A browser's engine, by the browser and OS names ua-parser-js gives: every
// browser on iOS is WebKit underneath; elsewhere, Safari is WebKit, Firefox
// and its forks are Gecko, and Chrome and the browsers built on Chromium
// (Edge, Opera, Samsung Internet, Brave, ...) are Blink. Null for others.
function engineOf(browser: string | null, os: string | null): "blink" | "webkit" | "gecko" | null {
    if (!browser) return null;
    if (os === "iOS" || /safari/i.test(browser)) return "webkit";
    if (/firefox|waterfox|librewolf|icecat|seamonkey|pale moon/i.test(browser)) return "gecko";
    if (/chrom|edge|opera|samsung|brave|vivaldi|yandex|whale|silk|arc/i.test(browser)) return "blink";
    return null;
}

async function hostSummaries(env: Env, hosts: string[], numDays: number, ago: number): Promise<HostSummaries> {
    const { firstDay, lastDay, days } = period(numDays, ago);
    const result: HostSummaries = { days, hosts: {} };
    if (hosts.length === 0) return result;

    // ?1 = first day, ?2 = last day, then the hosts.
    const IN = hosts.map((_, i) => `?${i + 3}`).join(",");
    const { results } = await env.DB.prepare(
        `SELECT host, day, SUM(views) AS views, SUM(new) AS new, SUM(reads) AS reads
         FROM views WHERE host IN (${IN}) AND day >= ?1 AND day <= ?2 GROUP BY host, day`,
    )
        .bind(firstDay, lastDay, ...hosts)
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
    const ago = Math.min(3660, Math.max(0, Math.floor(Number(url.searchParams.get("ago")) || 0)));

    if (url.pathname === "/api/overview") {
        const host = (url.searchParams.get("host") ?? "").toLowerCase();
        const filters = {
            page: url.searchParams.get("page") || null,
            source: url.searchParams.get("source") || null,
            country: url.searchParams.get("country") || null,
        };
        return json(await overview(env, host, days, ago, filters));
    }
    if (url.pathname === "/api/hosts") {
        const hosts = configuredSites(env).map((s) => s.host);
        return json(await hostSummaries(env, hosts, days, ago));
    }
    return new Response("Not found", { status: 404 });
}
