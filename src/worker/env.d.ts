interface Env {
    DB: D1Database;
    // Comma-separated sites (cookie domains) to accept hits for.
    ALLOWED_SITES: string;
    // Secret for signing the visitor cookie. `wrangler secret put COOKIE_SECRET`.
    COOKIE_SECRET: string;
    VIGIL_DEV?: string;
}
