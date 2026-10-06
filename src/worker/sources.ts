// What's read from pages, for what the dashboard shows (schema.sql): pages'
// titles (`pages`), from the pages themselves; and sites' names and favicons
// (`sources`), from their home pages, for referring sites that aren't
// well-known ones and the site itself. And the icons, served from there.

// A favicon this size or under is kept; a larger one, the dashboard gets
// from DuckDuckGo instead.
const MAX_ICON = 30 * 1024;

// Metadata is usually near the start, but a head can contain large scripts
// or styles. Stop after this much HTML even if its closing tag never comes.
const MAX_HTML = 128 * 1024;

// How long a lookup lasts before the dashboard looks again.
export const REFRESH = 30 * 86400;

// The most requests one dashboard load's lookups make, redirects included:
// under a Worker's 50 subrequests on the free plan. A page's lookup makes one
// (the page), a site's two (its home page, then its icon), and each redirect
// one more. The dashboard claims only as many lookups as fit without
// redirects; those the redirects leave no room for are released, so a later
// load takes them.
export const FETCHES = 45;

// The most lookups running at once. A Worker has 6 connections open at a
// time and queues the rest, and a request's timeout runs while it's queued.
const CONCURRENT = 5;

// The most redirects a request follows.
const MAX_REDIRECTS = 3;

// Thrown by a request that FETCHES leaves no room for.
class OutOfFetches extends Error {}
type Budget = { left: number };

// How long a claim holds before it's done: a load whose lookups are cut off
// (its Worker stopped, or an error) leaves them to another after this.
const LEASE = 5 * 60;

// A claim's claimed_ts: as if done long enough ago that it's due again in
// LEASE, so it lapses unless the lookup finishes and sets it to now.
const LEASED = `unixepoch() - ${REFRESH - LEASE}`;

// With ?1 = the site's domain, or a referring one's. Returns a row when this
// claims the domain's lookup: there's none yet, the last was done over 30
// days ago, or another load's claim has lapsed. Otherwise (another load
// holds it, or did it) it writes nothing.
export const CLAIM_SOURCE = `INSERT INTO sources (domain, claimed_ts) VALUES (?1, ${LEASED})
    ON CONFLICT (domain) DO UPDATE SET claimed_ts = ${LEASED} WHERE claimed_ts < unixepoch() - ${REFRESH}
    RETURNING 1`;

// With ?1 = the site's domain and ?2 = the page's path. Returns a row when
// this claims the page's lookup, as for CLAIM_SOURCE.
export const CLAIM_PAGE = `INSERT INTO pages (host, path, claimed_ts) VALUES (?1, ?2, ${LEASED})
    ON CONFLICT (host, path) DO UPDATE SET claimed_ts = ${LEASED} WHERE claimed_ts < unixepoch() - ${REFRESH}
    RETURNING 1`;

// A lookup that's due for a site's dashboard: one of its pages (or a path
// it was clicked through from), or a domain (a referring one's, or the
// site's own, for its favicon beside clicks within it).
export type Lookup = { path: string } | { domain: string };

// Claims the lookups that are due (the caller keeps them within FETCHES) and
// does the ones it wins, CONCURRENT at a time, in order. Run after a
// dashboard load has answered: what's found shows on the next.
export async function lookUpDue(env: Env, host: string, due: Lookup[], fetches = FETCHES): Promise<void> {
    const claims = await env.DB.batch(
        due.map((l) =>
            "path" in l ? env.DB.prepare(CLAIM_PAGE).bind(host, l.path) : env.DB.prepare(CLAIM_SOURCE).bind(l.domain),
        ),
    );
    const queue = due.filter((_, i) => claims[i].results.length > 0);
    const budget: Budget = { left: fetches };
    const setClaim = (l: Lookup, ts: string) =>
        ("path" in l
            ? env.DB.prepare(`UPDATE pages SET claimed_ts = ${ts} WHERE host = ?1 AND path = ?2`).bind(host, l.path)
            : env.DB.prepare(`UPDATE sources SET claimed_ts = ${ts} WHERE domain = ?1`).bind(l.domain)
        ).run();
    const lookUp = async (l: Lookup) => {
        try {
            if ("path" in l) await lookUpPage(env, host, l.path, budget);
            else await lookUpSource(env, l.domain, budget, l.domain === host);
            // Done (a page that couldn't be fetched too): not again for 30 days.
            await setClaim(l, "unixepoch()");
        } catch (e) {
            // Not done (and nothing saved): released now, for a later load,
            // or for anything else, when the lease lapses.
            if (e instanceof OutOfFetches) await setClaim(l, "0");
            else console.error("lookup failed", l, e);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENT, queue.length) }, async () => {
            for (let l = queue.shift(); l; l = queue.shift()) await lookUp(l);
        }),
    );
}

