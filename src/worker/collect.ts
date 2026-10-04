import { UAParser } from "ua-parser-js";
import { COUNT_READ, COUNT_VIEW, COUNT_VISITOR, READ_HIT } from "./counters";
import { newVisitorId, readVisitor, visitorCookie } from "./session";
import { canonicalSource } from "../shared/referrers";
import { configuredSites } from "./sites";
import { TZ_COUNTRY } from "./tz-country";

// Sent by the tracker on the first real scroll of a page.
type HitBody = {
    h: string; // location.hostname
    p: string; // location.pathname
    r?: string; // document.referrer, or the previous URL after an SPA navigation
    tz?: string; // Intl timezone, e.g. "Europe/Berlin"
    us?: string; // utm_source
};

// Sent by the tracker once a view has been visible long enough to count as
// read.
type ReadBody = {
    id: number; // hit id returned by /hit
};

const MAX_BODY = 4096;

async function readJson<T>(request: Request): Promise<T | null> {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
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
    // Only configured sites are collected, since only they're shown.
    if (!configuredSites(env).some((s) => s.host === host)) {
        return new Response("Forbidden", { status: 403, headers: noStore });
    }

    // Where the view came from: the referring site's domain, or on a click
    // within the site, the previous page's path (paths start with "/", so
    // the two never mix). Empty for direct visits.
    const ref = parseUrl(body.r);
    const refHost = ref?.hostname.toLowerCase();
    let source = "";
    if (refHost === host) source = ref!.pathname.slice(0, 1024);
    else if (refHost) source = canonicalSource(refHost.replace(/^www\./, ""));
    const ua = new UAParser(request.headers.get("user-agent") ?? undefined);
    const visitorId = (await readVisitor(request, env.COOKIE_SECRET)) ?? newVisitorId();
    const country = TZ_COUNTRY[body.tz ?? ""] ?? null;

    // The id is the highest so far plus one, and ts is set by the database,
    // so id order is time order. The hit's country is its reader's, as kept
    // on their visitors row; on their first hit (is_new, when they have no
    // row yet), the one from this timezone.
    const results = await env.DB.batch<{ id: number }>([
        env.DB.prepare(
            `INSERT INTO hits (host, page, visitor_id, source, utm_source, country, is_new)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     IFNULL((SELECT IFNULL(country, '') FROM visitors WHERE host = ?1 AND id = ?3), IFNULL(?6, '')),
                     NOT EXISTS (SELECT 1 FROM visitors WHERE host = ?1 AND id = ?3))
             RETURNING id`,
        ).bind(host, path, visitorId, source, clean(body.us, 200), country),
        env.DB.prepare(COUNT_VIEW),
        // Kept on the visitor if this is their first hit on the host.
        env.DB.prepare(COUNT_VISITOR).bind(
            country,
            ua.getBrowser().name ?? null,
            ua.getOS().name ?? null,
            ua.getDevice().type ?? "desktop",
        ),
    ]);

    const secure = new URL(request.url).protocol === "https:";
    return Response.json(
        { id: results[0].results[0].id },
        { headers: { ...noStore, "Set-Cookie": await visitorCookie(visitorId, env.COOKIE_SECRET, secure) } },
    );
}

export async function handleRead(request: Request, env: Env): Promise<Response> {
    const body = await readJson<ReadBody>(request);
    const visitorId = await readVisitor(request, env.COOKIE_SECRET);
    if (visitorId && body && Number.isSafeInteger(body.id)) {
        await env.DB.batch([
            env.DB.prepare(COUNT_READ).bind(body.id, visitorId),
            env.DB.prepare(READ_HIT).bind(body.id, visitorId),
        ]);
    }
    return new Response(null, { status: 204, headers: noStore });
}
