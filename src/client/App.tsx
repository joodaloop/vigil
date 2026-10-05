import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { type Sparse, toDense } from "../shared/series";
import type { HostStats, HostSummaries, Overview, PageRow, Referrer, Site } from "../shared/types";
import { get, remember } from "./api";
import { Chart } from "./Chart";
import { DEFAULT_PERIOD, PERIODS } from "./config";
import { fullDate, num, pct } from "./format";
import { Pages, Referrers, sparkline } from "./lists";
import { People } from "./people";
import { theme } from "./theme";

// Each filter's pick, or null for none; set by picking a row in a list (or
// a country's flag).
type Filters = {
  country: string | null; // an ISO code
  page: string | null; // a path
  source: string | null; // a referring site's domain, or a page's path
};

// What's shown, and fetched; kept in the address.
type Query = {
  host: string;
  days: number;
} & Filters;

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

// An overview, its rows' series filled out to one value per day; reused if
// it was loaded in the last few minutes (see remember).
const getOverview = (params: URLSearchParams) =>
  remember(`/api/overview?${params}`, () => loadOverview(params));

async function loadOverview(params: URLSearchParams): Promise<Overview> {
  const { days, icon, stats } = await get<Overview<Sparse>>("/api/overview", params);
  const dense = <T extends { daily: Sparse; dailyNew: Sparse; dailyReads: Sparse }>(row: T) => ({
    ...row,
    daily: toDense(row.daily, days.length),
    dailyNew: toDense(row.dailyNew, days.length),
    dailyReads: toDense(row.dailyReads, days.length),
  });
  return {
    days,
    icon,
    stats: { ...stats, pages: stats.pages.map(dense), referrers: stats.referrers.map(dense) },
  };
}

