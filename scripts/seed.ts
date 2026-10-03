// Generates realistic dummy traffic for local development and writes it to
// .wrangler/seed.sql. Replaces everything in the local database.
//
//   pnpm db:seed                               # 90 days
//   node --experimental-strip-types scripts/seed.ts 30   # 30 days, generate only
//
// Keeps the schema's invariants: hit ids in time order, entry_hit_id pointing
// at each trip's arrival, src = referrer domain on arrivals / previous page on
// internal clicks, visitor ids in first-seen order, one `days` row per day.

import { mkdirSync, writeFileSync } from "node:fs";

const DAYS = Number(process.argv[2] ?? 90);
const TRIPS_PER_DAY = 600;
const OUT = ".wrangler/seed.sql";

// Deterministic PRNG so every seed produces the same data.
let state = 42;
function rand() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(items: [T, number][]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [v, w] of items) if ((r -= w) < 0) return v;
    return items[items.length - 1][0];
}
function int(min: number, max: number) {
    return Math.floor(min + rand() * (max - min + 1));
}

const SITE = "joodaloop.com";
const PAGES: Record<string, [string, number][]> = {
    "joodaloop.com": [
        ["/", 30],
        ["/about", 10],
        ["/now", 6],
        ["/posts/boring-analytics", 12],
        ["/posts/sqlite-is-enough", 14],
        ["/posts/notes-on-taste", 8],
        ["/posts/on-tools", 6],
        ["/posts/reading-list-2026", 5],
        ["/projects", 7],
    ],
    "webcraft.joodaloop.com": [
        ["/", 20],
        ["/lessons/1-html", 14],
        ["/lessons/2-css", 12],
        ["/lessons/3-layout", 9],
        ["/lessons/4-javascript", 7],
        ["/lessons/5-deploying", 5],
        ["/resources", 6],
    ],
    "mac.joodaloop.com": [
        ["/", 18],
        ["/apps", 12],
        ["/apps/raycast", 8],
        ["/apps/hammerspoon", 6],
        ["/tips/keyboard", 10],
        ["/tips/finder", 7],
        ["/setup", 9],
    ],
};
const HOSTS: [string, number][] = [
    ["joodaloop.com", 50],
    ["webcraft.joodaloop.com", 30],
    ["mac.joodaloop.com", 20],
];

const REFERRERS: [string | null, number][] = [
    [null, 34],
    ["google.com", 24],
    ["news.ycombinator.com", 6],
    ["x.com", 6],
    ["reddit.com", 5],
    ["lobste.rs", 3],
    ["duckduckgo.com", 4],
    ["bing.com", 3],
    ["github.com", 4],
    ["linkedin.com", 2],
    ["kagi.com", 2],
    ["bsky.app", 3],
];

// A couple of front-page days, each sending a burst to one post.
const SPIKES = [
    { daysAgo: 52, ref: "news.ycombinator.com", host: "joodaloop.com", page: "/posts/sqlite-is-enough", trips: 3200 },
    { daysAgo: 19, ref: "reddit.com", host: "mac.joodaloop.com", page: "/apps/hammerspoon", trips: 1400 },
    { daysAgo: 6, ref: "news.ycombinator.com", host: "webcraft.joodaloop.com", page: "/lessons/3-layout", trips: 2100 },
];

const COUNTRIES: [string | null, number][] = [
    ["US", 38], ["GB", 9], ["DE", 8], ["IN", 7], ["CA", 5], ["FR", 4], ["NL", 3],
    ["AU", 3], ["BR", 3], ["SE", 2], ["JP", 2], ["ES", 2], ["PL", 2], [null, 2],
];
type Agent = { browser: string; os: string; device: string };
const AGENTS: [Agent, number][] = [
    [{ browser: "Chrome", os: "Mac OS", device: "desktop" }, 22],
    [{ browser: "Safari", os: "Mac OS", device: "desktop" }, 10],
    [{ browser: "Firefox", os: "Mac OS", device: "desktop" }, 5],
    [{ browser: "Chrome", os: "Windows", device: "desktop" }, 16],
    [{ browser: "Edge", os: "Windows", device: "desktop" }, 5],
    [{ browser: "Firefox", os: "Linux", device: "desktop" }, 5],
    [{ browser: "Mobile Safari", os: "iOS", device: "mobile" }, 20],
    [{ browser: "Chrome", os: "Android", device: "mobile" }, 12],
    [{ browser: "Mobile Safari", os: "iOS", device: "tablet" }, 4],
];

// ---------------------------------------------------------------------------

type Visitor = { id: number; firstSeen: number; country: string | null; agent: Agent };
type Hit = {
    ts: number;
    trip: number;
    host: string;
    page: string;
    visitor: Visitor;
    src: string | null;
    utm: [string | null, string | null, string | null];
    engaged: number | null;
    scroll: number | null;
};

const now = Math.floor(Date.now() / 1000);
const today = Math.floor(now / 86400);
const visitors: Visitor[] = [];
const trips: { start: number; host: string; page: string; ref: string | null }[] = [];

