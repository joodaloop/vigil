// Made-up stats for a demo build, answering the dashboard's API calls in the
// page (see api.ts) with responses shaped like the Worker's. Only meant to
// look right: each site gets a daily rhythm, slow growth and the odd spike
// from a link somewhere, and pages and sources share its views out along a
// long tail. Every number comes from a generator seeded by what it's for, so
// it's the same on every load, and a day's numbers are the same in every
// period that includes it. Filters scale the numbers by the picked row's
// share, with a little variation so the lists reorder; they don't add up
// between filters the way real ones do.

import type { HostStats, HostSummaries, Overview, PageRow, Referrer, Site } from "../shared/types";

const SITES: Site[] = [
  { host: "blog.example.com", name: "Example Blog" },
  { host: "docs.example.org", name: "Example Docs" },
  { host: "shop.example.net", name: "Example Shop" },
];

// Each site's views on an ordinary day, and its pages, with how much of the
// traffic each gets.
const LEVEL: Record<string, number> = {
  "blog.example.com": 420,
  "docs.example.org": 260,
  "shop.example.net": 90,
};
const PAGES: Record<string, string[]> = {
  "blog.example.com": [
    "/", "/posts/sqlite-is-enough/", "/posts/static-sites/", "/about/", "/posts/css-grid-notes/",
    "/posts/writing-a-tokenizer/", "/posts/on-caching/", "/now/", "/posts/rust-for-web-devs/",
    "/posts/keyboard-firmware/", "/posts/self-hosting/", "/posts/fonts/", "/archive/",
    "/posts/reading-list-2025/", "/posts/small-tools/", "/posts/time-zones/", "/posts/svg-icons/",
    "/posts/one-year-of-vim/", "/uses/", "/posts/dark-mode/", "/posts/http-caching/",
    "/posts/bash-tricks/", "/posts/notes-on-notes/", "/contact/",
  ],
  "docs.example.org": [
    "/", "/getting-started/", "/install/", "/guides/configuration/", "/api/", "/api/client/",
    "/guides/deploying/", "/faq/", "/changelog/", "/guides/auth/", "/api/errors/", "/guides/testing/",
    "/guides/migrating/", "/examples/", "/api/webhooks/", "/community/",
  ],
  "shop.example.net": [
    "/", "/products/notebook/", "/products/pen/", "/cart/", "/products/", "/about/", "/shipping/",
    "/products/stickers/", "/checkout/", "/faq/",
  ],
};
// Where views come from, each with how much of the traffic it sends. Pages
// on the site itself are added per site.
const SOURCES: [string, number][] = [
  ["google.com", 30], ["news.ycombinator.com", 8], ["duckduckgo.com", 6], ["reddit.com", 5],
  ["x.com", 4], ["bing.com", 4], ["github.com", 3], ["bsky.app", 2.5], ["lobste.rs", 2],
  ["linkedin.com", 1.5], ["chatgpt.com", 1.5], ["kagi.com", 1], ["mastodon.social", 1],
  ["perplexity.ai", 0.8], ["youtube.com", 0.6], ["ecosia.org", 0.5], ["substack.com", 0.5],
  ["claude.ai", 0.4], ["facebook.com", 0.4], ["brave.com", 0.3], ["someones-blog.net", 0.3],
  ["newsletter.example.io", 0.2], ["forum.example.dev", 0.2],
];
// The links behind spikes.
const SPIKERS = ["news.ycombinator.com", "reddit.com", "lobste.rs", "x.com", "bsky.app"];
const COUNTRIES: [string, number][] = [
  ["US", 30], ["DE", 9], ["GB", 8], ["IN", 7], ["CA", 5], ["FR", 4], ["NL", 3.5], ["AU", 3],
  ["JP", 2.5], ["BR", 2.5], ["SE", 2], ["PL", 2], ["ES", 1.8], ["IT", 1.6], ["CH", 1.2],
  ["NO", 1], ["FI", 0.9], ["DK", 0.8], ["SG", 0.8], ["KR", 0.7], ["MX", 0.7], ["AT", 0.6],
  ["BE", 0.6], ["IE", 0.5], ["NZ", 0.4], ["CZ", 0.4], ["PT", 0.4], ["AR", 0.3],
];

