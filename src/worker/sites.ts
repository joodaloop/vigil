import type { Site } from "../shared/types";

// The configured sites, from the SITES var. Wrangler passes it as JSON, but a
// var set as text (e.g. in the Cloudflare dashboard) arrives as a string.
export function configuredSites(env: Env): Site[] {
    let sites: unknown = env.SITES;
    if (typeof sites === "string") {
        try {
            sites = JSON.parse(sites);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(sites)) return [];
    return sites
        .filter((s): s is Site => typeof s?.host === "string")
        .map((s) => ({ host: s.host.toLowerCase(), name: typeof s.name === "string" ? s.name : s.host }));
}
