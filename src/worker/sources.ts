// What's read from pages, after hits that claim it (schema.sql): pages'
// titles (`pages`), from the pages themselves; sites' favicons (`sources`),
// from any of their pages; and for referring sites that aren't well-known
// ones, their names and favicons, from their home pages. And the icons,
// served from there.

// A favicon this size or under is kept; a larger one, the dashboard gets
// from DuckDuckGo instead.
const MAX_ICON = 30 * 1024;

// Metadata is usually near the start, but a head can contain large scripts
// or styles. Stop after this much HTML even if its closing tag never comes.
const MAX_HTML = 128 * 1024;

// How long a lookup lasts before the next hit looks again.
const REFRESH = 30 * 86400;

// Run in a hit's batch, with ?1 = the site's domain, or a referring one's.
// Returns a row when this hit claims the domain's lookup: the domain's first
// hit, or its first 30 days after the last claim. Every other hit writes
// nothing.
export const CLAIM_SOURCE = `INSERT INTO sources (domain, claimed_ts) VALUES (?1, unixepoch())
    ON CONFLICT (domain) DO UPDATE SET claimed_ts = unixepoch() WHERE claimed_ts < unixepoch() - ${REFRESH}
    RETURNING 1`;

// Run in a hit's batch, with ?1 = the site's domain and ?2 = the page's
// path. Returns a row when this hit claims the page's lookup, as for
// CLAIM_SOURCE: the page's first hit, or its first 30 days after the last.
export const CLAIM_PAGE = `INSERT INTO pages (host, path, claimed_ts) VALUES (?1, ?2, unixepoch())
    ON CONFLICT (host, path) DO UPDATE SET claimed_ts = unixepoch() WHERE claimed_ts < unixepoch() - ${REFRESH}
    RETURNING 1`;

// Fetches a referring site's home page and keeps its name and favicon. A
// page that can't be fetched (or read in full) leaves the row as it was,
// until the next claim.
export async function lookUpSource(env: Env, domain: string): Promise<void> {
    const head = await readHead(`https://${domain}/`);
    if (!head) return;
    const name = nameFrom(head.siteName, head.title);
    await saveSource(env, domain, name, await favicon(new URL(head.iconHref ?? "/favicon.ico", head.url)));
}

// Fetches a page of a site (a hit's, claimed) and keeps its title, and with
// `withIcon` (the site's own lookup claimed too), the site's favicon: any of
// its pages links it. Its name is only an og:site_name, as a page's title
// isn't the site's (the dashboard shows the configured one anyway).
export async function lookUpPage(env: Env, host: string, path: string, withIcon: boolean): Promise<void> {
    // Joined, not resolved, so a path like "//elsewhere/x" stays on the site.
    const head = await readHead(`https://${host}${path}`);
    if (!head) return;
    // The first of them with any text (a blank og:title doesn't hide a title).
    const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
    const title = clean(head.pageTitle) || clean(head.title) || null;
    await env.DB.prepare(`UPDATE pages SET title = ?3 WHERE host = ?1 AND path = ?2`).bind(host, path, title).run();
    if (withIcon) {
        const name = head.siteName.replace(/\s+/g, " ").trim().slice(0, 100) || null;
        await saveSource(env, host, name, await favicon(new URL(head.iconHref ?? "/favicon.ico", head.url)));
    }
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
async function readHead(url: string | URL) {
    let page: Response;
    try {
        page = await get(url);
    } catch {
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

function get(url: string | URL) {
    return fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Vigil; +https://github.com/joodaloop/vigil)" },
        signal: AbortSignal.timeout(5000),
    });
}

// A site's name: its og:site_name, or the first part of its title ("Some
// Blog" from "Some Blog | Writing about things"); null for neither.
function nameFrom(siteName: string, title: string): string | null {
    const name = siteName.trim() || title.trim().split(/\s+[|–—·•:-]\s+/)[0].trim();
    return name.replace(/\s+/g, " ").slice(0, 100) || null;
}

// The icon at `url`, if it's an image of at most MAX_ICON bytes; null when
// missing or unusable, undefined when a failed request leaves it unknown.
async function favicon(url: URL): Promise<{ data: Uint8Array; type: string } | null | undefined> {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    try {
        const r = await get(url);
        if (!r.ok) return r.status === 404 || r.status === 410 ? null : undefined;
        const type = r.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
        if (!r.body || !type.startsWith("image/")) return null;
        const data = await readAtMost(r.body, MAX_ICON);
        return data && data.length > 0 ? { data, type } : null;
    } catch {
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