// A number in [0, 1) from a string: the same string, the same number.
function rand(...key: (string | number)[]) {
  let h = 2166136261;
  for (const c of key.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}
// About 1, between 1 - spread and 1 + spread.
const wobble = (spread: number, ...key: (string | number)[]) => 1 + (rand(...key) * 2 - 1) * spread;

const today = () => Math.floor(Date.now() / 1000 / 86400);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// Visitors' devices and systems, as shares.
const DEVICES = { desktop: 0.58, mobile: 0.38, tablet: 0.04 };
const SYSTEMS = { windows: 0.3, mac: 0.27, ios: 0.2, android: 0.17, linux: 0.06 };

// A site's views on a UTC day: busier on weekdays, growing over the year.
function siteViews(host: string, day: number) {
  const weekday = (day + 4) % 7; // 0 = Sunday
  const week = weekday === 0 || weekday === 6 ? 0.7 : 1.05;
  const growth = 1 + 0.4 * ((day - today()) / 365);
  return LEVEL[host] * week * growth * wobble(0.18, host, day);
}

// A site's spikes: a page linked from somewhere on a day, with how many
// extra views it got that day (fewer each day after).
type Spike = { day: number; page: string; source: string; size: number };
function spikes(host: string): Spike[] {
  const out: Spike[] = [];
  const pages = PAGES[host];
  for (let day = today() - 400; day <= today(); day++) {
    if (rand(host, "spike", day) > 0.04) continue;
    out.push({
      day,
      page: pages[1 + Math.floor(rand(host, "spike page", day) * (pages.length - 1))],
      source: SPIKERS[Math.floor(rand(host, "spike source", day) * SPIKERS.length)],
      size: LEVEL[host] * (1 + rand(host, "spike size", day) * 5),
    });
  }
  return out;
}
const spikeOn = (s: Spike, day: number) => (day < s.day ? 0 : s.size * Math.exp(-(day - s.day) / 1.3));

// Shares of 1 along a long tail, in the given order, each a little off.
function tail(names: string[], key: string) {
  const w = names.map((n, i) => wobble(0.3, key, n) / (i + 1.5) ** 1.1);
  return new Map(names.map((n, i) => [n, w[i] / sum(w)]));
}

// A row's daily views and new visitors, from a share of each day's views.
function row(host: string, name: string, share: number, daysList: number[], extra: (day: number) => number) {
  const daily = daysList.map((d) => Math.round(siteViews(host, d) * share * wobble(0.35, host, name, d) + extra(d)));
  const newRate = 0.35 + rand(host, name, "new") * 0.3;
  const dailyNew = daily.map((v, i) => Math.round(v * newRate * wobble(0.2, host, name, "new", daysList[i])));
  return { daily, dailyNew, views: sum(daily), new: sum(dailyNew) };
}

// A site's unfiltered stats over the `n` days to today, by UTC day number;
// worked out once each.
const made = new Map<string, { dayNums: number[]; stats: HostStats }>();
function unfiltered(host: string, n: number) {
  const k = `${host} ${n} ${today()}`;
  if (!made.has(k)) made.set(k, make(host, n));
  return made.get(k)!;
}
function make(host: string, n: number): { dayNums: number[]; stats: HostStats } {
  const dayNums = Array.from({ length: n }, (_, i) => today() - n + 1 + i);
  const its = spikes(host);
  const pageShares = tail(PAGES[host], host);
  const pages: PageRow[] = PAGES[host].map((path) => {
    const r = row(host, path, pageShares.get(path)!, dayNums, (d) =>
      its.filter((s) => s.page === path).reduce((x, s) => x + spikeOn(s, d), 0),
    );
    return { path, views: r.views, new: r.new, daily: r.daily, dailyNew: r.dailyNew };
  });
  // Direct visits, unlisted, take about a third; clicks within the site take
  // a little of the rest.
  const sources: [string, number][] = [
    ...SOURCES.map(([s, w]) => [s, w * wobble(0.5, host, s)] as [string, number]),
    ...PAGES[host].slice(0, 6).map((p, i) => [p, 4 / (i + 1)] as [string, number]),
  ];
  const total = sources.reduce((x, [, w]) => x + w, 0);
  const referrers: Referrer[] = sources.map(([source, w]) => {
    const r = row(host, source, (0.65 * w) / total, dayNums, (d) =>
      its.filter((s) => s.source === source).reduce((x, s) => x + spikeOn(s, d), 0),
    );
    return { source, views: r.views, new: r.new, daily: r.daily, dailyNew: r.dailyNew };
  });
  const views = dayNums.map((_, i) => pages.reduce((x, p) => x + p.daily[i], 0));
  const fresh = dayNums.map((_, i) => pages.reduce((x, p) => x + p.dailyNew[i], 0));
  const daily = {
    views,
    new: fresh,
    visitors: views.map((v, i) => Math.round((v / 1.7) * wobble(0.08, host, "visitors", dayNums[i]))),
    reads: views.map((v, i) => Math.round(v * 0.38 * wobble(0.12, host, "reads", dayNums[i]))),
  };
  // Some visitors come back on other days, so the period's are fewer than
  // the days' added up.
  const visitors = Math.round(sum(daily.visitors) * 0.82);
  const countryShares = tail(COUNTRIES.map(([c]) => c), host + "countries");
  const totals = {
    views: sum(views),
    reads: sum(daily.reads),
    visitors,
    new: sum(fresh),
    newBounced: Math.round(sum(fresh) * (0.5 + rand(host, "bounce") * 0.15)),
    devices: split(visitors, DEVICES, host),
    systems: { ...split(visitors * 0.97, SYSTEMS, host), known: Math.round(visitors * 0.97) },
    countries: COUNTRIES.map(([code]) => ({ code, visitors: Math.round(visitors * 0.92 * countryShares.get(code)!) }))
      .filter((c) => c.visitors > 0)
      .sort((a, b) => b.visitors - a.visitors),
  };
  // Ordered as the Worker orders them.
  pages.sort((a, b) => b.views - a.views);
  referrers.sort((a, b) => b.new - a.new || b.views - a.views);
  return {
    dayNums,
    stats: { totals, daily, pages: pages.filter((p) => p.views > 0), referrers: referrers.filter((r) => r.views > 0) },
  };
}

// `n` shared out by `shares`, each a little off.
function split<K extends string>(n: number, shares: Record<K, number>, key: string): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k in shares) out[k] = Math.round(n * shares[k] * wobble(0.15, key, k));
  return out;
}

