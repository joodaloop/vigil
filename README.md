# vigil
*Privacy-discrespting analytics for small sites.*

I have long felt the need a free service that can tell me...
- ...if real people were (re-)visiting my sites
- ...if new people were finding my sites, and how
- ...if they're actually reading the pages

Vigil is a cookie-based analytics service (and pretty dashboard) that tries to answer those questions as best as possible with minimal fuss.

![Screenshot of demo dashboard](/screenshot.png)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joodaloop/vigil)

## How it works
- A cookie is used to give a device a stable identity so I can know if someone is revisiting. 
- The tracker sends a page view only when the user actually interacts with the site
  (wheel, touch, key, pointer).
- Once the page has been on screen for 30 seconds, the view also counts as
  *read*. Set the threshold per page with `data-read-after` on the script tag
  (in seconds).

## Adding a site

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

   On pages that pan or zoom without scrolling (e.g. a map using panzoom),
   add `data-count-on="input"` so the first real input (a drag, wheel, touch
   or key) counts the view rather than the first scroll.

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
  accepts and the dashboard shows.
- `database_id` in `wrangler.json` needs an ID returned by
  `wrangler d1 create`.
- `COOKIE_SECRET` (a Wrangler secret): signs the visitor cookie, so edited or
  made-up cookies are ignored.

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
