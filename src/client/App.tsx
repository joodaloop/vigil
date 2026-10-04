import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import type { HostStats, HostSummaries, Overview, Site } from "../shared/types";
import { Chart } from "./Chart";
import { DEFAULT_PERIOD, PERIODS } from "./config";
import { ICONS } from "./icons";
import { referrerIcon, referrerName } from "../shared/referrers";
import { theme } from "./theme";

// What's shown, and fetched; kept in the address.
type Query = {
  host: string;
  days: number;
} & Filters;

// Each filter's pick, or null for none.
type Filters = {
  country: string | null; // an ISO code
  page: string | null; // a path
  source: string | null; // a referring site's domain, or a page's path
};

function initialQuery(hosts: Site[]): Query {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get("days"));
  const host = params.get("host");
  return {
    host: hosts.some((h) => h.host === host) ? host! : hosts[0].host,
    days: PERIODS.includes(n) ? n : DEFAULT_PERIOD,
    country: params.get("country") || null,
    page: params.get("page") || null,
    source: params.get("source") || null,
  };
}

// The query as the address's and the API's parameters, leaving out filters
// that aren't set.
function toParams(q: Query) {
  const params = new URLSearchParams({ host: q.host, days: String(q.days) });
  for (const k of ["country", "page", "source"] as const) if (q[k] !== null) params.set(k, q[k]);
  return params;
}

