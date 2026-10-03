// Visitor state lives in one first-party cookie, set by the Worker through the
// site's /_v/* proxy so it's HttpOnly and not capped by Safari:
//
//   _v = visitorId.entryHitId.lastPage.signature   (~400 days)
//
// The ids are base36. entryHitId is the arrival hit of the current trip;
// lastPage is the strings.id of the last page recorded, used as `src` for
// cross-subdomain clicks where the browser strips the referrer to an origin.
//
// The signature is an HMAC-SHA256 of the ids, keyed with the COOKIE_SECRET
// secret, so a cookie that's been edited or made up is ignored.

const COOKIE = "_v";
const MAX_AGE = 400 * 24 * 60 * 60; // Chrome's cap

export type VisitorState = {
    visitorId: number;
    entryHitId: number;
    lastPage: number;
};

const encoder = new TextEncoder();
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
    if (cachedKey?.secret !== secret) {
        cachedKey = {
            secret,
            key: crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
                "sign",
                "verify",
            ]),
        };
    }
    return cachedKey.key;
}

function toBase64Url(bytes: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
    try {
        const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

function parseId(s: string | undefined): number | null {
    if (!s || !/^[0-9a-z]{1,11}$/.test(s)) return null;
    const n = parseInt(s, 36);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function readState(request: Request, secret: string): Promise<VisitorState | null> {
    const header = request.headers.get("cookie") ?? "";
    const match = header.match(/(?:^|;\s*)_v=([0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+)\.([A-Za-z0-9_-]+)/);
    if (!match) return null;

    const [, payload, sig] = match;
    const sigBytes = fromBase64Url(sig);
    // crypto.subtle.verify compares in constant time.
    if (!sigBytes || !(await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, encoder.encode(payload)))) {
        return null;
    }

    const [visitorId, entryHitId, lastPage] = payload.split(".").map(parseId);
    if (!visitorId || !entryHitId || !lastPage) return null;
    return { visitorId, entryHitId, lastPage };
}

export async function stateCookie(
    state: VisitorState,
    secret: string,
    domain: string | null,
    secure: boolean,
): Promise<string> {
    const payload = [state.visitorId, state.entryHitId, state.lastPage].map((n) => n.toString(36)).join(".");
    const sig = toBase64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
    return [
        `${COOKIE}=${payload}.${sig}`,
        `Max-Age=${MAX_AGE}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        domain ? `Domain=${domain}` : "",
        secure ? "Secure" : "",
    ]
        .filter(Boolean)
        .join("; ");
}
