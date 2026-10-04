import { createMemo, createSignal, Errored, For, isPending, latest, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { HostStats, HostSummaries, Overview, PageRow, Referrer, Site } from "../shared/types";
import { Chart } from "./Chart";
import { DEFAULT_PERIOD, PERIODS } from "./config";
import { ICONS } from "./icons";
import { referrerIcon, referrerName } from "../shared/referrers";
import { theme } from "./theme";

// What's shown, and fetched.
type Query = {
  host: string;
  days: number;
  ref: string | null; // referrer filter
  page: string | null; // page filter, a path
  country: string | null; // country filter, an ISO code
};

const initialParams = new URLSearchParams(location.search);

function initialQuery(hosts: Site[]): Query {
  const params = initialParams;
  const n = Number(params.get("days"));
  const host = params.get("host");
  return {
    host: hosts.some((h) => h.host === host) ? host! : hosts[0].host,
    days: PERIODS.includes(n) ? n : DEFAULT_PERIOD,
    ref: params.get("ref") || null,
    page: params.get("page") || null,
    country: params.get("country") || null,
  };
}

function toParams(q: Query) {
  const params = new URLSearchParams({ host: q.host, days: String(q.days) });
  if (q.ref) params.set("ref", q.ref);
  if (q.page) params.set("page", q.page);
  if (q.country) params.set("country", q.country);
  return params;
}

async function get<T>(path: string, params: Record<string, string | null>): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const r = await fetch(`${path}?${search}`);
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
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
// A list row's share of its list, for the bar behind it; none under 0.25%.
const share = (part: number, whole: number) =>
  whole > 0 && part / whole >= 0.005 ? part / whole : 0;

export function App(props: { sites: Site[] }) {
  // Every site, in display order.
  const HOSTS = props.sites;
  const [query, setQuery] = createSignal(initialQuery(HOSTS));
  // The open host in full.
  function fetchOverview(q: Query) {
    return get<Overview>("/api/overview", {
      host: q.host,
      days: String(q.days),
      ref: q.ref,
      page: q.page,
      country: q.country,
    });
  }

  // The open host's stats, along with the query they answer. While a new
  // query loads, this (and everything drawn from it) keeps showing the last
  // one, so the panel's name, filters, numbers and chart all switch together.
  const view = createMemo(async () => {
    const q = query();
    return { q, overview: await fetchOverview(q) };
  });
  // Headline numbers for every host, for the sidebar. Never filtered, so only
  // refetched when the period changes.
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

  function update(change: Partial<Query>) {
    const next = { ...query(), ...change };
    setQuery(next);
    history.replaceState(null, "", `?${toParams(next)}`);
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
                    onClick={() =>
                      open() || update({ host: h.host, ref: null, page: null, country: null })
                    }
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
              days={view().overview.days}
              activeRef={view().q.ref}
              onSelectRef={(ref) => update({ ref })}
              activePage={view().q.page}
              onSelectPage={(page) => update({ page })}
              activeCountry={view().q.country}
              onSelectCountry={(country) => update({ country })}
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
  days: number[];
  activeRef: string | null;
  onSelectRef: (ref: string | null) => void;
  activePage: string | null;
  onSelectPage: (page: string | null) => void;
  activeCountry: string | null;
  onSelectCountry: (country: string | null) => void;
}) {
  const t = () => props.stats.totals;
  // One scale for every page's sparkline (across all pages of the list), so
  // their heights compare.
  const pageMax = () => {
    let max = 0;
    for (const p of props.stats.pages) for (const v of p.daily) if (v > max) max = v;
    return { count: max };
  };
  // Every page's views together (the day's while one is hovered), for each
  // page's share.
  const pageTotal = () => {
    const i = day();
    return props.stats.pages.reduce((n, p) => n + (i === null ? p.views : p.daily[i]), 0);
  };
  // The day hovered on the chart, whose numbers replace the period's.
  const [day, setDay] = createSignal<number | null>(null);
  const shown = (stat: "views" | "new" | "reads") => {
    const i = day();
    return i === null ? t()[stat] : props.stats.daily[stat][i];
  };

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
          </div>
          {/* While a day is hovered: its numbers. */}
          <div class="totals">
            <div class="total" style={{ color: theme.stats.views }}>
              <div class="big">{num(shown("views"))}</div>
              <div class="big-label">Page views</div>
              {/* Read: visible for long enough (30s unless the tracker's
                  data-read-after says otherwise). */}
              <div class="sub">
                <span title="Engaged: views that stayed on screen long enough">
                  {num(shown("reads"))} engaged
                </span>
              </div>
            </div>
            <div class="total" style={{ color: theme.stats.new }}>
              <div class="big">{num(shown("new"))}</div>
              <div class="big-label">New devices</div>
              {/* Only known for the whole period, so it stays put while a day
                  is hovered. */}
              <div class="sub">
                <span
                  title={`Bounced: ${num(t().newBounced)} devices that opened one page and never came back`}
                >
                  {pct(t().newBounced, t().new)}% bounce
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
        <div class="pages">
          <Paged items={byDay(props.stats.pages, day(), (p) => p.views)} first={day() !== null}>
            {(page) => (
              <PageItem
                page={page}
                days={props.days}
                day={day()}
                total={pageTotal()}
                max={pageMax()}
                active={props.activePage === page.path}
                onSelect={props.onSelectPage}
              />
            )}
          </Paged>
        </div>

        <Referrers
          items={props.stats.referrers}
          days={props.days}
          day={day()}
          active={props.activeRef}
          onSelect={props.onSelectRef}
        />
      </div>

      <People
        stats={props.stats}
        days={props.days}
        activeCountry={props.activeCountry}
        onSelectCountry={props.onSelectCountry}
      />
    </div>
  );
}