async function get<T>(path: string, params: URLSearchParams | Record<string, string>): Promise<T> {
  const r = await fetch(`${path}?${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// 950 -> "950", 4321 -> "4.3k", 17694 -> "17.7k", 123456 -> "123k", 1250000 -> "1.3M":
// one decimal at most, and none once there are three digits.
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
  maximumSignificantDigits: 3,
  roundingPriority: "lessPrecision",
});
const num = (n: number) => compact.format(n).replace("K", "k");
// 2.43 -> "2.4", 3 -> "3".
const perDevice = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
// A list row's share of its list, for the bar behind it; none under 0.25%.
const share = (part: number, whole: number) =>
  whole > 0 && part / whole >= 0.005 ? part / whole : 0;

export function App(props: { sites: Site[] }) {
  // Every site, in display order.
  const HOSTS = props.sites;
  const [query, setQuery] = createSignal(initialQuery(HOSTS));
  // The open host's unfiltered overview, fetched once per host and period:
  // it's what's shown without filters, and its lists are the filters'
  // options.
  const period = createMemo(() => `${query().host} ${query().days}`);
  const unfiltered = createMemo(() => {
    const [host, days] = period().split(" ");
    return get<Overview>("/api/overview", { host, days });
  });
  // The open host's stats (and its unfiltered ones), along with the query
  // they answer. While a new query loads, this (and everything drawn from
  // it) keeps showing the last one, so the panel's name, numbers and chart
  // all switch together.
  const view = createMemo(async () => {
    const q = query();
    const all = unfiltered();
    const filtered = q.country !== null || q.page !== null || q.source !== null;
    return { q, all, overview: filtered ? await get<Overview>("/api/overview", toParams(q)) : all };
  });
  // Headline numbers for every host, for the sidebar. Only refetched when the
  // period changes.
  const days = createMemo(() => query().days);
  const summaries = createMemo(() => get<HostSummaries>("/api/hosts", { days: String(days()) }));
  // The sidebar's hosts, most views in the period first (ties keep site order).
  const byViews = createMemo(() => {
    const hosts = summaries().hosts;
    const views = (h: Site) => hosts[h.host]?.totals.views ?? 0;
    return [...HOSTS].sort((a, b) => views(b) - views(a));
  });
  // A new query is on its way: the panel fades a little until it lands.
  const updating = () => isPending(() => view());

  // From the query as last set, which a read of `query()` doesn't give until
  // the next flush, so two changes in a row both count.
  function update(change: Partial<Query>) {
    setQuery((q) => {
      const next = { ...q, ...change };
      history.replaceState(null, "", `?${toParams(next)}`);
      return next;
    });
  }

  // Nothing is shown until both the sidebar and the panel have their first
  // numbers, so they arrive together.
  return (
    <Loading>
      <main>
        <nav class="sidebar">
          <div class="sidebar-top">
            <p> Useful, minimal, & privacy-unfriendly analytics. </p>
            <div class="days-picker">
              <div class="days-num" aria-hidden="true">
                {latest(() => query().days)}
              </div>
              <div class="days-label" aria-hidden="true">
                days
              </div>
              <select
                id="period"
                aria-label="Time period"
                value={latest(() => query().days)}
                onChange={(e) => update({ days: Number(e.currentTarget.value) })}
              >
                <For each={PERIODS}>{(n) => <option value={n}>{n} days</option>}</For>
              </select>
            </div>
          </div>

          {/* One entry per host; the open one is shown in full on the right. */}
          <Errored fallback={<p class="muted">Couldn't load hosts</p>}>
            <For each={byViews()}>
              {(h) => {
                const s = () => summaries().hosts[h.host];
                // Marked as soon as it's picked, ahead of its stats.
                const open = () => latest(() => query().host) === h.host;
                // Nothing in the period.
                const empty = () => !s()?.totals.views;
                return (
                  <button
                    class="host-item"
                    aria-pressed={open() ? "true" : "false"}
                    title={h.host}
                    disabled={empty()}
                    onClick={() => open() || update({ host: h.host })}
                  >
                    <span class="host-name">{h.name}</span>
                    <Show when={!empty()} fallback={<span class="muted">No stats yet</span>}>
                      <span class="host-nums">
                        <span class="host-counts">
                          <span style={{ color: theme.stats.views }}>
                            {num(s()?.totals.views ?? 0)}
                          </span>
                          <span style={{ color: theme.stats.new }}>
                            {num(s()?.totals.new ?? 0)}
                          </span>
                        </span>
                        <Chart
                          days={summaries().days}
                          lines={[
                            {
                              values: s()?.daily.views ?? [],
                              color: theme.stats.views,
                              scale: "count",
                            },
                          ]}
                          height={20}
                          lineWidth={1.5}
                        />
                      </span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </Errored>
        </nav>

        <section class={["panel", { updating: updating() }]}>
          <Errored
            fallback={(e) => (
              <p class="muted error">
                Couldn't load stats: {String((e() as Error)?.message ?? e())}
              </p>
            )}
          >
            <Stats
              name={HOSTS.find((h) => h.host === view().q.host)!.name}
              host={view().q.host}
              stats={view().overview.stats}
              options={view().all.stats}
              days={view().overview.days}
              // The picks show at once, ahead of their stats.
              filters={{
                country: latest(() => query().country),
                page: latest(() => query().page),
                source: latest(() => query().source),
              }}
              onFilter={update}
            />
          </Errored>
        </section>
      </main>
    </Loading>
  );
}

// Totals and chart above, then pages and referrers side by side.
function Stats(props: {
  name: string;
  host: string;
  stats: HostStats;
  options: HostStats; // unfiltered, for the filters' options
  days: number[];
  filters: Filters;
  onFilter: (change: Partial<Filters>) => void;
}) {
  const t = () => props.stats.totals;
  // The day hovered on the chart, and the stats as of it, which the totals
  // and lists show.
  const [day, setDay] = createSignal<number | null>(null);
  const shown = createMemo(() => onDay(props.stats, day()));
  const st = () => shown().totals;
  // What's in the filtered view, which each menu lists first; null without
  // filters, when that's everything.
  const within = <T,>(items: T[], key: (item: T) => string) =>
    props.stats === props.options ? null : new Set(items.map(key));

  return (
    <div class="stats">
      <div class="stats-main">
        {/* Name and address on the left, totals on the right. */}
        <div class="stats-head">
          <div class="host-title">
            <h1>{props.name}</h1>
            <span class="host-url">
              {day() === null ? props.host : fullDate.format(props.days[day()!] * 1000)}
            </span>
            {/* Filters by country, page and referrer, in any combination. */}
            <div class="filters">
              <FilterSelect
                label="Country"
                all="All countries"
                value={props.filters.country}
                onChange={(country) => props.onFilter({ country })}
                others="Other countries"
                options={props.options.totals.countries.map((c) => ({
                  value: c.code,
                  text: countryName.of(c.code) ?? c.code,
                }))}
                within={within(t().countries, (c) => c.code)}
                // A crossed-out flag shape, or once one's picked, its flag.
                show={(code) =>
                  code && flag(code) ? (
                    <img class="filter-flag" src={flag(code)} alt="" />
                  ) : (
                    <span class="filter-flag" />
                  )
                }
              />
              <FilterSelect
                label="Page"
                all="All pages"
                value={props.filters.page}
                onChange={(page) => props.onFilter({ page })}
                others="Other pages"
                options={props.options.pages.map((p) => ({ value: p.path, text: unslashed(p.path) }))}
                within={within(props.stats.pages, (p) => p.path)}
                // In the list's monospace.
                show={(path) => (path ? <span class="path">{path}</span> : "All pages")}
              />
              <FilterSelect
                label="Referrer"
                all="All referrers"
                value={props.filters.source}
                onChange={(source) => props.onFilter({ source })}
                others="Other referrers"
                options={props.options.referrers.map((r) => ({
                  value: r.source,
                  text: referrerName(r.source),
                }))}
                within={within(props.stats.referrers, (r) => r.source)}
                // Its icon then its name, as in the list.
                show={(source) =>
                  source ? (
                    <span class="ref-name">
                      <SourceIcon name={referrerIcon(source)} />
                      {referrerName(source)}
                    </span>
                  ) : (
                    "All referrers"
                  )
                }
              />
            </div>
          </div>
          {/* While a day is hovered: its numbers. */}
          <div class="totals">
            <div class="total" style={{ color: theme.stats.views }}>
              <div class="big">{num(st().views)}</div>
              <div class="big-label">Page views</div>
              {/* Read: visible for long enough (30s unless the tracker's
                  data-read-after says otherwise). */}
              <div class="sub">
                <span class="count" title="Engaged: views that stayed on screen long enough">
                  <span class="off-hover">{num(st().reads)} engaged</span>
                  <span class="on-hover">{pct(st().reads, st().views)}% engaged</span>
                </span>
              </div>
            </div>
            <div class="total" style={{ color: theme.stats.new }}>
              <div class="big">{num(st().new)}</div>
              <div class="big-label">New devices</div>
              {/* Only known for the whole period, so hidden while a day is
                  hovered (hidden rather than removed, so the totals keep
                  their height). */}
              <div class="sub" style={{ visibility: day() === null ? undefined : "hidden" }}>
                <span
                  class="count"
                  title={`Bounced: ${num(t().newBounced)} devices that opened one page and never came back`}
                >
                  <span class="off-hover">{num(t().newBounced)} bounced</span>
                  <span class="on-hover">{pct(t().newBounced, t().new)}% bounced</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <Chart
          days={props.days}
          lines={[
            { values: props.stats.daily.views, color: theme.stats.views, scale: "count" },
            {
              values: props.stats.daily.reads,
              color: theme.stats.views,
              scale: "count",
              dash: [9, 4],
            },
            { values: props.stats.daily.new, color: theme.stats.new, scale: "count" },
          ]}
          height={160}
          headroom={8}
          lineWidth={2}
          onHover={setDay}
        />
      </div>

      <div class="lists">
        {/* Pages by views. */}
        <List
          class="pages"
          items={shown().pages}
          key={(p) => p.path}
          views={(p) => p.views}
          days={props.days}
          label={(p) => (
            // "/posts/x/" shows as "posts/x"; the home page stays "/".
            <a
              class="label path"
              href={`https://${props.host}${p.path}`}
              target="_blank"
              rel="noopener noreferrer"
              title={p.path}
            >
              {p.path.replace(/^\/+|\/+$/g, "") || "/"}
            </a>
          )}
        />
        {/* Referrers by new visitors, then views. */}
        <List
          class="referrers"
          byNew
          items={shown().referrers}
          key={(r) => r.source}
          views={(r) => r.visits}
          days={props.days}
          label={(r) => (
            <a
              class="ref-name"
              href={sourceUrl(r.source, props.host)}
              target="_blank"
              rel="noopener noreferrer"
              title={r.source}
            >
              <SourceIcon name={referrerIcon(r.source)} />
              <span class="label">{referrerName(r.source)}</span>
            </a>
          )}
        />
      </div>

      <People stats={props.stats} days={props.days} />
    </div>
  );
}

