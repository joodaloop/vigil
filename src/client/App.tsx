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
import type { HostStats, HostSummaries, Overview, Site } from "../shared/types";
import { get } from "./api";
import { Chart } from "./Chart";
import { DEFAULT_PERIOD, PERIODS } from "./config";
import { FilterMenus, type Filters } from "./filters";
import { fullDate, num, pct } from "./format";
import { Pages, Referrers } from "./lists";
import { People } from "./people";
import { theme } from "./theme";

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
  // Space switches the top half's numbers to percentages and back (but not
  // while a control has focus, which space would press).
  const [asPct, setAsPct] = createSignal(false);
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element).closest("button, a, select, input, textarea, [contenteditable]")) return;
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
            <span class="host-url">
              {day() === null ? props.host : fullDate.format(props.days[day()!] * 1000)}
            </span>
            <FilterMenus
              stats={props.stats}
              options={props.options}
              filters={props.filters}
              onFilter={props.onFilter}
            />
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
                  <span class="main-form">{num(st().reads)} engaged</span>
                  <span class="alt-form">{pct(st().reads, st().views)}% engaged</span>
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
            { values: props.stats.daily.views, color: theme.stats.views, scale: "count" },
            // Engaged views, as a fill under the views.
            { values: props.stats.daily.reads, color: theme.stats.views, scale: "count", area: true },
            { values: props.stats.daily.new, color: theme.stats.new, scale: "count" },
          ]}
          height={160}
          headroom={8}
          lineWidth={2}
          onHover={setDay}
        />
      </div>

      <div class="lists">
        <Pages items={shown().pages} host={props.host} days={props.days} />
        <Referrers items={shown().referrers} host={props.host} days={props.days} />
      </div>

      <People stats={shown()} days={props.days} day={day()} />
    </div>
  );
}

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
      visitors: daily.visitors[day],
    },
    pages: stats.pages
      .map((p) => ({ ...p, views: p.daily[day], new: p.dailyNew[day] }))
      .sort((a, b) => b.views - a.views),
    referrers: stats.referrers
      .map((r) => ({ ...r, views: r.daily[day], new: r.dailyNew[day] }))
      .sort((a, b) => b.new - a.new || b.views - a.views),
  };
}
