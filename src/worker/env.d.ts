interface Env {
    DB: D1Database;
    // The sites to collect and show; read it with configuredSites().
    SITES: import("../shared/types").Site[] | string;
    // Secret for signing the visitor cookie. `wrangler secret put COOKIE_SECRET`.
    COOKIE_SECRET: string;
    VIGIL_DEV?: string;
}