// A path without its leading slash, so the page menu's typing jumps by its
// first letter; the home page stays "/".
const unslashed = (path: string) => path.replace(/^\/+/, "") || "/";

// A filter's menu: the picked option's text (or what `show` draws for its
// value, "" for none), with the select invisible over it (as in the days
// picker). Options in the filtered view (`within`) come first, then the rest
// after a blank line and a disabled `others` heading, each alphabetically. A
// pick missing from `options` (not in the period's) is still listed, so it
// can be seen and cleared.
function FilterSelect(props: {
  label: string;
  all: string; // the option for no filter
  others: string;
  options: { value: string; text: string }[];
  within: Set<string> | null; // null: no filters, so everything is
  value: string | null;
  onChange: (value: string | null) => void;
  show?: (value: string) => JSX.Element;
}) {
  const options = () =>
    (props.value === null || props.options.some((o) => o.value === props.value)
      ? [...props.options]
      : [{ value: props.value, text: props.value }, ...props.options]
    ).sort((a, b) => a.text.localeCompare(b.text));
  const isWithin = (o: { value: string }) =>
    !props.within || props.within.has(o.value) || o.value === props.value;
  const first = () => options().filter(isWithin);
  const rest = () => options().filter((o) => !isWithin(o));
  const text = () => options().find((o) => o.value === props.value)?.text ?? props.all;
  // Each option says whether it's picked: the select's own value would be
  // set before its options are there, and fall back to the first.
  const option = (o: { value: string; text: string }) => (
    <option value={o.value} selected={o.value === props.value}>
      {o.text}
    </option>
  );
  return (
    <span class="filter-select">
      <span aria-hidden="true">{props.show ? props.show(props.value ?? "") : text()}</span>
      <select
        aria-label={props.label}
        onChange={(e) => props.onChange(e.currentTarget.value || null)}
      >
        <option value="" selected={props.value === null}>
          {props.all}
        </option>
        <For each={first()}>{option}</For>
        <Show when={rest().length > 0}>
          {/* A blank line, then the heading. */}
          <option disabled />
          <option disabled>{props.others}</option>
          <For each={rest()}>{option}</For>
        </Show>
      </select>
    </span>
  );
}