// "September 19, 2026"; days are UTC.
const fullDate = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

// Referrers by new visitors, then views. Clicking one filters everything to
// visits from it (or clears the filter). While a day is hovered on the main
// chart (`day`), the list is ranked the same way by that day (ties by the
// period) and each row shows that day's counts instead of the period's.
function Referrers(props: {
  items: Referrer[];
  days: number[];
  day: number | null;
  active: string | null;
  onSelect: (ref: string | null) => void;
}) {
  // One scale for every sparkline (across all pages of the list), so their
  // heights compare.
  const max = () => {
    let max = 0;
    for (const r of props.items) for (const v of r.daily) if (v > max) max = v;
    return { count: max };
  };
  // A referrer's views and new visitors (the day's while one is hovered),
  // and every referrer's new visitors together, for its share.
  const views = (r: Referrer) => (props.day === null ? r.visits : r.daily[props.day]);
  const fresh = (r: Referrer) => (props.day === null ? r.new : r.dailyNew[props.day]);
  const total = () => props.items.reduce((n, r) => n + fresh(r), 0);

  return (
    <div class="referrers">
      <Paged items={byNewOnDay(props.items, props.day)} first={props.day !== null}>
        {(r) => {
          const on = () => props.active === r.domain;
          return (
            <div
              class={["referrer", { active: on() }]}
              style={{ "--share": share(fresh(r), total()) }}
            >
              <button
                class="ref-name"
                title={on() ? "Clear filter" : `Only views that came from ${r.domain}`}
                aria-pressed={on() ? "true" : "false"}
                onClick={() => props.onSelect(on() ? null : r.domain)}
              >
                <SourceIcon name={referrerIcon(r.domain)} />
                <span class="ref-label">{referrerName(r.domain)}</span>
              </button>
              {/* A sparkline of its daily views, then its views and new visitors. */}
              <span class="ref-count" style={{ color: theme.stats.views }}>
                <span class="ref-spark" aria-hidden="true">
                  <Chart
                    days={props.days}
                    lines={[{ values: r.daily, color: theme.stats.views, scale: "count" }]}
                    maxes={max()}
                    height={16}
                    lineWidth={1.25}
                  />
                </span>
                <span class="ref-num">{num(views(r))}</span>
                <span class="ref-num" style={{ color: theme.stats.new }}>
                  {fresh(r) > 0 ? num(fresh(r)) : ""}
                </span>
              </span>
            </div>
          );
        }}
      </Paged>
    </div>
  );
}