// Fetches a site's home page and keeps its name and favicon: a referring
// site's, or with `own`, the dashboard's own, whose name is only an
// og:site_name, as its home page's title may not be the site's (the
// dashboard shows the configured one anyway). A page that can't be fetched
// (or read in full) leaves the row as it was, until the next claim.
export async function lookUpSource(env: Env, domain: string, budget?: Budget, own = false): Promise<void> {
    const head = await readHead(`https://${domain}/`, budget);
    if (!head) return;
    const name = own ? nameFrom(head.siteName, "") : nameFrom(head.siteName, head.title);
    await saveSource(env, domain, name, await favicon(new URL(head.iconHref ?? "/favicon.ico", head.url), budget));
}

// Fetches a page of a site (claimed) and keeps its title.
export async function lookUpPage(env: Env, host: string, path: string, budget?: Budget): Promise<void> {
    // Joined, not resolved, so a path like "//elsewhere/x" stays on the site.
    const head = await readHead(`https://${host}${path}`, budget);
    if (!head) return;
    // The first of them with any text (a blank og:title doesn't hide a title).
    const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
    const title = clean(head.pageTitle) || clean(head.title) || null;
    await env.DB.prepare(`UPDATE pages SET title = ?3 WHERE host = ?1 AND path = ?2`).bind(host, path, title).run();
}

// Keeps a site's name (null: no new one, so the old one stays) and favicon
// (undefined: a failed request, which doesn't tell whether the saved one is
// gone, so it stays too).
async function saveSource(
    env: Env,
    domain: string,
    name: string | null,
    icon: { data: Uint8Array; type: string } | null | undefined,
): Promise<void> {
    if (icon === undefined) {
        await env.DB.prepare(`UPDATE sources SET name = IFNULL(?2, name) WHERE domain = ?1`).bind(domain, name).run();
        return;
    }
    // The icon's version moves on only when it's a different icon (in an
    // UPDATE, `icon` is still the old one).
    await env.DB.prepare(
        `UPDATE sources SET name = IFNULL(?2, name), icon = ?3, icon_type = ?4,
             icon_ts = IIF(?3 IS NULL, NULL, IIF(icon IS ?3, icon_ts, unixepoch()))
         WHERE domain = ?1`,
    )
        .bind(domain, name, icon?.data ?? null, icon?.type ?? null)
        .run();
}

// A page's <head>: its og:site_name, og:title, <title> and first icon link
// (decoded), and its address after any redirects. Null when it can't be
// fetched, isn't HTML, or its head isn't over within MAX_HTML (a partial
// head can't establish that something's absent).
async function readHead(url: string | URL, budget?: Budget) {
    let page: Response;
    try {
        page = await get(url, budget);
    } catch (e) {
        if (e instanceof OutOfFetches) throw e;
        return null;
    }
    if (!page.ok || !page.body || !page.headers.get("Content-Type")?.includes("text/html")) return null;

    let siteName = "";
    let pageTitle = "";
    let title = "";
    let iconHref: string | null = null;
    let headDone = false;
    let bytes = 0;
    let capped = false;
    const html = page.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const remaining = MAX_HTML - bytes;
            const part = chunk.subarray(0, remaining);
            bytes += part.byteLength;
            controller.enqueue(part);
            if (bytes === MAX_HTML) {
                capped = true;
                controller.terminate();
            }
        },
    }));
    const rewritten = new HTMLRewriter()
        .on("head", {
            element(e) {
                e.onEndTag(() => { headDone = true; });
            },
        })
        .on('head meta[property="og:site_name"]', {
            element(e) {
                siteName ||= e.getAttribute("content") ?? "";
            },
        })
        .on('head meta[property="og:title"]', {
            element(e) {
                pageTitle ||= e.getAttribute("content") ?? "";
            },
        })
        .on("head title", {
            text(t) {
                title += t.text;
            },
        })
        // The first icon link; not apple-touch-icon, which is large.
        .on("head link[rel][href]", {
            element(e) {
                const rel = e.getAttribute("rel")!.toLowerCase().split(/\s+/);
                if (!iconHref && rel.includes("icon")) iconHref = e.getAttribute("href");
            },
        })
        .transform(new Response(html, { headers: page.headers }));
    const reader = rewritten.body!.getReader();
    try {
        // Drive the rewriter without retaining its output, and cancel the
        // remaining download as soon as the head's end tag is parsed.
        while (!headDone) {
            if ((await reader.read()).done) break;
        }
    } catch {
        return null;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    if (capped && !headDone) return null;
    return {
        siteName: decode(siteName),
        pageTitle: decode(pageTitle),
        title: decode(title),
        iconHref: iconHref === null ? null : decode(iconHref),
        url: page.url,
    };
}