// "September 19, 2026"; days are UTC.
const fullDate = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

// The stats as of a day hovered on the main chart (`day`), or the period's:
// the totals and every row's numbers that day, the rows ranked by them as
// they are for the period (ties keep the period's order). What's only known
// for the whole period stays as it is.
function onDay(stats: HostStats, day: number | null): HostStats {
  if (day === null) return stats;
  const { daily } = stats;
  return {
    ...stats,
    totals: {
      ...stats.totals,
      views: daily.views[day],
      reads: daily.reads[day],
      new: daily.new[day],
    },
    pages: stats.pages
      .map((p) => ({ ...p, views: p.daily[day], new: p.dailyNew[day] }))
      .sort((a, b) => b.views - a.views),
    referrers: stats.referrers
      .map((r) => ({ ...r, visits: r.daily[day], new: r.dailyNew[day] }))
      .sort((a, b) => b.new - a.new || b.visits - a.visits),
  };
}

// Pages or referrers, as they come: each row its label (`label`), a
// sparkline of its daily views, its views and its new visitors, over a bar
// as long as its share of the list's views, or with `byNew`, of its new
// visitors.
function List<T extends { new: number; daily: number[] }>(props: {
  class: string;
  items: T[];
  key: (item: T) => string;
  views: (item: T) => number;
  byNew?: boolean;
  label: (item: T) => JSX.Element;
  days: number[];
}) {
  const viewsTotal = () => props.items.reduce((n, x) => n + props.views(x), 0);
  const newTotal = () => props.items.reduce((n, x) => n + x.new, 0);
  // One scale for every sparkline (across all pages of the list), so their
  // heights compare.
  const max = () => {
    let max = 0;
    for (const x of props.items) for (const v of x.daily) if (v > max) max = v;
    return { count: max };
  };
  return (
    <div class={props.class}>
      <Paged items={props.items} key={props.key}>
        {(x) => (
          <div
            class={["row", { "by-new": props.byNew }]}
            style={{
              "--share": props.byNew
                ? share(x().new, newTotal())
                : share(props.views(x()), viewsTotal()),
            }}
          >
            {props.label(x())}
            <span class="spark" aria-hidden="true">
              <Chart
                days={props.days}
                lines={[{ values: x().daily, color: theme.stats.views, scale: "count" }]}
                maxes={max()}
                height={22}
                lineWidth={1.25}
              />
            </span>
            <span class="num" style={{ color: theme.stats.views }}>
              <Count n={props.views(x())} total={viewsTotal()} />
            </span>
            <span class="num" style={{ color: theme.stats.new }}>
              <Count n={x().new} total={newTotal()} blankZero />
            </span>
          </div>
        )}
      </Paged>
    </div>
  );
}

