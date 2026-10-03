# Vigil

Small, cookie-based analytics for my own sites. A Cloudflare Worker + D1,
fed by a tracker that only counts a page view once the reader scrolls.

- **Schema and query recipes:** [`migrations/0001_init.sql`](migrations/0001_init.sql)
- **Collector:** `src/worker/collect.ts` (`POST /_v/hit`, `POST /_v/end`)
- **Tracker:** `src/tracker/v.js`, served at `/_v/v.js`
- **Dashboard:** `src/client/` (Solid), API goes in `src/worker/index.ts` under `/api/*`

## How it works

- The tracker sends a page view on the first scroll that follows real input
  (wheel, touch, key, pointer), so scroll restoration and anchor jumps don't count.
- When the page is hidden it sends a beacon with visible seconds and max scroll
  depth, which updates that hit.
- The Worker sets one HttpOnly cookie, `_v = visitorId.entryHitId.lastPage`,
  on the site's root domain, so all subdomains share a visitor.
- A hit with an external or empty referrer starts a new *trip*; internal clicks
  point back to the trip's first hit via `entry_hit_id`.
- Country comes from the browser's timezone. No IPs are read or stored.

## Adding a site (Netlify)

1. Proxy `/_v/*` to the Worker, in the site's `_redirects`:

   ```
   /_v/*  https://vigil.<your-subdomain>.workers.dev/_v/:splat  200!
   ```

2. Add the tracker to every page:

   ```html
   <script defer src="/_v/v.js"></script>
   ```

The proxy is what makes the cookie first-party; without it, visitor
tracking won't work.

## Development

```sh
pnpm install
pnpm db:migrate            # local D1
pnpm db:seed               # optional: 90 days of dummy traffic
printf 'VIGIL_DEV=1\nALLOWED_SITES=joodaloop.com,localhost\nCOOKIE_SECRET=%s\n' "$(openssl rand -base64 32)" > .dev.vars
pnpm dev
```

Open `http://localhost:5173/_v/test/a`, scroll, click between test pages, then
inspect the data:

```sh
pnpm wrangler d1 execute DB --local --command "SELECT * FROM hits"
```

## Configuration

- `ALLOWED_SITES` (in `wrangler.json` `vars`): comma-separated root domains to
  accept hits for, e.g. `joodaloop.com,example.org`. Subdomains are included.
  Hits for anything else get a 403.
- `COOKIE_SECRET` (a Wrangler secret): signs the visitor cookie, so edited or
  made-up cookies are ignored. Changing it makes every visitor look new once.

## Deploying

```sh
pnpm wrangler d1 create vigil          # once; put the database_id in wrangler.json
pnpm wrangler secret put COOKIE_SECRET # once; paste a long random string
pnpm run deploy                        # builds, applies migrations remotely, deploys
```
