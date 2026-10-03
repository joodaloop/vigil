# Vigil

Small, cookie-based analytics for your sites. A Cloudflare Worker + D1,
fed by a tracker that only counts a page view once the reader scrolls.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joodaloop/vigil)

- **Schema and query recipes:** [`migrations/0001_init.sql`](migrations/0001_init.sql), plus the
  dashboard's per-host counters in [`migrations/0002_counters.sql`](migrations/0002_counters.sql)
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

1. Edit `vars.SITES` in [`wrangler.json`](wrangler.json). Replace the local
   example with your site root and the hosts you want on the dashboard:

   ```json
   "vars": {
       "SITES": [
           {
               "site": "example.co.uk",
               "hosts": [
                   { "host": "example.co.uk", "name": "Example" },
                   { "host": "blog.example.co.uk", "name": "Blog" }
               ]
           }
       ]
   }
   ```

   Each host gets its own panel on the dashboard, and only listed hosts are
   collected. The `site` is the cookie domain its hosts share, so a reader
   keeps one identity (and one trip) across them; every host must be the site
   itself or one of its subdomains. Add another entry for each separate domain.

2. Proxy `/_v/*` to the Worker, in the site's `_redirects`:

   ```
   /_v/*  https://vigil.<your-subdomain>.workers.dev/_v/:splat  200!
   ```

3. Add the tracker to every page:

   ```html
   <script defer src="/_v/v.js"></script>
   ```

The proxy is what makes the cookie first-party; without it, visitor
tracking won't work.

## Development

```sh
pnpm install
pnpm db:migrate            # local D1
printf 'VIGIL_DEV=1\nCOOKIE_SECRET=%s\n' "$(openssl rand -base64 32)" > .dev.vars
pnpm dev
```

Open `http://localhost:5173/_v/test/a`, scroll, click between test pages, then
inspect the data:

```sh
pnpm wrangler d1 execute DB --local --command "SELECT * FROM hits"
```

## Configuration

- `vars.SITES` in [`wrangler.json`](wrangler.json) is the single site configuration
  used by the collector and dashboard. The Worker serves its display data at
  `/api/config`. Its default `localhost` entry supports local testing. Keep it
  while testing locally, then replace or remove it before deploying.
- `database_id` in `wrangler.json` starts as an all-zero placeholder. The deploy
  button fills it in; when deploying by hand, replace it with the ID returned by
  `wrangler d1 create`.
- `COOKIE_SECRET` (a Wrangler secret): signs the visitor cookie, so edited or
  made-up cookies are ignored. Changing it makes every visitor look new once.

## Deploying

The quickest route is the **Deploy to Cloudflare** button above. It copies
this repo to your GitHub or GitLab account, creates the D1 database, asks for
`COOKIE_SECRET`, and deploys. After that, edit `vars.SITES` in your copy's
`wrangler.json` (see [Adding a site](#adding-a-site-netlify)) and push; each
push redeploys. Until you do, the Worker only accepts hits from `localhost`.

To deploy by hand instead:

```sh
pnpm wrangler d1 create vigil          # once; copy its database_id into wrangler.json
pnpm wrangler secret put COOKIE_SECRET # once; paste a long random string
pnpm run deploy                        # builds, applies migrations remotely, deploys
```

### Deploying from a clone

To keep your own `database_id` and `SITES` out of `wrangler.json` (so pulling
updates doesn't conflict), copy it to `wrangler.prod.json`, which is
gitignored, put your values there, and deploy with:

```sh
pnpm run deploy:prod
```