// A source's address: a page on the site itself, or the referring site's
// home page.
const sourceUrl = (source: string, host: string) =>
  source.startsWith("/") ? `https://${host}${source}` : `https://${source}`;

// Shows `items` 10 at a time, with a row of page dots when there are more.
// The list keeps a full page's height, dots included, however few items
// there are. Rows are matched by `key`, so one stays the same element as its
// data changes. Whenever the rows come in another order (a day hovered,
// another site or period), it's back to the first page.
// The page buttons are one tab stop, the current page's: arrow keys, Home
// and End move between pages from there.
function Paged<T>(props: {
  items: T[];
  size?: number;
  key: (item: T) => string;
  children: (item: () => T) => JSX.Element;
}) {
  const size = () => props.size ?? 10;
  const pages = () => Math.max(1, Math.ceil(props.items.length / size()));
  const order = createMemo(() => props.items.map(props.key).join("\n"));
  // The page picked, and for which order of the rows.
  const [picked, setPicked] = createSignal({ order: "", page: 0 });
  const current = () => (picked().order === order() ? picked().page : 0);
  const setPage = (page: number) => setPicked({ order: order(), page });
  const start = () => current() * size();
  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
    const to = {
      ArrowLeft: current() - 1,
      ArrowUp: current() - 1,
      ArrowRight: current() + 1,
      ArrowDown: current() + 1,
      Home: 0,
      End: pages() - 1,
    }[e.key];
    if (to === undefined) return;
    e.preventDefault(); // or the arrows would scroll the page
    const next = Math.max(0, Math.min(to, pages() - 1));
    setPage(next);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <>
      <div class="paged" style={{ "--rows": size() }}>
        <For each={props.items.slice(start(), start() + size())} keyed={props.key}>
          {(item) => props.children(item)}
        </For>
      </div>
      <div class="pager" onKeyDown={onKeyDown}>
        <Show when={pages() > 1}>
          <For each={Array.from({ length: pages() }, (_, i) => i)}>
            {(i) => (
              <button
                class={{ current: i === current() }}
                aria-label={`Page ${i + 1} of ${pages()}`}
                aria-current={i === current() ? "page" : undefined}
                tabindex={i === current() ? 0 : -1}
                onClick={() => setPage(i)}
              />
            )}
          </For>
        </Show>
      </div>
    </>
  );
}