// Shows `items` 10 at a time, with a row of page dots when there are more.
// The list keeps a full page's height, dots included, however few items
// there are.
// `first` shows the first page without forgetting the one picked, e.g. while
// a day is hovered and the list is ranked by it.
// The page buttons are one tab stop, the current page's: arrow keys, Home
// and End move between pages from there.
function Paged<T>(props: {
  items: T[];
  size?: number;
  first?: boolean;
  children: (item: T) => JSX.Element;
}) {
  const size = () => props.size ?? 10;
  const [page, setPage] = createSignal(0);
  const pages = () => Math.max(1, Math.ceil(props.items.length / size()));
  // Stay in range when the list shrinks (new period, filter or site).
  const current = () => (props.first ? 0 : Math.min(page(), pages() - 1));
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
        <For each={props.items.slice(start(), start() + size())}>
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

// A page with a sparkline of its daily views, its views and its new visitors.
// Clicking it filters everything else to that page (or clears the filter).
function PageItem(props: {
  page: PageRow;
  days: number[];
  day: number | null; // hovered on the main chart: show that day's numbers
  total: number; // every page's views, for this one's share
  max: Record<string, number>;
  active: boolean;
  onSelect: (page: string | null) => void;
}) {
  return (
    <button
      class={["row", { active: props.active }]}
      style={{
        "--share": share(
          props.day === null ? props.page.views : props.page.daily[props.day],
          props.total,
        ),
      }}
      title={props.active ? "Clear filter" : `Only views of ${props.page.path}`}
      aria-pressed={props.active ? "true" : "false"}
      onClick={() => props.onSelect(props.active ? null : props.page.path)}
    >
      {/* "/posts/x/" shows as "posts/x"; the home page stays "/". */}
      <span class="label path">{props.page.path.replace(/^\/+|\/+$/g, "") || "/"}</span>
      <span class="page-spark" aria-hidden="true">
        <Chart
          days={props.days}
          lines={[{ values: props.page.daily, color: theme.stats.views, scale: "count" }]}
          maxes={props.max}
          height={16}
          lineWidth={1.25}
        />
      </span>
      <span class="num" style={{ color: theme.stats.views }}>
        {num(props.day === null ? props.page.views : props.page.daily[props.day])}
      </span>
      <span class="num" style={{ color: theme.stats.new }}>
        {(() => {
          const n = props.day === null ? props.page.new : props.page.dailyNew[props.day];
          return n > 0 ? num(n) : "";
        })()}
      </span>
    </button>
  );
}

// A list's rows as they arrive (busiest over the period first), or with a day
// hovered, busiest that day first (ties by the period).
function byDay<T extends { daily: number[] }>(
  items: T[],
  day: number | null,
  total: (item: T) => number,
): T[] {
  if (day === null) return items;
  return [...items].sort((a, b) => b.daily[day] - a.daily[day] || total(b) - total(a));
}

// Visitors: their number and devices on one side and the countries they came
// from on the other, then their chart across the panel. Nothing here responds
// to hovering, on either chart.
function People(props: {
  stats: HostStats;
  days: number[];
  activeCountry: string | null;
  onSelectCountry: (country: string | null) => void;
}) {
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
            </div>
            {/* Each column most common first. */}
            <div class="sub stacked icons devices">
              <For each={[...DEVICES].sort((a, b) => devices()[b.key] - devices()[a.key])}>
                {(d) => (
                  <span title={`${d.name}: ${pct(devices()[d.key], t().visitors)}%`}>
                    <DeviceIcon w={d.w} h={d.h} />
                    <Bar part={devices()[d.key]} whole={t().visitors} />
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
                    <Bar part={t().systems[key]} whole={t().systems.known} />
                  </span>
                )}
              </For>
            </div>
          </div>
        </div>
        <Countries
          countries={t().countries}
          active={props.activeCountry}
          onSelect={props.onSelectCountry}
        />
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

// A share as a bar, filled to that fraction of its width.
function Bar(props: { part: number; whole: number }) {
  return (
    <span
      class="bar"
      style={{ "--fill": props.whole > 0 ? props.part / props.whole : 0 }}
      aria-hidden="true"
    />
  );
}

// Referrers as they arrive, or with a day hovered, by that day's new
// visitors, then its views, then the period's order.
function byNewOnDay(items: Referrer[], day: number | null): Referrer[] {
  if (day === null) return items;
  return [...items].sort(
    (a, b) =>
      b.dailyNew[day] - a.dailyNew[day] ||
      b.daily[day] - a.daily[day] ||
      b.new - a.new ||
      b.visits - a.visits,
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

// A row of flags for the countries visitors came from, each with an area
// proportional to its visitors relative to the top one (at least 8px tall). Clicking one filters everything else to
// that country (or clears the filter); the picked one stays listed.
function Countries(props: {
  countries: { code: string; visitors: number }[];
  active: string | null;
  onSelect: (country: string | null) => void;
}) {
  const shown = () => {
    const known = props.countries.filter((c) => flag(c.code));
    const top = known.slice(0, 16);
    const picked = known.find((c) => c.code === props.active);
    return picked && !top.includes(picked) ? [...top, picked] : top;
  };
  const total = () => props.countries.reduce((n, c) => n + c.visitors, 0);
  return (
    <div class="countries">
      <For each={shown()}>
        {(c) => {
          const on = () => props.active === c.code;
          const name = () => countryName.of(c.code) ?? c.code;
          return (
            <button
              class={{ active: on() }}
              aria-pressed={on() ? "true" : "false"}
              title={
                on()
                  ? "Clear filter"
                  : `${name()}: ${num(c.visitors)} visitors (${pct(c.visitors, total())}%)`
              }
              onClick={() => props.onSelect(on() ? null : c.code)}
            >
              <img
                src={flag(c.code)}
                alt={name()}
                height={Math.max(8, Math.round(40 * Math.sqrt(c.visitors / shown()[0].visitors)))}
              />
            </button>
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
        rx="2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
    </svg>
  );
}
