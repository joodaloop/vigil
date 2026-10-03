import { UAParser } from "ua-parser-js";
import { COUNT_END, COUNT_HIT, newToHost } from "./counters";
import { internAll } from "./strings";
import { readState, stateCookie, type VisitorState } from "./session";
import { TZ_COUNTRY } from "./tz-country";

// Sent by the tracker on the first real scroll of a page.
type HitBody = {
    h: string; // location.hostname
    p: string; // location.pathname
    r?: string; // document.referrer, or the previous URL after an SPA navigation
    tz?: string; // Intl timezone, e.g. "Europe/Berlin"
    us?: string; // utm_source
    um?: string; // utm_medium
    uc?: string; // utm_campaign
};

// Sent by the tracker's beacon whenever the page is hidden.
type EndBody = {
    id: number; // hit id returned by /hit
    e: number; // visible seconds so far
    s: number; // max scroll depth so far, 0-100
};

const MAX_BODY = 4096;
const MAX_ENGAGED_S = 6 * 60 * 60;

async function readJson<T>(request: Request): Promise<T | null> {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function isIp(host: string) {
    return /^[\d.]+$/.test(host) || host.includes(":");
}

// The site (cookie domain) a host is listed under in the config, or null if
// it isn't listed. Only listed hosts are collected, since only they're shown.
function siteForHost(host: string, sites: Env["SITES"]): string | null {
    for (const { site, hosts } of sites) {
        if (hosts.some((h) => h.host.toLowerCase() === host)) return site.toLowerCase();
    }
    return null;
}

function isSameSite(host: string, site: string) {
    return host === site || host.endsWith("." + site);
}

function clean(s: unknown, max: number): string | null {
    return typeof s === "string" && s.length > 0 ? s.slice(0, max) : null;
}

function parseUrl(s: string | undefined): URL | null {
    try {
        return s ? new URL(s) : null;
    } catch {
        return null;
    }
}

const noStore = { "Cache-Control": "no-store" };

export async function handleHit(request: Request, env: Env): Promise<Response> {
    const body = await readJson<HitBody>(request);
    const host = clean(body?.h, 253)?.toLowerCase();
    const path = clean(body?.p, 1024);
    if (!body || !host || !/^[a-z0-9.-]+$/.test(host) || !path?.startsWith("/")) {
        return new Response("Bad request", { status: 400, headers: noStore });
    }

    const site = siteForHost(host, env.SITES ?? []);
    if (!site) {
        return new Response("Forbidden", { status: 403, headers: noStore });
    }
    const cookieDomain = site === "localhost" || isIp(site) ? null : site;
    const page = host + path;
    const state = await readState(request, env.COOKIE_SECRET);

    // Arrival = referrer is external or empty, or we have no trip to continue.
    const ref = parseUrl(body.r);
    const refHost = ref?.hostname.toLowerCase() ?? null;
    const internal = !!refHost && isSameSite(refHost, site);
    const arrival = !(internal && state);

    // src: external referrer domain on arrivals; the previous page on internal
    // clicks. Same-host referrers carry the full path; cross-subdomain ones are
    // stripped to an origin, so those fall back to the cookie's lastPage.
    let src: string | null = null;
    if (arrival) {
        if (refHost && !internal) src = refHost.replace(/^www\./, "");
    } else if (refHost === host) {
        src = refHost + ref!.pathname;
    }

    let visitor: { country: string | null; browser: string | null; os: string | null; device: string } | null =
        null;
    if (!state) {
        const ua = new UAParser(request.headers.get("user-agent") ?? undefined);
        visitor = {
            country: TZ_COUNTRY[body.tz ?? ""] ?? null,
            browser: ua.getBrowser().name ?? null,
            os: ua.getOS().name ?? null,
            device: ua.getDevice().type ?? "desktop",
        };
    }

    const [siteId, hostId, pageId, srcId, utmSource, utmMedium, utmCampaign, country, browser, os, device] =
        await internAll(env.DB, [
            site,
            host,
            page,
            src,
            arrival ? clean(body.us, 200) : null,
            arrival ? clean(body.um, 200) : null,
            arrival ? clean(body.uc, 200) : null,
            visitor?.country,
            visitor?.browser,
            visitor?.os,
            visitor?.device,
        ]);

    const nextId = "(SELECT IFNULL(MAX(id), 0) + 1 FROM hits)";
    const statements: D1PreparedStatement[] = [];

    if (visitor) {
        statements.push(
            env.DB.prepare(
                `INSERT INTO visitors (id, first_seen, country, browser, os, device)
                 VALUES ((SELECT IFNULL(MAX(id), 0) + 1 FROM visitors), unixepoch(), ?, ?, ?, ?)
                 RETURNING id`,
            ).bind(country, browser, os, device),
        );
    }

    // A new visitor's id is the one just inserted above.
    const visitorSql = state ? "?4" : "(SELECT MAX(id) FROM visitors)";

    // ids are assigned here, inside the write transaction, so id order matches
    // ts order and an arrival can reference its own id.
    statements.push(
        env.DB.prepare(
            `INSERT INTO hits (id, site, host, page, visitor_id, entry_hit_id, src,
                               utm_source, utm_medium, utm_campaign, is_new)
             VALUES (${nextId}, ?1, ?2, ?3, ${visitorSql},
                     ${arrival ? nextId : "?5"},
                     ?6, ?7, ?8, ?9, ${newToHost(visitorSql, "?2")})
             RETURNING id`,
        ).bind(
            siteId,
            hostId,
            pageId,
            state?.visitorId ?? null,
            arrival ? null : state!.entryHitId,
            arrival ? srcId : (srcId ?? state!.lastPage),
            utmSource,
            utmMedium,
            utmCampaign,
        ),
        env.DB.prepare(
            `INSERT OR IGNORE INTO days (day, first_hit_id)
             SELECT ts / 86400, id FROM hits WHERE id = (SELECT MAX(id) FROM hits)`,
        ),
        ...COUNT_HIT.map((sql) => env.DB.prepare(sql)),
    );

    const results = await env.DB.batch<{ id: number }>(statements);
    const hitId = results[visitor ? 1 : 0].results[0].id;
    const next: VisitorState = {
        visitorId: visitor ? results[0].results[0].id : state!.visitorId,
        entryHitId: arrival ? hitId : state!.entryHitId,
        lastPage: pageId!,
    };

    const secure = new URL(request.url).protocol === "https:";
    return Response.json(
        { id: hitId },
        { headers: { ...noStore, "Set-Cookie": await stateCookie(next, env.COOKIE_SECRET, cookieDomain, secure) } },
    );
}

export async function handleEnd(request: Request, env: Env): Promise<Response> {
    const body = await readJson<EndBody>(request);
    const state = await readState(request, env.COOKIE_SECRET);
    if (!state || !body || !Number.isSafeInteger(body.id)) {
        return new Response(null, { status: 204, headers: noStore });
    }

    const engaged = Math.min(MAX_ENGAGED_S, Math.max(0, Math.round(Number(body.e) || 0)));
    const scroll = Math.min(100, Math.max(0, Math.round(Number(body.s) || 0)));

    // Beacons repeat and arrive out of order. Only write if a value is missing
    // or increases. visitor_id stops anyone updating others' hits. The day's
    // engagement sums go first, while the hit still has its old values.
    const params = [engaged, scroll, body.id, state.visitorId];
    await env.DB.batch([
        env.DB.prepare(COUNT_END).bind(...params),
        env.DB.prepare(
            `UPDATE hits SET engaged_s = MAX(IFNULL(engaged_s, 0), ?1), scroll_pct = MAX(IFNULL(scroll_pct, 0), ?2)
             WHERE id = ?3 AND visitor_id = ?4
               AND (engaged_s IS NULL OR scroll_pct IS NULL OR engaged_s < ?1 OR scroll_pct < ?2)`,
        ).bind(...params),
    ]);

    return new Response(null, { status: 204, headers: noStore });
}
