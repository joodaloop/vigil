// One-off import of Counterscale data from Workers Analytics Engine into
// Vigil's schema. Writes .wrangler/import.sql, to be applied to a database that
// has no hits yet (ids must stay in time order):
//
//   CF_ACCOUNT_ID=... CF_AE_TOKEN=... node --experimental-strip-types scripts/import-ae.ts
//   pnpm wrangler d1 execute DB --local  --file .wrangler/import.sql   # preview
//   pnpm wrangler d1 execute DB --remote --file .wrangler/import.sql   # for real
//
// Counterscale never stored visitor ids, so visitors and trips are made up:
// - A hit flagged newVisitor (first hit of the day from that browser) starts a
//   made-up visitor. Other hits that day with the same host, country, browser
//   and device go to the most recent one.
// - Counterscale dropped same-site referrers, so a hit with no referrer is an
//   internal click if its visitor already has a trip, otherwise a direct arrival.
// - Engagement (time on page, scroll depth) and OS weren't collected.
// Rows sampled by Analytics Engine are repeated `_sample_interval` times.

import { mkdirSync, writeFileSync } from "node:fs";

const OUT = ".wrangler/import.sql";
const DATASET = "metricsDataset";

// Analytics Engine host -> Vigil host. Anything else is skipped.
const HOSTS: Record<string, string> = {
    "https://joodaloop.com": "joodaloop.com",
    "https://anjalishriva.com": "anjalishriva.com",
    "https://www.anjalishriva.com": "anjalishriva.com",
};

const { CF_ACCOUNT_ID, CF_AE_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_AE_TOKEN) {
    console.error("Set CF_ACCOUNT_ID and CF_AE_TOKEN");
    process.exit(1);
}

type AeRow = {
    timestamp: string; // "2026-10-03 11:57:40", UTC
    host: string;
    path: string;
    country: string;
    referrer: string;
    browser: string;
    device: string;
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    new_visitor: number;
    w: number;
};

async function query(sql: string): Promise<AeRow[]> {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CF_AE_TOKEN}` },
        body: `${sql} FORMAT JSON`,
    });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return ((await r.json()) as { data: AeRow[] }).data;
}

// Fetch a week at a time to stay well under the API's row limits.
async function fetchAll(): Promise<AeRow[]> {
    const hosts = Object.keys(HOSTS)
        .map((h) => `'${h}'`)
        .join(",");
    const rows: AeRow[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (let end = now; end > now - 100 * 86400; end -= 7 * 86400) {
        const batch = await query(
            `SELECT timestamp, blob1 AS host, blob3 AS path, blob4 AS country, blob5 AS referrer,
                    blob6 AS browser, blob10 AS device, blob11 AS utm_source, blob12 AS utm_medium,
                    blob13 AS utm_campaign, double1 AS new_visitor, _sample_interval AS w
             FROM ${DATASET}
             WHERE blob1 IN (${hosts})
               AND timestamp > toDateTime(${end - 7 * 86400}) AND timestamp <= toDateTime(${end})`,
        );
        rows.push(...batch);
    }
    return rows;
}

const toUnix = (ts: string) => Math.floor(Date.parse(ts.replace(" ", "T") + "Z") / 1000);
const siteOf = (host: string) => host.split(".").slice(-2).join(".");

// Referrer -> { host, path }. Counterscale stored some as bare labels
// ("substack", "localfirstnews.com"); those come back with no path.
function parseReferrer(ref: string): { host: string; path: string | null } | null {
    if (!ref) return null;
    try {
        const u = new URL(ref.includes("://") ? ref : `https://${ref}`);
        return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: ref.includes("://") ? u.pathname : null };
    } catch {
        return { host: ref.toLowerCase(), path: null };
    }
}

type Visitor = {
    id: number;
    firstSeen: number;
    country: string | null;
    browser: string | null;
    device: string | null;
    entryHitId: number | null;
    lastPage: string | null;
};

const raw = await fetchAll();
const rows = raw
    .filter((r) => HOSTS[r.host] && !/headless/i.test(r.browser))
    .flatMap((r) => Array<AeRow>(Math.max(1, r.w)).fill(r))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

