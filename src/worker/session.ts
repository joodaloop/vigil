// Visitor state lives in one first-party cookie, set by the Worker through the
// site's /_v/* proxy so it's HttpOnly and not capped by Safari:
//
//   vigil = visitorId.signature   (~400 days, this host only)
//
// The id is base36. The signature is an HMAC-SHA256 of it, keyed with the
// COOKIE_SECRET secret, so a cookie that's been edited or made up is ignored.

const COOKIE = "vigil";
const MAX_AGE = 400 * 24 * 60 * 60; // Chrome's cap


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

// The visitor id from the request's cookie, or null for a new visitor (or
// one whose cookie has been edited or made up).
export async function readVisitor(request: Request, secret: string): Promise<number | null> {
    const match = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)vigil=([0-9a-z]+)\.([A-Za-z0-9_-]+)/);
    if (!match) return null;

    const [, payload, signature] = match;
    const sig = fromBase64Url(signature);
    // crypto.subtle.verify compares in constant time.
    if (!sig || !(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(payload)))) {
        return null;
    }
    return parseId(payload);
}

// A random id for a new visitor: no database round trip, and with up to 2^53
// of them, no realistic chance of two colliding on a host.
export function newVisitorId(): number {
    const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
    return (hi & 0x1fffff) * 2 ** 32 + lo || 1;
}

export async function visitorCookie(visitorId: number, secret: string, secure: boolean): Promise<string> {
    const payload = visitorId.toString(36);
    const sig = toBase64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
    return [`${COOKIE}=${payload}.${sig}`, `Max-Age=${MAX_AGE}`, "Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : ""]
        .filter(Boolean)
        .join("; ");
}