// The stats under filters: the picked rows alone in their lists, and every
// other number scaled by the picks' shares, each row a little off so the
// lists reorder. (A picked row isn't: its numbers match the totals.)
type Filters = { page: string | null; source: string | null; country: string | null };
function filtered(host: string, n: number, f: Filters): HostStats {
  const { stats } = unfiltered(host, n);
  if (!f.page && !f.source && !f.country) return stats;
  const t = stats.totals;
  const page = stats.pages.find((p) => p.path === f.page);
  const source = stats.referrers.find((r) => r.source === f.source);
  const country = t.countries.find((c) => c.code === f.country);
  // Each pick's share of the views (of the visitors, for a country); none
  // for a pick that isn't in the period.
  const pageShare = f.page ? (page?.views ?? 0) / t.views : 1;
  const sourceShare = f.source ? (source?.views ?? 0) / t.views : 1;
  const countryShare = f.country ? (country?.visitors ?? 0) / t.visitors : 1;
  const all = pageShare * sourceShare * countryShare;
  const key = `${f.page} ${f.source} ${f.country}`;
  const off = (name: string, picked: boolean) => (picked ? 1 : wobble(0.6, host, key, name));
  const scaled = <T extends { daily: number[]; dailyNew: number[] }>(r: T, share: number, name: string, picked: boolean) => {
    const w = share * off(name, picked);
    return { ...r, daily: r.daily.map((v) => Math.round(v * w)), dailyNew: r.dailyNew.map((v) => Math.round(v * w)) };
  };

  // The chart follows the picked page's (or source's) days, scaled by the
  // other picks.
  const base = page?.daily ?? source?.daily ?? stats.daily.views;
  const chartShare = (page ? sourceShare : source ? 1 : pageShare * sourceShare) * countryShare * (all ? 1 : 0);
  const views = base.map((v) => Math.round(v * chartShare));
  const like = (a: number[]) => views.map((v, i) => Math.round(stats.daily.views[i] ? (v * a[i]) / stats.daily.views[i] : 0));
  const daily = { views, new: like(stats.daily.new), visitors: like(stats.daily.visitors), reads: like(stats.daily.reads) };

  const pages: PageRow[] = (page ? [page] : f.page ? [] : stats.pages)
    .map((p) => scaled(p, sourceShare * countryShare, p.path, !!page))
    .map((p) => ({ ...p, views: sum(p.daily), new: sum(p.dailyNew) }))
    .filter((p) => p.views > 0)
    .sort((a, b) => b.views - a.views);
  const referrers: Referrer[] = (source ? [source] : f.source ? [] : stats.referrers)
    .map((r) => scaled(r, pageShare * countryShare, r.source, !!source))
    .map((r) => ({ ...r, views: sum(r.daily), new: sum(r.dailyNew) }))
    .filter((r) => r.views > 0)
    .sort((a, b) => b.new - a.new || b.views - a.views);
  const visitors = Math.round(t.visitors * all);
  return {
    daily,
    pages,
    referrers,
    totals: {
      views: sum(daily.views),
      reads: sum(daily.reads),
      new: sum(daily.new),
      visitors,
      newBounced: Math.round(t.newBounced * all),
      devices: split(visitors, DEVICES, host + key),
      systems: { ...split(visitors * 0.97, SYSTEMS, host + key), known: Math.round(visitors * 0.97) },
      countries: (country ? [country] : f.country ? [] : t.countries)
        .map((c) => ({ code: c.code, visitors: Math.round(c.visitors * pageShare * sourceShare * off(c.code, !!country)) }))
        .filter((c) => c.visitors > 0)
        .sort((a, b) => b.visitors - a.visitors),
    },
  };
}

// A little delay, as over the network, so the dashboard's loading states show.
const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 120));

export function get(path: string, params: URLSearchParams): Promise<unknown> {
  const n = Math.min(366, Math.max(1, Number(params.get("days")) || 30));
  const days = (dayNums: number[]) => dayNums.map((d) => d * 86400);
  if (path === "/api/config") return later({ sites: SITES });
  if (path === "/api/hosts") {
    const result: HostSummaries = { days: [], hosts: {} };
    for (const { host } of SITES) {
      const { dayNums, stats } = unfiltered(host, n);
      result.days = days(dayNums);
      result.hosts[host] = { totals: { views: stats.totals.views, new: stats.totals.new }, daily: { views: stats.daily.views } };
    }
    return later(result);
  }
  if (path === "/api/overview") {
    const host = params.get("host") ?? "";
    if (!LEVEL[host]) return Promise.reject(new Error("404 Not Found"));
    const stats = filtered(host, n, {
      page: params.get("page"),
      source: params.get("source"),
      country: params.get("country"),
    });
    const result: Overview = { days: days(unfiltered(host, n).dayNums), stats };
    return later(result);
  }
  return Promise.reject(new Error("404 Not Found"));
}