const strings = new Map<string, number>();
const sid = (v: string | null) => {
    if (!v) return null;
    let id = strings.get(v);
    if (id === undefined) strings.set(v, (id = strings.size + 1));
    return id;
};
const sql = (v: number | null) => (v === null ? "NULL" : String(v));
const esc = (s: string) => `'${s.replaceAll("'", "''")}'`;

const visitors: Visitor[] = [];
const latestInGroup = new Map<string, Visitor>(); // "day|host|country|browser|device"
const hitRows: string[] = [];
const days = new Map<number, number>();

rows.forEach((r, i) => {
    const id = i + 1;
    const ts = toUnix(r.timestamp);
    const host = HOSTS[r.host];
    const site = siteOf(host);
    const path = (r.path || "/").split("?")[0].slice(0, 1024);
    const page = host + path;
    const groupKey = [Math.floor(ts / 86400), host, r.country, r.browser, r.device].join("|");

    let visitor = r.new_visitor ? undefined : latestInGroup.get(groupKey);
    if (!visitor) {
        visitor = {
            id: visitors.length + 1,
            firstSeen: ts,
            country: r.country || null,
            browser: r.browser || null,
            device: r.device || null,
            entryHitId: null,
            lastPage: null,
        };
        visitors.push(visitor);
        latestInGroup.set(groupKey, visitor);
    }

    // Arrival vs internal click, and what `src` holds for each.
    const ref = parseReferrer(r.referrer);
    const sameSite = ref && (ref.host === site || ref.host.endsWith("." + site));
    let arrival: boolean;
    let src: string | null;
    if (ref && !sameSite) {
        arrival = true;
        src = ref.host;
    } else if (visitor.entryHitId !== null) {
        arrival = false;
        src = ref && ref.path !== null ? ref.host + ref.path : visitor.lastPage;
    } else {
        // Same-site referrer or none, but nothing to continue: an arrival.
        arrival = true;
        src = ref ? ref.host : null;
    }

    if (arrival) visitor.entryHitId = id;
    visitor.lastPage = page;
    const day = Math.floor(ts / 86400);
    if (!days.has(day)) days.set(day, id);

    const utm = (v: string) => (arrival && v ? sid(v.slice(0, 200)) : null);
    hitRows.push(
        `(${id},${ts},${sid(site)},${sid(host)},${sid(page)},${visitor.id},${visitor.entryHitId},` +
            `${sql(sid(src))},${sql(utm(r.utm_source))},${sql(utm(r.utm_medium))},${sql(utm(r.utm_campaign))})`,
    );
});

const visitorRows = visitors.map(
    (v) => `(${v.id},${v.firstSeen},${sql(sid(v.country))},${sql(sid(v.browser))},NULL,${sql(sid(v.device))})`,
);
const stringRows = [...strings].map(([v, id]) => `(${id},${esc(v)})`);

function inserts(table: string, cols: string, values: string[]) {
    const out: string[] = [];
    for (let i = 0; i < values.length; i += 500) {
        out.push(`INSERT INTO ${table} (${cols}) VALUES\n${values.slice(i, i + 500).join(",\n")};`);
    }
    return out.join("\n");
}

mkdirSync(".wrangler", { recursive: true });
writeFileSync(
    OUT,
    [
        inserts("strings", "id, value", stringRows),
        inserts("visitors", "id, first_seen, country, browser, os, device", visitorRows),
        inserts(
            "hits",
            "id, ts, site, host, page, visitor_id, entry_hit_id, src, utm_source, utm_medium, utm_campaign",
            hitRows,
        ),
        inserts("days", "day, first_hit_id", [...days].map(([d, id]) => `(${d},${id})`)),
    ].join("\n"),
);

const skipped = raw.filter((r) => !HOSTS[r.host] || /headless/i.test(r.browser)).length;
const perHost = rows.reduce<Record<string, number>>((m, r) => ((m[HOSTS[r.host]] = (m[HOSTS[r.host]] ?? 0) + 1), m), {});
console.log(`fetched ${raw.length} rows, skipped ${skipped} (other hosts / headless)`);
console.log(`wrote ${rows.length} hits, ${visitors.length} made-up visitors, ${strings.size} strings -> ${OUT}`);
console.log("hits per host:", perHost);
console.log("range:", rows[0]?.timestamp, "->", rows.at(-1)?.timestamp);
