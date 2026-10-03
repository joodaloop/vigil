interface Env {
    DB: D1Database;
    SITES: import("../shared/types").SiteConfig[];
    // Secret for signing the visitor cookie. `wrangler secret put COOKIE_SECRET`.
    COOKIE_SECRET: string;
    VIGIL_DEV?: string;
}