// A list's number, with its share of the list's total in the same place,
// shown instead while the list is hovered. `blankZero` leaves both empty
// for none.
function Count(props: { n: number; total: number; blankZero?: boolean }) {
  return (
    <Show when={!props.blankZero || props.n > 0}>
      <span class="count">
        <span class="off-hover">{num(props.n)}</span>
        <span class="on-hover">{pct(props.n, props.total)}%</span>
      </span>
    </Show>
  );
}

// Visitors: their number and devices on one side and the countries they came
// from on the other, then their chart across the panel. Nothing here responds
// to hovering, on either chart.
function People(props: { stats: HostStats; days: number[] }) {
  const t = () => props.stats.totals;
  const devices = () => t().devices;

  return (
    <div class="people">
      <div class="people-head">
        <div class="totals">
          <div class="beside">
            <div class="total" style={{ color: theme.stats.visitors }}>
              <div class="big">{num(t().visitors)}</div>
              <div class="big-label">Devices</div>
              <div class="sub">
                <span title="Page views per device">
                  {perDevice.format(t().visitors > 0 ? t().views / t().visitors : 0)} pages
                </span>
              </div>
            </div>
            {/* Each column most common first. */}
            <div class="sub stacked icons devices">
              <For each={[...DEVICES].sort((a, b) => devices()[b.key] - devices()[a.key])}>
                {(d) => (
                  <span title={`${d.name}: ${pct(devices()[d.key], t().visitors)}%`}>
                    <DeviceIcon w={d.w} h={d.h} />
                    <Share part={devices()[d.key]} whole={t().visitors} />
                  </span>
                )}
              </For>
            </div>
            {/* Shares of the visitors whose OS is known. */}
            <div class="sub stacked icons systems">
              <For each={[...SYSTEMS].sort((a, b) => t().systems[b[0]] - t().systems[a[0]])}>
                {([key, name]) => (
                  <span title={`${name}: ${pct(t().systems[key], t().systems.known)}%`}>
                    <OsIcon name={key} />
                    <Share part={t().systems[key]} whole={t().systems.known} />
                  </span>
                )}
              </For>
            </div>
          </div>
        </div>
        <Countries items={t().countries} />
      </div>
      <Chart
        days={props.days}
        lines={[
          { values: props.stats.daily.visitors, color: theme.stats.visitors, scale: "count" },
        ]}
        height={120}
        lineWidth={2}
      />
    </div>
  );
}

// A share as a bar, filled to that fraction of its width, with its percentage
// in the same place, shown instead while the devices and systems are hovered.
function Share(props: { part: number; whole: number }) {
  return (
    <>
      <span
        class="bar off-hover"
        style={{ "--fill": props.whole > 0 ? props.part / props.whole : 0 }}
        aria-hidden="true"
      />
      <span class="pct on-hover">{pct(props.part, props.whole)}%</span>
    </>
  );
}

// Each country's flag (flag-icons, MIT), by ISO code: separate files, so
// only the ones shown are fetched.
const FLAGS = import.meta.glob<string>("../../node_modules/flag-icons/flags/4x3/*.svg", {
  query: "?no-inline", // separate files, not inlined into the bundle
  import: "default",
  eager: true,
});
const flag = (code: string) =>
  FLAGS[`../../node_modules/flag-icons/flags/4x3/${code.toLowerCase()}.svg`];