// Trip start times: a gentle growth trend, quieter weekends, daytime peak.
for (let d = DAYS - 1; d >= 0; d--) {
    const day = today - d;
    const weekday = new Date(day * 86400 * 1000).getUTCDay();
    const growth = 0.75 + 0.5 * ((DAYS - d) / DAYS);
    const weekend = weekday === 0 || weekday === 6 ? 0.7 : 1;
    const count = Math.round(TRIPS_PER_DAY * growth * weekend * (0.85 + rand() * 0.3));

    for (let i = 0; i < count; i++) {
        const host = pick(HOSTS);
        trips.push({ start: dayTime(day), host, page: pick(PAGES[host]), ref: pick(REFERRERS) });
    }
    // Spikes decay over the following two days.
    for (const s of SPIKES) {
        const age = s.daysAgo - d;
        if (age < 0 || age > 2) continue;
        const n = Math.round(s.trips / [1, 3, 9][age]);
        for (let i = 0; i < n; i++) {
            trips.push({ start: dayTime(day), host: s.host, page: s.page, ref: s.ref });
        }
    }
}

function dayTime(day: number) {
    // Two-hump daily curve, roughly US + Europe daytime in UTC.
    const hour = pick([...Array(24)].map((_, h): [number, number] => [h, 2 + 6 * Math.exp(-((h - 15) ** 2) / 18) + 3 * Math.exp(-((h - 9) ** 2) / 10)]));
    return Math.min(now - 60, day * 86400 + hour * 3600 + int(0, 3599));
}

trips.sort((a, b) => a.start - b.start);

const hits: Hit[] = [];
trips.forEach((t, tripIndex) => {
    // ~30% of trips are returning visitors.
    let visitor: Visitor;
    if (visitors.length > 50 && rand() < 0.3) {
        visitor = visitors[int(Math.max(0, visitors.length - 20000), visitors.length - 1)];
    } else {
        visitor = { id: visitors.length + 1, firstSeen: t.start, country: pick(COUNTRIES), agent: pick(AGENTS) };
        visitors.push(visitor);
    }

    const utm: Hit["utm"] =
        t.ref === null && rand() < 0.08 ? ["newsletter", "email", pick([["march", 1], ["april", 1], ["launch", 1]])] : [null, null, null];

    let ts = t.start;
    let host = t.host;
    let page = t.page;
    let src: string | null = t.ref;
    // Arrival plus a geometric number of internal clicks.
    for (let n = 0; n < 8; n++) {
        const engaged = Math.round(Math.exp(2.5 + rand() * 2.8)); // ~12s to ~200s, long tail
        const lost = rand() < 0.05; // beacon never arrived
        hits.push({
            ts,
            trip: tripIndex,
            host,
            page,
            visitor,
            src,
            utm: n === 0 ? utm : [null, null, null],
            engaged: lost ? null : engaged,
            scroll: lost ? null : Math.min(100, int(15, 70) + (engaged > 60 ? int(10, 30) : 0)),
        });
        if (rand() > (n === 0 ? 0.42 : 0.5)) break;
        src = host + page;
        if (rand() < 0.15) host = pick(HOSTS.filter(([h]) => h !== host));
        const prev = src;
        do page = pick(PAGES[host]);
        while (host + page === prev);
        ts += engaged + int(1, 20);
    }
});

hits.sort((a, b) => a.ts - b.ts);
hits.forEach((h) => (h.ts = Math.min(h.ts, now - 1)));

// ---------------------------------------------------------------------------

const strings = new Map<string, number>();
function sid(v: string | null): number | null {
    if (v === null) return null;
    let id = strings.get(v);
    if (id === undefined) strings.set(v, (id = strings.size + 1));
    return id;
}
const sql = (v: number | null) => (v === null ? "NULL" : String(v));

const tripEntry = new Map<number, number>();
const hitRows: string[] = [];
const dayRows = new Map<number, number>();
hits.forEach((h, i) => {
    const id = i + 1;
    if (!tripEntry.has(h.trip)) tripEntry.set(h.trip, id);
    const day = Math.floor(h.ts / 86400);
    if (!dayRows.has(day)) dayRows.set(day, id);
    hitRows.push(
        `(${id},${h.ts},${sid(SITE)},${sid(h.host)},${sid(h.host + h.page)},${h.visitor.id},${tripEntry.get(h.trip)},` +
            `${sql(sid(h.src))},${sql(sid(h.utm[0]))},${sql(sid(h.utm[1]))},${sql(sid(h.utm[2]))},${sql(h.engaged)},${sql(h.scroll)})`,
    );
});

const visitorRows = visitors.map(
    (v) =>
        `(${v.id},${v.firstSeen},${sql(sid(v.country))},${sid(v.agent.browser)},${sid(v.agent.os)},${sid(v.agent.device)})`,
);
const esc = (s: string) => `'${s.replaceAll("'", "''")}'`;
const stringRows = [...strings].map(([v, id]) => `(${id},${esc(v)})`);

function inserts(table: string, cols: string, rows: string[]) {
    const out: string[] = [];
    for (let i = 0; i < rows.length; i += 500) {
        out.push(`INSERT INTO ${table} (${cols}) VALUES\n${rows.slice(i, i + 500).join(",\n")};`);
    }
    return out.join("\n");
}

mkdirSync(".wrangler", { recursive: true });
writeFileSync(
    OUT,
    [
        "DELETE FROM hits; DELETE FROM visitors; DELETE FROM days; DELETE FROM strings;",
        inserts("strings", "id, value", stringRows),
        inserts("visitors", "id, first_seen, country, browser, os, device", visitorRows),
        inserts(
            "hits",
            "id, ts, site, host, page, visitor_id, entry_hit_id, src, utm_source, utm_medium, utm_campaign, engaged_s, scroll_pct",
            hitRows,
        ),
        inserts("days", "day, first_hit_id", [...dayRows].map(([d, id]) => `(${d},${id})`)),
    ].join("\n"),
);

console.log(`${DAYS} days: ${hits.length} hits, ${tripEntry.size} trips, ${visitors.length} visitors -> ${OUT}`);
