# Vigil

Small, cookie-based analytics for your sites. A Cloudflare Worker + D1,
fed by a tracker that only counts a page view once the reader scrolls.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joodaloop/vigil)

- **Schema:** [`schema.sql`](schema.sql): raw `hits`, and the per-site counts the dashboard
  reads. It's applied on every deploy and only creates what's missing.
- **Collector:** `src/worker/collect.ts` (`POST /_v/hit`, `POST /_v/read`)
- **Tracker:** `src/tracker/v.js`, served at `/_v/v.js`
- **Dashboard:** `src/client/` (Solid), API goes in `src/worker/index.ts` under `/api/*`

## How it works

- The tracker sends a page view on the first scroll that follows real input
  (wheel, touch, key, pointer), so scroll restoration and anchor jumps don't count.
- Once the page has been on screen for 30 seconds, the view also counts as
  *read*. Set the threshold per page with `data-read-after` on the script tag
  (in seconds); reads are only comparable between pages with the same one.
- Each site (hostname) is counted on its own. The Worker sets one HttpOnly
  cookie per site holding the visitor's id, so a reader on two subdomains is
  two visitors.
- Each view records where it came from: the referring site, or for a click
  within the site, the previous page. Pick a page on the dashboard to see where
  its readers came from; pick one of your pages as a source to see where its
  readers went next.
- Each hit also adds to a few per-day counts, so the dashboard sums those
  rather than reading hits. Unique visitors can't be summed, so they're only
  shown without a page or referrer filter.
- Country comes from the browser's timezone. No IPs are read or stored.

## Adding a site (Netlify)

1. Edit `vars.SITES` in [`wrangler.json`](wrangler.json). Replace the local
   example with each hostname you want counted, and the name to show for it:

   ```json
   "vars": {
       "SITES": [
           { "host": "example.co.uk", "name": "Example" },
           { "host": "blog.example.co.uk", "name": "Blog" }
       ]
   }
   ```

   Only listed hostnames are collected; each gets its own panel.

2. Proxy `/_v/*` to the Worker, in the site's `_redirects`:

   ```
   /_v/*  https://vigil.<your-subdomain>.workers.dev/_v/:splat  200!
   ```

3. Add the tracker to every page:

   ```html
   <script defer src="/_v/v.js"></script>
   ```

   Add `data-read-after="60"` to change how many seconds on screen count as a
   read (default 30), e.g. longer on long essays.

The proxy is what makes the cookie first-party; without it, visitor
tracking won't work.

## Development

```sh
pnpm install
pnpm db:init               # local D1
printf 'VIGIL_DEV=1\nCOOKIE_SECRET=%s\n' "$(openssl rand -base64 32)" > .dev.vars
pnpm dev
```

Open `http://localhost:5173/_v/test/a`, scroll, click between test pages, then
inspect the data:

```sh
pnpm wrangler d1 execute DB --local --command "SELECT * FROM hits"
```

## Configuration

- `vars.SITES` in [`wrangler.json`](wrangler.json) lists the sites the collector
  accepts and the dashboard shows. The Worker serves its display data at
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
pnpm run deploy                        # builds, applies schema.sql remotely, deploys
```

### Deploying from a clone

To keep your own `database_id` and `SITES` out of `wrangler.json` (so pulling
updates doesn't conflict), copy it to `wrangler.prod.json`, which is
gitignored, put your values there, and deploy with:

```sh
pnpm run deploy:prod
```

Search: DuckDuckGo, Brave Search, Ecosia
- Communities and newsletters: Lobsters
- AI tools: Perplexity, Claude
