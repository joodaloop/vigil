import {
  createEffect,
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
import { Chart, filled, peak } from "./Chart";
import { DEFAULT_PERIOD } from "./config";
import { fullDate, num, pct } from "./format";
import { Pages, Referrers, sparkline, viewLines } from "./lists";
import { People } from "./people";
import { onShortcut, onTaps, plainClick } from "./keys";
import { Shortcuts } from "./shortcuts";
import { storedFlag } from "./stored";
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
  ago: number; // how many days before today the period ends
} & Filters;

function initialQuery(hosts: Site[]): Query {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get("days"));
  const host = params.get("host");
  return {
    host: hosts.some((h) => h.host === host) ? host! : hosts[0].host,
    days: Number.isInteger(n) && n >= 1 && n <= 366 ? n : DEFAULT_PERIOD,
    ago: Math.max(0, Math.floor(Number(params.get("ago")) || 0)),
    country: params.get("country") || null,
    page: params.get("page") || null,
    source: params.get("source") || null,
  };
}

// The query as the address's and the API's parameters, leaving out filters
// that aren't set (and `ago` while the period ends today).
function toParams(q: Query) {
  const params = new URLSearchParams({ host: q.host, days: String(q.days) });
  if (q.ago) params.set("ago", String(q.ago));
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
  const period = createMemo(() => `${query().host} ${query().days} ${query().ago}`);
  const unfiltered = createMemo(() => {
    const [host, days, ago] = period().split(" ");
    const params = new URLSearchParams({ host, days });
    if (ago !== "0") params.set("ago", ago);
    return getOverview(params);
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
  const days = createMemo(() => `${query().days} ${query().ago}`);
  const summaries = createMemo(() => {
    const [n, ago] = days().split(" ");
    const params = new URLSearchParams({ days: n });
    if (ago !== "0") params.set("ago", ago);
    return remember(`/api/hosts?${params}`, () => get<HostSummaries>("/api/hosts", params));
  });
  // Engaged mode: views shown as engaged ones (reads) instead, in the lists,
  // the sidebar and the main chart; turned on and off by clicking the
  // "engaged" total, and remembered in this browser.
  const [engaged, setEngaged] = storedFlag("vigil:engaged", false);
  // The sidebar's hosts, most views in the period first, or in engaged mode,
  // most engaged views (ties keep site order). A hovered day doesn't
  // reorder them.
  const byViews = createMemo(() => {
    const hosts = summaries().hosts;
    const k = engaged() ? "reads" : "views";
    const views = (h: Site) => hosts[h.host]?.totals[k] ?? 0;
    return [...HOSTS].sort((a, b) => views(b) - views(a));
  });
  // The day hovered on any of the sidebar's charts, which they all mark and
  // show the numbers of: kept as the day itself (unix seconds), and found
  // among their days, so it's never one they don't have. The main chart's
  // day doesn't reach the sidebar.
  const [hoveredDay, setHoveredDay] = createSignal<number | null>(null);
  // Every host's count that day, added up.
  const dayTotal = (k: "views" | "reads" | "new") =>
    Object.values(summaries().hosts).reduce((n, h) => n + (h.daily[k][sidebarDay()!] ?? 0), 0);
  const sidebarDay = () => {
    const i = hoveredDay() === null ? -1 : summaries().days.indexOf(hoveredDay()!);
    return i < 0 ? null : i;
  };
  // A new query is on its way: the panel fades a little until it lands.
  const updating = () => isPending(() => view());

  // From the query as last set, which a read of `query()` doesn't give until
  // the next flush, so two changes in a row both count. Each is a step back,
  // unless it changes nothing.
  function update(change: Partial<Query>) {
    setQuery((q) => {
      const next = { ...q, ...change };
      const address = `?${toParams(next)}`;
      if (address === `?${toParams(q)}`) return q;
      history.pushState(null, "", address);
      return next;
    });
  }
  // The address `change` goes to, for a link that makes it; the link's plain
  // clicks make it in the page (`follow`), others are left to the browser.
  const hrefFor = (change: Partial<Query>) => `?${toParams({ ...query(), ...change })}`;
  const follow = (e: MouseEvent, change: Partial<Query>) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    update(change);
  };
  // Back and forward show the query in the address they land on.
  onSettled(() => {
    const onPop = () => setQuery(initialQuery(HOSTS));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });
  // Escape twice in quick succession focuses the sidebar's first host.
  let escapedAt = -Infinity;
  onShortcut((e) => {
    if (e.key !== "Escape" || e.repeat) return;
    const now = performance.now();
    if (now - escapedAt < 400) {
      escapedAt = -Infinity;
      document.querySelector<HTMLElement>(".sidebar a.host-name")?.focus();
    } else {
      escapedAt = now;
    }
  });

  // Nothing but the intro, in the middle of the page, until both the
  // sidebar and the panel have their first numbers, so they arrive together.
  return (
    <Loading
      fallback={
        <div class="loading">
          <div class="sidebar-top">
            <Intro />
          </div>
        </div>
      }
    >
      <main>
        <nav class="sidebar">
          <div class="sidebar-top">
            <Intro />
            {/* The day hovered on the sidebar's charts, in its place while
                there is one, with every host's views (or engaged views) and
                new visitors that day added up. */}
            <Show
              when={sidebarDay() !== null}
              fallback={
                <p>
                  Clone it on <a href="https://github.com/joodaloop/vigil">Github</a> to use it.
                </p>
              }
            >
              <p
                style={{ display: "flex", "justify-content": "space-between", "font-weight": 600 }}
              >
                <span class="host-counts">
                  <span style={{ color: theme.stats.views }}>
                    {num(dayTotal(engaged() ? "reads" : "views"))}
                  </span>
                  <span style={{ color: theme.stats.new }}>{num(dayTotal("new"))}</span>
                </span>
                {dateOf(summaries().days[sidebarDay()!] * 1000)}
              </p>
            </Show>
          </div>

          {/* One entry per host; the open one is shown in full on the right. */}
          <Errored fallback={<p class="muted">Couldn't load hosts</p>}>
            <For each={byViews()}>
              {(h) => {
                const s = () => summaries().hosts[h.host];
                // On the same scale as the host's chart on the right (see
                // Stats): its largest day seen yet.
                const maxes = createMemo(() => ({
                  count: peak(h.host, Math.max(0, ...(s()?.daily.views ?? []))),
                }));
                // Marked as soon as it's picked, ahead of its stats.
                const open = () => latest(() => query().host) === h.host;
                // Nothing in the period (it still opens, to say so).
                const empty = () => !s()?.totals.views;
                // The day's numbers while one's hovered, else the period's.
                const count = (k: "views" | "reads" | "new") => {
                  const i = sidebarDay();
                  return i === null ? (s()?.totals[k] ?? 0) : (s()?.daily[k][i] ?? 0);
                };
                return (
                  <div class="host-item">
                    {/* Only the name opens it. */}
                    <a
                      class="host-name"
                      href={hrefFor({ host: h.host })}
                      aria-current={open() ? "page" : undefined}
                      title={h.host}
                      onClick={(e) => follow(e, { host: h.host })}
                    >
                      {h.name}
                    </a>
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
                            s()?.daily.views ?? [],
                            engaged() ? (s()?.daily.reads ?? []) : null,
                          )}
                          maxes={maxes()}
                          height={24}
                          lineWidth={1.5}
                          marked={sidebarDay()}
                          onHover={(i) => setHoveredDay(i === null ? null : summaries().days[i])}
                        />
                      </span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Errored>
          <Shortcuts />
        </nav>

        <section class={["panel", { updating: updating() }]}>
          <Errored
            fallback={(e) => (
              <p class="muted error" role="alert">
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
              filterHref={hrefFor}
              onFollow={follow}
              ago={view().q.ago}
              onPeriod={(days, ago) => update({ days, ago })}
              updating={updating()}
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
  filterHref: (change: Partial<Filters>) => string; // the address a filter's link goes to
  onFollow: (e: MouseEvent, change: Partial<Filters>) => void; // a click on that link
  ago: number; // how many days before today the period ends
  onPeriod: (days: number, ago: number) => void; // a period picked (see periods)
  updating: boolean; // new stats on their way
  engaged: boolean; // engaged mode (see App)
  onEngaged: () => void; // a click on the engaged total (or "/"), turning it on or off
}) {
  const t = () => props.stats.totals;
  // The day hovered on the chart, and the stats as of it, which the totals
  // and lists show. Kept as the day itself (unix seconds), and found among
  // the days shown, so it's never one they don't have (as for a moment after
  // the period changes, before the chart lets go of it).
  const [hovered, setHovered] = createSignal<number | null>(null);
  // The day pinned by a click on either chart, shown instead while there is
  // one, and kept the same way. It stays until another day is pinned, it's
  // clicked again, Escape, or the days change to ones without it (another
  // period that doesn't reach it).
  const [pinned, setPinned] = createSignal<number | null>(null);
  const indexOf = (d: number | null) => (d === null ? -1 : props.days.indexOf(d));
  createEffect(
    () => indexOf(pinned()) < 0,
    (gone) => {
      if (gone) setPinned(null);
    },
  );
  const day = createMemo(() => {
    const i = indexOf(pinned()) >= 0 ? indexOf(pinned()) : indexOf(hovered());
    return i < 0 ? null : i;
  });
  const onHover = (i: number | null) => setHovered(i === null ? null : props.days[i]);
  // In engaged mode, the lists ranked by engaged views instead.
  const shown = createMemo(() => onDay(props.stats, day(), props.engaged, props.filters));
  const st = () => shown().totals;
  // In place of a list's rows on a day with none (see onDay). A list can be
  // empty for the whole period too (referrers, under a filter), left blank.
  const none = () =>
    day() === null ? undefined : props.engaged ? "No engaged views this day." : "No views this day.";
  // The chart's scale, the host's largest day seen yet (views are never
  // fewer than new visitors or engaged views).
  const maxes = createMemo(() => ({
    count: peak(props.host, Math.max(0, ...props.stats.daily.views)),
  }));
  // One scale for every sparkline in both lists (across all their pages),
  // the largest day of any row seen on the host's lists yet, so their
  // heights compare, within a list, across the two, and with other periods'
  // and filters'. From the stats before any day is hovered (the same rows'
  // days), and a number first, so hovering leaves it, and the sparklines, be.
  const listTop = createMemo(() => {
    let max = 0;
    for (const x of [...props.stats.pages, ...props.stats.referrers])
      for (const v of x.daily) if (v > max) max = v;
    return peak(`${props.host} lists`, max);
  });
  const listMaxes = createMemo(() => ({ count: listTop() }));
  // "." switches the numbers to percentages and back, "," the lists' names
  // to their addresses and paths and back, "/" engaged mode on and off,
  // Backspace clears every filter, "[" and "]" pick the period before and
  // after this one, and "\" the most recent. While new stats load, "[" and
  // "]" do nothing, as they'd only pick from the period still shown.
  // Both remembered in this browser. On a touch screen, a double tap
  // switches percentages and a triple tap addresses.
  const [asPct, setAsPct] = storedFlag("vigil:percentages", false);
  const [asAddress, setAsAddress] = storedFlag("vigil:addresses", false);
  onTaps((n) => {
    if (n === 2) setAsPct((p) => !p);
    else if (n === 3) setAsAddress((a) => !a);
  });
  // What changed, for screen readers (in a polite status region below): a
  // day pinned or unpinned, with its numbers; percentages, addresses or
  // engaged mode switched; new stats loading and landing.
  const [status, setStatus] = createSignal("");
  const announce = <T,>(source: () => T, message: (v: T) => string | null) => {
    let first = true;
    createEffect(source, (v) => {
      if (first) return void (first = false);
      const m = message(v);
      if (m !== null) setStatus(m);
    });
  };
  announce(
    () => indexOf(pinned()),
    (i) =>
      i < 0
        ? "Day unpinned"
        : `${dayOf(props.days[i] * 1000, true)}: ${num(st().views)} page views, ${num(st().new)} new devices`,
  );
  announce(asPct, (on) => (on ? "Showing percentages" : "Showing numbers"));
  announce(asAddress, (on) => (on ? "Showing addresses" : "Showing names"));
  announce(
    () => props.engaged,
    (on) => (on ? "Showing engaged views" : "Showing all views"),
  );
  announce(
    () => props.updating,
    (on) => (on ? "Loading" : "Loaded"),
  );
  // While a day is pinned, "-" and "=" move the pin to the day before and
  // after (round from one end to the other); while none is, "=" pins the
  // first day and "-" the last. Escape unpins it.
  onShortcut((e) => {
    if (props.days.length === 0) return;
    const by = { "-": -1, "=": 1 }[e.key];
    if (by !== undefined) {
      e.preventDefault();
      const from = indexOf(pinned());
      const n = props.days.length;
      setPinned(props.days[from < 0 ? (by > 0 ? 0 : n - 1) : (((from + by) % n) + n) % n]);
    } else if (e.key === "Escape") {
      setPinned(null);
    }
  });
  // "1", "2" and "3" focus the first row shown of the pages and the
  // referrers, and the first country.
  onShortcut((e) => {
    const list = { "1": ".pages .paged", "2": ".referrers .paged", "3": ".countries" }[e.key];
    if (!list || e.repeat) return;
    e.preventDefault();
    (document.querySelector(`${list} > *`) as HTMLElement | null)?.focus();
  });
  onShortcut((e) => {
    if (e.key === "." && !e.repeat) {
      setAsPct((p) => !p);
    } else if (e.key === "," && !e.repeat) {
      setAsAddress((a) => !a);
    } else if (e.key === "/" && !e.repeat) {
      e.preventDefault(); // or Firefox opens its quick find
      props.onEngaged();
    } else if (e.key === "Backspace" && !e.repeat) {
      const f = props.filters;
      if (f.page === null && f.source === null && f.country === null) return;
      e.preventDefault();
      props.onFilter({ page: null, source: null, country: null });
    } else if (e.key === "[" || e.key === "]" || e.key === "\\") {
      // Most recent first, so earlier is further down the list. A period
      // not in it goes to the most recent.
      const list = periods();
      const i = list.findIndex((p) => p.key === periodKey(props.days.length, props.ago));
      const to = e.key === "\\" || i < 0 ? 0 : i + (e.key === "[" ? 1 : -1);
      if (to < 0 || to >= list.length || to === i) return;
      e.preventDefault();
      if (props.updating) return;
      const [days, ago] = list[to].key.split(" ").map(Number);
      props.onPeriod(days, ago);
    }
  });

  return (
    <div class={["stats", { pct: asPct(), address: asAddress() }]}>
      <p class="sr-only" role="status">
        {status()}
      </p>
      {/* The numbers, chart and lists at the top; the visitors at the foot. */}
      <div class="stats-top">
        <div class="stats-main">
          {/* Name and address on the left, totals on the right. */}
          <div class="stats-head">
            <div class="host-title">
              <h1>{props.name}</h1>
              <span class="host-url" title={`https://${props.host}/`}>
                {props.host}
              </span>
              {/* The period's name ("Last 30 days", "September 2026"), or for
                  any other period its first and last days, which picks
                  another period; then the day hovered, if any. */}
              <div class="host-period">
                <div class="host-dates">
                  <span class="dates-text" aria-hidden="true">
                    {periods().find((p) => p.key === periodKey(props.days.length, props.ago))
                      ?.label ??
                      fullDate.formatRange(
                        props.days[0] * 1000,
                        props.days[props.days.length - 1] * 1000,
                      )}
                  </span>
                  <select
                    aria-label="Period"
                    value={periodKey(props.days.length, props.ago)}
                    onChange={(e) => {
                      const [days, ago] = e.currentTarget.value.split(" ").map(Number);
                      props.onPeriod(days, ago);
                    }}
                  >
                    <For each={periods()}>{(p) => <option value={p.key}>{p.label}</option>}</For>
                  </select>
                </div>
                <Show when={day() !== null}>
                  <span class="host-day">
                    — {dayOf(props.days[day()!] * 1000, !isMonth(props.days.length, props.ago))}
                  </span>
                </Show>
              </div>
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
                    {asPct()
                      ? `${pct(st().reads, st().views)}% engaged`
                      : `${num(st().reads)} engaged`}
                  </button>
                </div>
              </div>
              <div class="total" style={{ color: theme.stats.new }}>
                <div class="big">{num(st().new)}</div>
                <div class="big-label">New devices</div>
                {/* Only known for the whole period, so hidden while a day is
                    hovered (see .period-only). */}
                <div class="sub period-only" inert={day() !== null}>
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
            lines={
              // Views and new visitors, each over a light fill; in engaged
              // mode, with engaged views filled solid under the views.
              [
                ...viewLines(
                  props.stats.daily.views,
                  props.engaged ? props.stats.daily.reads : null,
                ),
                ...filled(props.stats.daily.new, theme.stats.new),
              ]
            }
            maxes={maxes()}
            height={160}
            headroom={8}
            lineWidth={2}
            hoverDelay={50}
            onHover={onHover}
            pinned={pinned()}
            onPin={setPinned}
            marked={day()}
          />
        </div>

        {/* With nothing in the period at all (unfiltered), a line saying so
            in place of the lists and the visitors. */}
        <Show when={props.rows.pages > 0} fallback={<p class="muted empty">No views in this period.</p>}>
          <div class="lists">
            <Pages
              items={shown().pages}
              rows={props.rows.pages}
              maxes={listMaxes()}
              days={props.days}
              engaged={props.engaged}
              none={none()}
              picked={props.filters.page}
              href={(page) => props.filterHref({ page })}
              onPick={(e, page) => props.onFollow(e, { page })}
            />
            <Referrers
              items={shown().referrers}
              maxes={listMaxes()}
              rows={props.rows.referrers}
              host={props.host}
              icon={props.icon}
              days={props.days}
              engaged={props.engaged}
              none={none()}
              picked={props.filters.source}
              href={(source) => props.filterHref({ source })}
              onPick={(e, source) => props.onFollow(e, { source })}
            />
          </div>
        </Show>
      </div>

      <Show when={props.rows.pages > 0}>
        <People
          host={props.host}
          stats={shown()}
          days={props.days}
          day={day()}
          pinned={pinned()}
          onHover={onHover}
          onPin={setPinned}
          picked={props.filters.country}
          href={(country) => props.filterHref({ country })}
          onPick={(e, country) => props.onFollow(e, { country })}
        />
      </Show>
    </div>
  );
}

// Who made Vigil: atop the sidebar, and alone while the page loads.
function Intro() {
  return (
    <p>
      <strong>Vigil</strong> is an app for privacy-unfriendly analytics, designed by{" "}
      <a href="https://joodaloop.com">Judah</a>.
    </p>
  );
}

// The periods the dates pick between, most recent first: the last
// DEFAULT_PERIOD days, then each of the 19 months before this one. Each is
// `days` long and ends `ago` days before today, and is keyed by both.
const monthName = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
function periods(): { key: string; label: string }[] {
  const DAY = 86400_000;
  const now = new Date();
  const today = Math.floor(now.getTime() / DAY);
  const months = Array.from({ length: 19 }, (_, i) => {
    const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i - 1, 1) / DAY;
    const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 0) / DAY;
    return {
      key: periodKey(last - first + 1, today - last),
      label: monthName.format(first * DAY),
    };
  });
  return [{ key: periodKey(DEFAULT_PERIOD, 0), label: `Last ${DEFAULT_PERIOD} days` }, ...months];
}
const periodKey = (days: number, ago: number) => `${days} ${ago}`;

// Whether the period is one of the months, named as such.
const isMonth = (days: number, ago: number) =>
  periods().findIndex((p) => p.key === periodKey(days, ago)) > 0;

// "15th, Saturday": a day hovered, after its period's name; with its month
// ("15th August, Saturday") when that name isn't a month's.
const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" });
const month = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
const ordinal = new Intl.PluralRules("en", { type: "ordinal" });
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };
function dayOf(ms: number, withMonth: boolean): string {
  const d = new Date(ms).getUTCDate();
  const day = `${d}${SUFFIX[ordinal.select(d)]}`;
  return `${withMonth ? `${day} ${month.format(ms)}` : day}, ${weekday.format(ms)}`;
}

// "15th August": a day hovered on the sidebar's charts.
function dateOf(ms: number): string {
  const d = new Date(ms).getUTCDate();
  return `${d}${SUFFIX[ordinal.select(d)]} ${month.format(ms)}`;
}

// The stats as of a day hovered on the main chart (`day`), or the period's:
// the totals and every row's numbers that day. What's only known for the
// whole period stays as it is. Each list is ranked (once) as for the period
// (pages by views, referrers by new visitors then views), or in engaged mode
// (`engaged`), both by engaged views; ties keep the period's order. For the
// period, unless engaged, they're already in that order. On a day, rows with
// no views that day (engaged views, in engaged mode) are left out, but for
// the ones picked as filters (`picked`), which keep their own sparklines.
function onDay(stats: HostStats, day: number | null, engaged: boolean, picked: Filters): HostStats {
  type Row = PageRow | Referrer;
  const atDay = <R extends Row>(r: R): R =>
    day === null
      ? r
      : { ...r, views: r.daily[day], new: r.dailyNew[day], reads: r.dailyReads[day] };
  const rank = <R extends Row>(rows: R[], key: (r: R) => string, pick: string | null, by: (a: Row, b: Row) => number) =>
    day === null && !engaged
      ? rows
      : rows
          .map(atDay)
          .filter((r) => day === null || (engaged ? r.reads : r.views) > 0 || key(r) === pick)
          .sort(by);
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
    pages: rank(stats.pages, (p) => p.path, picked.page, engaged ? byReads : (a, b) => b.views - a.views),
    referrers: rank(
      stats.referrers,
      (r) => r.source,
      picked.source,
      engaged ? byReads : (a, b) => b.new - a.new || b.views - a.views,
    ),
  };
}