const countryName = new Intl.DisplayNames(["en"], { type: "region" });

// A row of flags for the countries visitors came from (the top 16), each with
// an area proportional to its visitors relative to the top one (at least 8px
// tall), and its name and numbers on hover.
function Countries(props: { items: { code: string; visitors: number }[] }) {
  const shown = () => props.items.filter((c) => flag(c.code)).slice(0, 16);
  const total = () => props.items.reduce((n, c) => n + c.visitors, 0);
  return (
    <div class="countries">
      <For each={shown()}>
        {(c) => {
          const name = () => countryName.of(c.code) ?? c.code;
          return (
            <span title={`${name()}: ${num(c.visitors)} visitors (${pct(c.visitors, total())}%)`}>
              <img
                src={flag(c.code)}
                alt={name()}
                height={Math.max(8, Math.round(40 * Math.sqrt(c.visitors / shown()[0].visitors)))}
              />
            </span>
          );
        }}
      </For>
    </div>
  );
}

// Each source's icon in its brand colour; black logos use the text colour.
// Other sites' links are plain and the site's own pages use green.
const ICON_STYLE: Record<string, { size?: number; color: () => string }> = {
  google: { color: () => "#EA4335" },
  bing: { color: () => "#0078D4" },
  duckduckgo: { color: () => "#DE5833" },
  ecosia: { color: () => "#008009" },
  brave: { color: () => "#FB542B" },
  yandex: { color: () => "#FC3F1D" },
  baidu: { color: () => "#2932E1" },
  ycombinator: { size: 18, color: () => "#FF6600" },
  lobsters: { color: () => "#AC130D" },
  kagi: { color: () => "#FFB318" },
  reddit: { color: () => "#FF4500" },
  twitter: { color: () => "#1DA1F2" },
  bluesky: { color: () => "#1185FE" },
  mastodon: { color: () => "#6364FF" },
  threads: { color: () => theme.text },
  facebook: { color: () => "#1877F2" },
  instagram: { color: () => "#E4405F" },
  linkedin: { color: () => "#0A66C2" },
  youtube: { color: () => "#FF0000" },
  github: { color: () => theme.text },
  medium: { color: () => "#00AB6C" },
  substack: { color: () => "#FF6719" },
  openai: { color: () => theme.text },
  perplexity: { color: () => "#1FB8CD" },
  claude: { color: () => "#D97757" },
  link: { color: () => theme.text },
  file: { color: () => theme.stats.visitors },
};

// A source's icon (icons.ts), centred in a slot as wide as the largest one,
// so names line up whatever the icon's size.
function SourceIcon(props: { name: string }) {
  const style = () => ICON_STYLE[props.name];
  return (
    <span class="ref-icon">
      <svg
        width={style()?.size ?? 16}
        height={style()?.size ?? 16}
        style={{ color: style()?.color() }}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        innerHTML={ICONS[props.name]}
      />
    </span>
  );
}

// The device types, each drawn as a screen of its shape.
const DEVICES = [
  { key: "desktop", name: "Desktop", w: 14, h: 9 },
  { key: "tablet", name: "Tablet", w: 10, h: 12 },
  { key: "mobile", name: "Phone", w: 7, h: 12 },
] as const;

// The operating systems shown beside the devices.
const SYSTEMS = [
  ["windows", "Windows"],
  ["mac", "macOS"],
  ["ios", "iOS"],
  ["android", "Android"],
  ["linux", "Linux"],
] as const;

// An operating system's icon (icons.ts).
function OsIcon(props: { name: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      innerHTML={ICONS[props.name]}
    />
  );
}

function DeviceIcon(props: { w: number; h: number }) {
  return (
    <svg
      width={props.w + 2}
      height={props.h + 2}
      viewBox={`0 0 ${props.w + 2} ${props.h + 2}`}
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width={props.w}
        height={props.h}
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
    </svg>
  );
}
