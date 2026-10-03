import { createMemo, createSignal, Errored, For, isPending, latest, Loading, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { HostStats, HostSummaries, HostSummary, Overview, PageRow, Referrer } from "../shared/types";
import { Chart, type Line } from "./Chart";
import { DEFAULT_PERIOD, PERIODS, SITES } from "./config";
import { referrerName } from "./referrers";
import { theme } from "./theme";

// Every host on the dashboard, in display order, with the site it belongs to.
const HOSTS = SITES.flatMap((s) => s.hosts.map((h) => ({ ...h, site: s.site })));

type ChartKind = "line" | "bars";
// What's fetched. The chart style isn't part of it, so changing that doesn't
// refetch.
type Query = {
  host: string;
  days: number;
  ref: string | null; // referrer filter
  page: string | null; // page filter, a path
};

const initialParams = new URLSearchParams(location.search);

function initialQuery(): Query {
  const params = initialParams;
  const n = Number(params.get("days"));
  const host = params.get("host");
  return {
    host: HOSTS.some((h) => h.host === host) ? host! : HOSTS[0].host,
    days: PERIODS.includes(n) ? n : DEFAULT_PERIOD,
    ref: params.get("ref") || null,
    page: params.get("page") || null,
  };
}

function toParams(q: Query, chart: ChartKind) {
  const params = new URLSearchParams({ host: q.host, days: String(q.days) });
  if (q.ref) params.set("ref", q.ref);
  if (q.page) params.set("page", q.page);
  if (chart !== "line") params.set("chart", chart);
  return params;
}

async function get<T>(path: string, params: Record<string, string | null>): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const r = await fetch(`${path}?${search}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// The open host in full.
function fetchOverview(q: Query) {
  const site = HOSTS.find((h) => h.host === q.host)!.site;
  return get<Overview>("/api/overview", {
    site,
    host: q.host,
    days: String(q.days),
    ref: q.ref,
    page: q.page,
  });
}

// Headline numbers for every host, for the sidebar. Never filtered.
async function fetchSummaries(days: number) {
  const all = await Promise.all(
    SITES.map((s) => get<HostSummaries>("/api/hosts", { site: s.site, days: String(days) })),
  );
  const hosts: Record<string, HostSummary> = Object.assign({}, ...all.map((a) => a.hosts));
  return { days: all[0]?.days ?? [], hosts };
}

// 950 -> "950", 4321 -> "4.3k", 17694 -> "17.7k", 1250000 -> "1.3M"
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const num = (n: number) => compact.format(n).replace("K", "k");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function duration(s: number | null) {
  if (s === null) return "–";
  return `${Math.round(s)}s`;
}

// `color` blended into `bg` ("#rrggbb" both), `amount` of the way: a lighter,
// opaque shade.
function tint(color: string, bg: string, amount: number) {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(color), rgb(bg)];
  return `rgb(${a.map((v, i) => Math.round(b[i] + (v - b[i]) * amount)).join(",")})`;
}

// Views, visitors and new visitors. Each is a subset of the one before, so
// as bars the later ones sit in front.
function chartLines(
  h: { daily: { views: number[]; visitors: number[]; new: number[] } } | undefined,
): Line[] {
  if (!h) return [];
  return [
    { values: h.daily.views, color: theme.stats.views, scale: "count" },
    { values: h.daily.visitors, color: theme.stats.visitors, scale: "count" },
    { values: h.daily.new, color: theme.stats.new, scale: "count" },
  ];
}

export function App() {
  const [query, setQuery] = createSignal(initialQuery());
  const [chart, setChart] = createSignal<ChartKind>(
    initialParams.get("chart") === "bars" ? "bars" : "line",
  );
  // The open host's stats, along with the query they answer. While a new
  // query loads, this (and everything drawn from it) keeps showing the last
  // one, so the panel's name, filters, numbers and chart all switch together.
  const view = createMemo(async () => {
    const q = query();
    return { q, overview: await fetchOverview(q) };
  });
  // Only refetched when the period changes.
  const days = createMemo(() => query().days);
  const summaries = createMemo(() => fetchSummaries(days()));
  // A new query is on its way: the panel fades a little until it lands.
  const updating = () => isPending(() => view());

  function update(change: Partial<Query>) {
    const next = { ...query(), ...change };
    setQuery(next);
    history.replaceState(null, "", `?${toParams(next, chart())}`);
  }

  function updateChart(kind: ChartKind) {
    setChart(kind);
    history.replaceState(null, "", `?${toParams(query(), kind)}`);
  }

  // Nothing is shown until both the sidebar and the panel have their first
  // numbers, so they arrive together.
  return (
    <Loading>
    <main>
      <nav class="sidebar">
        <div class="sidebar-top">
          <h1>Vigil</h1>
          {/* Shown like a total; the real select sits invisibly on top at
              normal size, so its native menu isn't oversized. */}
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
          {/* How the big chart is drawn. */}
          <div class="chart-kind" role="group" aria-label="Chart style">
            <For each={["line", "bars"] as const}>
              {(kind) => (
                <button
                  aria-pressed={chart() === kind ? "true" : "false"}
                  onClick={() => updateChart(kind)}
                >
                  {kind}
                </button>
              )}
            </For>
          </div>
        </div>

        {/* One entry per host; the open one is shown in full on the right. */}
        <Errored fallback={<p class="muted">Couldn't load hosts</p>}>
        <For each={HOSTS}>
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
                onClick={() => open() || update({ host: h.host, ref: null, page: null })}
              >
                <span class="host-name">{h.name}</span>
                <Show when={!empty()} fallback={<span class="muted">No stats yet</span>}>
                  <span class="host-nums">
                    <span style={{ color: theme.stats.views }}>{num(s()?.totals.views ?? 0)}</span>
                    <span style={{ color: theme.stats.visitors }}>
                      {num(s()?.totals.visitors ?? 0)}
                    </span>
                    <span style={{ color: theme.stats.new }}>{num(s()?.totals.new ?? 0)}</span>
                    <Chart
                      days={summaries().days}
                      lines={chartLines(s())}
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
            <p class="muted error">Couldn't load stats: {String((e() as Error)?.message ?? e())}</p>
          )}
        >
          <Stats
            bars={chart() === "bars"}
            name={HOSTS.find((h) => h.host === view().q.host)!.name}
            host={view().q.host}
            stats={view().overview.stats}
            days={view().overview.days}
            activeRef={view().q.ref}
            onSelectRef={(ref) => update({ ref })}
            activePage={view().q.page}
            onSelectPage={(page) => update({ page })}
          />
        </Errored>
      </section>
    </main>
    </Loading>
  );
}

// Totals and chart above, then pages and referrers side by side.
function Stats(props: {
  bars: boolean;
  name: string;
  host: string;
  stats: HostStats;
  days: number[];
  activeRef: string | null;
  onSelectRef: (ref: string | null) => void;
  activePage: string | null;
  onSelectPage: (page: string | null) => void;
}) {
  const t = () => props.stats.totals;
  const devices = () => t().devices;
  // One scale for every page's sparkline (across all pages of the list), so
  // their heights compare.
  const pageMax = () => {
    let max = 0;
    for (const p of props.stats.pages) for (const v of p.daily) if (v > max) max = v;
    return { count: max };
  };
  // The day hovered on the chart, whose numbers replace the period's.
  const [day, setDay] = createSignal<number | null>(null);
  const shown = (stat: "views" | "visitors" | "new") => {
    const i = day();
    return i === null ? t()[stat] : props.stats.daily[stat][i];
  };

  return (
    <div class="stats">
      <div class="stats-main">
        {/* Name and address on the left, totals on the right. */}
        <div class="stats-head">
          <div class="host-title">
            <h2>{props.name}</h2>
            <span class="host-url">
              {day() === null ? props.host : fullDate.format(props.days[day()!] * 1000)}
            </span>
          </div>
          {/* While a day is hovered: its numbers, and the rest (only known for
              the whole period) hidden. */}
          <div class={["totals", { "one-day": day() !== null }]}>
            <div>
              <div style={{ color: theme.stats.views }}>
                <div class="big">{num(shown("views"))}</div>
                <div class="big-label">Views</div>
              </div>
              <div class="sub stacked icons">
                <span title="Average scroll depth">
                  <PieIcon pct={t().avgScrollPct ?? 0} />{" "}
                  {t().avgScrollPct == null ? "–" : `${Math.round(t().avgScrollPct!)}%`}
                </span>
                <span title="Average time on page">
                  <ClockIcon /> {duration(t().avgEngagedS)}
                </span>
              </div>
            </div>
            <div>
              <div style={{ color: theme.stats.visitors }}>
                <div class="big">{num(shown("visitors"))}</div>
                <div class="big-label">Visitors</div>
              </div>
              <div class="sub stacked icons devices">
                <span title="Desktop">
                  <DeviceIcon w={14} h={9} /> {pct(devices().desktop, t().visitors)}%
                </span>
                <span title="Tablet">
                  <DeviceIcon w={10} h={12} /> {pct(devices().tablet, t().visitors)}%
                </span>
                <span title="Phone">
                  <DeviceIcon w={7} h={12} /> {pct(devices().mobile, t().visitors)}%
                </span>
              </div>
            </div>
            <div>
              <div style={{ color: theme.stats.new }}>
                <div class="big">{num(shown("new"))}</div>
                <div class="big-label">New visitors</div>
              </div>
              <div class="sub bounced" title="New visitors who viewed one page and never came back">
                <BounceIcon /> {num(t().newBounced)}
              </div>
            </div>
          </div>
        </div>

        <Chart
          days={props.days}
          lines={chartLines(props.stats)}
          height={160}
          headroom={40}
          lineWidth={2}
          bars={props.bars}
          dim={(c) => tint(c, theme.surface, 0.35)}
          onHover={setDay}
        />
      </div>

      <div class="lists">
        <div class="pages">
          <Paged items={props.stats.pages}>
            {(page) => (
              <PageItem
                page={page}
                days={props.days}
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
          active={props.activeRef}
          onSelect={props.onSelectRef}
        />
      </div>
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

// Referrers by visits. Clicking one filters everything to visits from it
// (or clears the filter); hovering the list swaps counts for sparklines.
function Referrers(props: {
  items: Referrer[];
  days: number[];
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

  return (
    <div class="referrers">
      <Paged items={props.items}>
        {(r) => {
          const on = () => props.active === r.domain;
          return (
            <div class={["referrer", { active: on() }]}>
              <button
                class="ref-name"
                title={on() ? "Clear filter" : `Only visits from ${r.domain}`}
                aria-pressed={on() ? "true" : "false"}
                onClick={() => props.onSelect(on() ? null : r.domain)}
              >
                {referrerName(r.domain)}
              </button>
              {/* Count, swapped for a sparkline while the list is hovered (CSS). */}
              <span class="ref-count" style={{ color: theme.stats.views }}>
                <span class="ref-num">{num(r.visits)}</span>
                <span class="ref-spark" aria-hidden="true">
                  <Chart
                    days={props.days}
                    lines={[{ values: r.daily, color: theme.stats.views, scale: "count" }]}
                    maxes={max()}
                    height={16}
                    lineWidth={1.25}
                  />
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
function Paged<T>(props: { items: T[]; size?: number; children: (item: T) => JSX.Element }) {
  const size = () => props.size ?? 10;
  const [page, setPage] = createSignal(0);
  const pages = () => Math.max(1, Math.ceil(props.items.length / size()));
  // Stay in range when the list shrinks (new period, filter or site).
  const current = () => Math.min(page(), pages() - 1);
  const start = () => current() * size();

  return (
    <>
      <div class="paged" style={{ "--rows": size() }}>
        <For each={props.items.slice(start(), start() + size())}>
          {(item) => props.children(item)}
        </For>
      </div>
      <div class="pager">
        <Show when={pages() > 1}>
          <For each={Array.from({ length: pages() }, (_, i) => i)}>
            {(i) => (
              <button
                class={{ current: i === current() }}
                aria-label={`Page ${i + 1} of ${pages()}`}
                aria-current={i === current() ? "page" : undefined}
                onClick={() => setPage(i)}
              />
            )}
          </For>
        </Show>
      </div>
    </>
  );
}

// A page with its views, visitors and new visitors, which give way to a
// sparkline of its daily views while the list is hovered (CSS). Clicking it
// filters everything else to that page (or clears the filter).
function PageItem(props: {
  page: PageRow;
  days: number[];
  max: Record<string, number>;
  active: boolean;
  onSelect: (page: string | null) => void;
}) {
  return (
    <button
      class={["row", { active: props.active }]}
      title={props.active ? "Clear filter" : `Only views of ${props.page.path}`}
      aria-pressed={props.active ? "true" : "false"}
      onClick={() => props.onSelect(props.active ? null : props.page.path)}
    >
      {/* "/posts/x/" shows as "posts/x"; the home page stays "/". */}
      <span class="label path">{props.page.path.replace(/^\/+|\/+$/g, "") || "/"}</span>
      <span class="num" style={{ color: theme.stats.views }}>
        {num(props.page.views)}
      </span>
      <span class="num" style={{ color: theme.stats.visitors }}>
        {num(props.page.visitors)}
      </span>
      <span class="num" style={{ color: theme.stats.new }}>
        {props.page.new > 0 ? num(props.page.new) : ""}
      </span>
      <span class="page-spark" aria-hidden="true">
        <Chart
          days={props.days}
          lines={[{ values: props.page.daily, color: theme.stats.views, scale: "count" }]}
          maxes={props.max}
          height={16}
          lineWidth={1.25}
        />
      </span>
    </button>
  );
}

// Tabler "arrow-bounce", stroked in the current text colour.
function BounceIcon() {
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
      aria-label="bounced"
    >
      <path d="M10 18h4" />
      <path d="M3 8a9 9 0 0 1 9 9v1l1.428 -4.285a12 12 0 0 1 6.018 -6.938l.554 -.277" />
      <path d="M15 6h5v5" />
    </svg>
  );
}

// Tabler "clock", stroked in the current text colour.
function ClockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

// Tabler "percentage" circle, with a slice filled clockwise from the top
// for `pct` (0-100).
function PieIcon(props: { pct: number }) {
  const slice = () => {
    const p = Math.min(100, Math.max(0, props.pct));
    if (p <= 0) return null;
    if (p >= 100) return "M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0 -18";
    const a = (p / 100) * 2 * Math.PI;
    const x = 12 + 9 * Math.sin(a);
    const y = 12 - 9 * Math.cos(a);
    return `M12 12V3A9 9 0 ${p > 50 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
  };
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show when={slice()}>{(d) => <path d={d()} fill="currentColor" stroke="none" />}</Show>
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
    </svg>
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