export function App(props: { sites: Site[] }) {
  // Every site, in display order.
  const HOSTS = props.sites;
  const [query, setQuery] = createSignal(initialQuery(HOSTS));
  // The open host's unfiltered overview: what's shown without filters (and
  // kept, so clearing them is instant).
  const period = createMemo(() => `${query().host} ${query().days}`);
  const unfiltered = createMemo(() => {
    const [host, days] = period().split(" ");
    return getOverview(new URLSearchParams({ host, days }));
  });
  // The open host's stats, along with the query they answer. While a new
  // query loads, this (and everything drawn from it) keeps showing the last
  // one, so the panel's name, numbers and chart all switch together.
  const view = createMemo(async () => {
    const q = query();
    const all = unfiltered();
    const filtered = q.country !== null || q.page !== null || q.source !== null;
    return { q, all, overview: filtered ? await getOverview(toParams(q)) : all };
  });
  // Headline numbers for every host, for the sidebar. Only refetched when the
  // period changes (and reused if it was loaded in the last few minutes).
  const days = createMemo(() => query().days);
  const summaries = createMemo(() => {
    const params = new URLSearchParams({ days: String(days()) });
    return remember(`/api/hosts?${params}`, () => get<HostSummaries>("/api/hosts", params));
  });
  // Engaged mode: views shown as engaged ones (reads) instead, in the lists,
  // the sidebar and the main chart; turned on and off by clicking the
  // "engaged" total.
  const [engaged, setEngaged] = createSignal(false);
  // The day hovered or pinned on the main chart (unix seconds), which the
  // sidebar shows too: its index in the sidebar's days, if it's one of them.
  const [hoveredDay, setHoveredDay] = createSignal<number | null>(null);
  const sidebarDay = createMemo(() => {
    const i = hoveredDay() === null ? -1 : summaries().days.indexOf(hoveredDay()!);
    return i < 0 ? null : i;
  });
  // The day pinned on the main chart (unix seconds), if any.
  const [pinnedDay, setPinnedDay] = createSignal<number | null>(null);
  // The sidebar's hosts, most views first, or in engaged mode, most engaged
  // views: on the day pinned, if any, else in the period (ties fall back to
  // the period's numbers, then site order). A hovered day doesn't reorder
  // them.
  const byViews = createMemo(() => {
    const { hosts, days } = summaries();
    const k = engaged() ? "reads" : "views";
    const p = pinnedDay();
    const i = p === null ? -1 : days.indexOf(p);
    const total = (h: Site) => hosts[h.host]?.totals[k] ?? 0;
    const onDay = (h: Site) => (i < 0 ? 0 : (hosts[h.host]?.daily[k][i] ?? 0));
    return [...HOSTS].sort((a, b) => onDay(b) - onDay(a) || total(b) - total(a));
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
                // The day's numbers while one's hovered, else the period's.
                const count = (k: "views" | "reads" | "new") => {
                  const i = sidebarDay();
                  return i === null ? (s()?.totals[k] ?? 0) : (s()?.daily[k][i] ?? 0);
                };
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
                          <span class={{ engaged: engaged() }} style={{ color: theme.stats.views }}>
                            {num(count(engaged() ? "reads" : "views"))}
                          </span>
                          <span style={{ color: theme.stats.new }}>{num(count("new"))}</span>
                        </span>
                        <Chart
                          days={summaries().days}
                          lines={sparkline(
                            (engaged() ? s()?.daily.reads : s()?.daily.views) ?? [],
                            engaged(),
                          )}
                          height={20}
                          lineWidth={1.5}
                          marked={sidebarDay()}
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
              icon={view().overview.icon}
              // How many rows each list has unfiltered, for its height.
              rows={{
                pages: view().all.stats.pages.length,
                referrers: view().all.stats.referrers.length,
              }}
              // The filters of the stats shown, so a row shows as picked
              // (and is drawn as such) until the stats without it land.
              filters={{
                country: view().q.country,
                page: view().q.page,
                source: view().q.source,
              }}
              onFilter={update}
              onDay={setHoveredDay}
              onPin={setPinnedDay}
              engaged={engaged()}
              onEngaged={() => setEngaged((on) => !on)}
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
  icon?: number; // the site's saved favicon's version, if any
  rows: { pages: number; referrers: number }; // each list's rows, unfiltered
  filters: Filters;
  onFilter: (change: Partial<Filters>) => void;
  onDay: (day: number | null) => void; // the day hovered or pinned, in unix seconds
  onPin: (day: number | null) => void; // the day pinned, in unix seconds
  engaged: boolean; // engaged mode (see App)
  onEngaged: () => void; // a click on the engaged total, turning it on or off
}) {
  const t = () => props.stats.totals;
  // The day hovered on the chart, and the stats as of it, which the totals
  // and lists show. Kept as the day itself (unix seconds), and found among
  // the days shown, so it's never one they don't have (as for a moment after
  // the period changes, before the chart lets go of it).
  const [hovered, setHovered] = createSignal<number | null>(null);
  const day = createMemo(() => {
    const i = hovered() === null ? -1 : props.days.indexOf(hovered()!);
    return i < 0 ? null : i;
  });
  // In engaged mode, the lists ranked by engaged views instead.
  const shown = createMemo(() => onDay(props.stats, day(), props.engaged));
  const st = () => shown().totals;
  // Space switches the numbers to percentages and back (but not
  // while a control has focus, which space would press).
  const [asPct, setAsPct] = createSignal(false);
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element).closest("button, a, select, input, textarea, [contenteditable]"))
        return;
      e.preventDefault(); // or it would scroll the page
      setAsPct((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div class={["stats", { pct: asPct() }]}>
      <div class="stats-main">
        {/* Name and address on the left, totals on the right. */}
        <div class="stats-head">
          <div class="host-title">
            <h1>{props.name}</h1>
            <span class="host-url" title={`https://${props.host}/`}>
              {props.host}
            </span>
            {/* The period's first and last days, or the day hovered. */}
            <span class="host-dates">
              {day() === null
                ? fullDate.formatRange(
                    props.days[0] * 1000,
                    props.days[props.days.length - 1] * 1000,
                  )
                : fullDate.format(props.days[day()!] * 1000)}
            </span>
          </div>
          {/* While a day is hovered: its numbers. */}
          <div class="totals">
            <div class="total" style={{ color: theme.stats.views }}>
              <div class="big">{num(st().views)}</div>
              <div class="big-label">Page views</div>
              {/* Read: visible for long enough (30s unless the tracker's
                  data-read-after says otherwise). */}
              {/* Clicking it shows engaged views in place of views
                  everywhere (engaged mode), until it's clicked again. */}
              <div class="sub">
                <button
                  class="engaged-toggle"
                  aria-pressed={props.engaged ? "true" : "false"}
                  title="Engaged: views that stayed on screen long enough"
                  onClick={props.onEngaged}
                >
                  {/* Only the form shown (unlike the other numbers, which
                      keep both), so the button is as wide as its text. */}
                  {asPct() ? `${pct(st().reads, st().views)}% engaged` : `${num(st().reads)} engaged`}
                </button>
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
                  <span class="main-form">{num(t().newBounced)} bounced</span>
                  <span class="alt-form">{pct(t().newBounced, t().new)}% bounced</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <Chart
          days={props.days}
          lines={[
            // Engaged views, filled, under the lines: light alongside the
            // others, solid on their own.
            {
              values: props.stats.daily.reads,
              color: theme.stats.views,
              scale: "count",
              area: true,
              light: !props.engaged,
            },
            // Views and new visitors, or in engaged mode, engaged views alone.
            ...(props.engaged
              ? [{ values: props.stats.daily.reads, color: theme.stats.views, scale: "count" }]
              : [
                  { values: props.stats.daily.views, color: theme.stats.views, scale: "count" },
                  { values: props.stats.daily.new, color: theme.stats.new, scale: "count" },
                ]),
          ]}
          height={160}
          headroom={8}
          lineWidth={2}
          hoverDelay={250}
          onHover={(i) => {
            const t = i === null ? null : props.days[i];
            setHovered(t);
            props.onDay(t);
          }}
          onPin={(i) => props.onPin(i === null ? null : props.days[i])}
        />
      </div>

      <div class="lists">
        <Pages
          items={shown().pages}
          rows={props.rows.pages}
          days={props.days}
          engaged={props.engaged}
          picked={props.filters.page}
          onPick={(page) => props.onFilter({ page })}
        />
        <Referrers
          items={shown().referrers}
          rows={props.rows.referrers}
          host={props.host}
          icon={props.icon}
          days={props.days}
          engaged={props.engaged}
          picked={props.filters.source}
          onPick={(source) => props.onFilter({ source })}
        />
      </div>

      <People
        stats={shown()}
        days={props.days}
        day={day()}
        picked={props.filters.country}
        onPick={(country) => props.onFilter({ country })}
      />
    </div>
  );
}