// GET /api/icon/{domain}: a site's favicon. The one saved for it, if any:
// its address then carries its version (?v=), so it's cached for good.
// Otherwise DuckDuckGo's, cached for a month; or if DuckDuckGo has none
// (a 404, though with a placeholder image, which a browser would show), an
// empty 404, cached for a day, so the dashboard shows its own icon instead.
export async function handleIcon(url: URL, env: Env): Promise<Response> {
    let domain: string;
    try {
        domain = decodeURIComponent(url.pathname.slice("/api/icon/".length)).toLowerCase();
    } catch {
        // A malformed escape, e.g. "%E0": no such domain.
        return new Response(null, { status: 404 });
    }
    const row = await env.DB.prepare(`SELECT icon, icon_type FROM sources WHERE domain = ?1 AND icon IS NOT NULL`)
        .bind(domain)
        .first<{ icon: ArrayBuffer | number[]; icon_type: string }>();
    if (row) return iconResponse(new Uint8Array(row.icon), row.icon_type, "public, max-age=31536000, immutable");

    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
        try {
            const r = await get(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
            const type = r.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
            if (r.ok && r.body && type.startsWith("image/")) {
                return iconResponse(r.body, type, `public, max-age=${30 * 86400}`);
            }
        } catch {
            // As if it had none.
        }
    }
    return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
}

function iconResponse(body: BodyInit, type: string, cache: string) {
    return new Response(body, {
        headers: {
            "Content-Type": type,
            "Cache-Control": cache,
            // An SVG opened on its own would otherwise run its scripts here.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

// A GET, following up to MAX_REDIRECTS redirects itself so that each counts
// against `budget`, if given. After that many, the redirect is the response.
async function get(url: string | URL, budget?: Budget): Promise<Response> {
    for (let redirects = 0; ; redirects++) {
        if (budget && budget.left-- <= 0) throw new OutOfFetches();
        const r = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Vigil; +https://github.com/joodaloop/vigil)" },
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
        });
        const location = r.headers.get("Location");
        if (r.status < 300 || r.status >= 400 || !location || redirects === MAX_REDIRECTS) return r;
        await r.body?.cancel();
        url = new URL(location, url);
    }
}

// A site's name: its og:site_name, or the first part of its title ("Some
// Blog" from "Some Blog | Writing about things"); null for neither.
function nameFrom(siteName: string, title: string): string | null {
    const name = siteName.trim() || title.trim().split(/\s+[|–—·•:-]\s+/)[0].trim();
    return name.replace(/\s+/g, " ").slice(0, 100) || null;
}

// The icon at `url`, if it's an image of at most MAX_ICON bytes; null when
// missing or unusable, undefined when a failed request leaves it unknown.
async function favicon(url: URL, budget?: Budget): Promise<{ data: Uint8Array; type: string } | null | undefined> {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    try {
        const r = await get(url, budget);
        if (!r.ok) return r.status === 404 || r.status === 410 ? null : undefined;
        const type = r.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
        if (!r.body || !type.startsWith("image/")) return null;
        const data = await readAtMost(r.body, MAX_ICON);
        return data && data.length > 0 ? { data, type } : null;
    } catch (e) {
        if (e instanceof OutOfFetches) throw e;
        return undefined;
    }
}

// A body's bytes, or null once it's over `max` (reading no further).
async function readAtMost(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) data.set(c, (at += c.length) - c.length);
    return data;
}

// Text as HTMLRewriter gives it, with its character references still in.
function decode(s: string): string {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
        if (ref[0] !== "#") return named[ref.toLowerCase()] ?? m;
        const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}