// The stats as of a day hovered on the main chart (`day`), or the period's:
// the totals and every row's numbers that day. What's only known for the
// whole period stays as it is. Each list is ranked (once) as for the period
// (pages by views, referrers by new visitors then views), or in engaged mode
// (`engaged`), both by engaged views; ties keep the period's order. For the
// period, unless engaged, they're already in that order.
function onDay(stats: HostStats, day: number | null, engaged: boolean): HostStats {
  type Row = PageRow | Referrer;
  const atDay = <R extends Row>(r: R): R =>
    day === null
      ? r
      : { ...r, views: r.daily[day], new: r.dailyNew[day], reads: r.dailyReads[day] };
  const rank = <R extends Row>(rows: R[], by: (a: Row, b: Row) => number) =>
    day === null && !engaged ? rows : rows.map(atDay).sort(by);
  const byReads = (a: Row, b: Row) => b.reads - a.reads;
  const { daily } = stats;
  return {
    ...stats,
    totals:
      day === null
        ? stats.totals
        : {
            ...stats.totals,
            views: daily.views[day],
            reads: daily.reads[day],
            new: daily.new[day],
            visitors: daily.visitors[day],
          },
    pages: rank(stats.pages, engaged ? byReads : (a, b) => b.views - a.views),
    referrers: rank(
      stats.referrers,
      engaged ? byReads : (a, b) => b.new - a.new || b.views - a.views,
    ),
  };
}
