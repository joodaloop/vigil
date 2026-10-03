import { createResource, createSignal, For, Show, type JSX } from "solid-js";
import type { HostStats, Overview } from "../shared/types";
import { Chart, lowestPointOffset, type Line } from "./Chart";
import { DEFAULT_PERIOD, PERIODS, SITES } from "./config";
import { referrerName } from "./referrers";
import { theme } from "./theme";

type Query = { site: string; days: number; ref: string | null };

function initialQuery(): Query {
    const params = new URLSearchParams(location.search);
    const n = Number(params.get("days"));
    const site = params.get("site");
    return {
        site: SITES.some((s) => s.site === site) ? site! : SITES[0].site,
        days: PERIODS.includes(n) ? n : DEFAULT_PERIOD,
        ref: params.get("ref") || null,
    };
}

function toParams(q: Query) {
    const params = new URLSearchParams({ site: q.site, days: String(q.days) });
    if (q.ref) params.set("ref", q.ref);
    return params;
}

async function fetchOverview(q: Query): Promise<Overview> {
    const params = toParams(q);
    const r = await fetch(`/api/overview?${params}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
}

// 950 -> "950", 4321 -> "4.3k", 17694 -> "17.7k", 1250000 -> "1.3M"
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const num = (n: number) => compact.format(n).replace("K", "k");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function duration(s: number | null) {
    if (s === null) return "–";
    return `${Math.round(s)}s`;
}

function chartLines(h: { daily: { views: number[]; visitors: number[]; new: number[] } } | undefined): Line[] {
    if (!h) return [];
    return [
        { values: h.daily.views, color: theme.stats.views, scale: "count" },
        { values: h.daily.visitors, color: theme.stats.visitors, scale: "count" },
        { values: h.daily.new, color: theme.stats.new, scale: "count" },
    ];
}

const SUMMARY_CHART = { height: 260, lineWidth: 2.5 };
const LEGEND_NUDGE = 2; // px

export function App() {
    const [query, setQuery] = createSignal(initialQuery());
    const [data] = createResource(query, fetchOverview);
    const hosts = () => SITES.find((s) => s.site === query().site)!.hosts;

    // One scale for every referrer sparkline (across all pages of the list),
    // so their heights compare.
    const referrerMax = () => {
        let max = 0;
        for (const r of data.latest?.referrers ?? []) for (const v of r.daily) if (v > max) max = v;
        return { count: max };
    };

    function update(change: Partial<Query>) {
        const next = { ...query(), ...change };
        setQuery(next);
        history.replaceState(null, "", `?${toParams(next)}`);
    }

    // One max across all host charts, so they're drawn at the same scale.
    const maxes = () => {
        let max = 0;
        for (const { host } of hosts()) {
            for (const line of chartLines(data.latest?.hosts[host])) {
                for (const v of line.values) if (v !== null && v > max) max = v;
            }
        }
        return { count: max };
    };

    const site = () => data.latest?.site;

    // Lift the legend so its last row is level with the chart's lowest point.
    // 0.725em is half a line (line-height 1.45), so the row's middle lines up;
    // LEGEND_NUDGE raises it a little further, which reads better by eye.
    const legendPadding = () => {
        const offset = lowestPointOffset(chartLines(site()), SUMMARY_CHART.height, SUMMARY_CHART.lineWidth);
        return offset === null ? undefined : `max(0px, calc(${offset + LEGEND_NUDGE}px - 0.725em))`;
    };

    return (
        <main>
            <div class="top">
                <Show when={data.error}>
                    <p class="muted">Couldn't load stats: {String(data.error?.message ?? data.error)}</p>
                </Show>

                <section class="summary">
                    <div class="summary-side">
                        <div class="controls">
                            <Show when={SITES.length > 1}>
                                <div class="period">
                                    <span class="period-picker site-picker">
                                        <span aria-hidden="true">{query().site}</span>
                                        <select
                                            id="site"
                                            aria-label="Site"
                                            value={query().site}
                                            onChange={(e) => update({ site: e.currentTarget.value, ref: null })}
                                        >
                                            <For each={SITES}>{(s) => <option value={s.site}>{s.site}</option>}</For>
                                        </select>
                                    </span>
                                </div>
                            </Show>
                            <div class="period">
                                <label for="period">
                                    <CalendarIcon />
                                </label>
                                {/* The visible text is a span; the real select sits invisibly on
                                    top at normal size, so its native menu isn't oversized. */}
                                <span class="period-picker">
                                    <span aria-hidden="true">{query().days} days</span>
                                    <select
                                        id="period"
                                        value={query().days}
                                        onChange={(e) => update({ days: Number(e.currentTarget.value) })}
                                    >
                                        <For each={PERIODS}>{(n) => <option value={n}>{n} days</option>}</For>
                                    </select>
                                </span>
                            </div>
                        </div>

                        <div class="legend" style={{ "padding-bottom": legendPadding() }}>
                            <div style={{ color: theme.stats.views }}>
                                <span>Views</span> <b>{num(site()?.totals.views ?? 0)}</b>
                            </div>
                            <div style={{ color: theme.stats.visitors }}>
                                <span>Visitors</span> <b>{num(site()?.totals.visitors ?? 0)}</b>
                            </div>
                            <div style={{ color: theme.stats.new }}>
                                <span>New visitors</span> <b>{num(site()?.totals.new ?? 0)}</b>
                            </div>
                        </div>
                    </div>

                    <Chart
                        days={data.latest?.days ?? []}
                        lines={chartLines(site())}
                        height={SUMMARY_CHART.height}
                        lineWidth={SUMMARY_CHART.lineWidth}
                    />

                    <div class="referrers">
                        <Paged items={data.latest?.referrers ?? []}>
                            {(r) => {
                                const on = () => query().ref === r.domain;
                                return (
                                    <div class="referrer" classList={{ active: on() }}>
                                        <button
                                            class="ref-name"
                                            title={on() ? "Clear filter" : `Only visits from ${r.domain}`}
                                            aria-pressed={on()}
                                            onClick={() => update({ ref: on() ? null : r.domain })}
                                        >
                                            {referrerName(r.domain)}
                                        </button>
                                        {/* Count, swapped for a sparkline while the list is hovered (CSS). */}
                                        <span class="ref-count" style={{ color: theme.stats.views }}>
                                            <span class="ref-num">{num(r.visits)}</span>
                                            <span class="ref-spark" aria-hidden="true">
                                                <Chart
                                                    days={data.latest?.days ?? []}
                                                    lines={[{ values: r.daily, color: theme.stats.views, scale: "count" }]}
                                                    maxes={referrerMax()}
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
                </section>
            </div>

            <div class="hosts">
                <For each={hosts()}>
                    {(h) => (
                        <HostPanel
                            name={h.name}
                            host={h.host}
                            stats={data.latest?.hosts[h.host]}
                            days={data.latest?.days ?? []}
                            maxes={maxes()}
                        />
                    )}
                </For>
            </div>
        </main>
    );
}

function HostPanel(props: {
    name: string;
    host: string;
    stats: HostStats | undefined;
    days: number[];
    maxes: Record<string, number>;
}) {
    const t = () => props.stats?.totals;
    const devices = () => t()?.devices ?? { desktop: 0, tablet: 0, mobile: 0 };

    return (
        <section class="host">
            <div class="host-title">
                <h2>{props.name}</h2>
                <span class="host-url" title={props.host}>
                    {props.host}
                </span>
            </div>

            <div class="totals">
                <div>
                    <div style={{ color: theme.stats.views }}>
                        <div class="big">{num(t()?.views ?? 0)}</div>
                        <div class="big-label">Views</div>
                    </div>
                    <div class="sub stacked">
                        <span title="Average scroll depth">
                            {t()?.avgScrollPct == null ? "–" : `${Math.round(t()!.avgScrollPct!)}%`}
                        </span>
                        <span title="Average time on page">{duration(t()?.avgEngagedS ?? null)}</span>
                    </div>
                </div>
                <div>
                    <div style={{ color: theme.stats.visitors }}>
                        <div class="big">{num(t()?.visitors ?? 0)}</div>
                        <div class="big-label">Visitors</div>
                    </div>
                    <div class="sub stacked devices">
                        <span title="Desktop">
                            <DeviceIcon w={14} h={9} /> {pct(devices().desktop, t()?.visitors ?? 0)}%
                        </span>
                        <span title="Tablet">
                            <DeviceIcon w={10} h={12} /> {pct(devices().tablet, t()?.visitors ?? 0)}%
                        </span>
                        <span title="Phone">
                            <DeviceIcon w={7} h={12} /> {pct(devices().mobile, t()?.visitors ?? 0)}%
                        </span>
                    </div>
                </div>
                <div>
                    <div style={{ color: theme.stats.new }}>
                        <div class="big">{num(t()?.new ?? 0)}</div>
                        <div class="big-label">New visitors</div>
                    </div>
                    <div class="sub bounced" title="New visitors who viewed one page and never came back">
                        <BounceIcon /> {num(t()?.newBounced ?? 0)}
                    </div>
                </div>
            </div>

            <Chart days={props.days} lines={chartLines(props.stats)} maxes={props.maxes} height={160} lineWidth={2} />

            <div class="pages">
                <Paged items={props.stats?.pages ?? []}>
                    {(page) => (
                        <Row
                            label={page.path}
                            views={page.views}
                            new={page.new}
                            level={0}
                            nested={() => (
                                <For each={page.sources}>
                                    {(source) => (
                                        <Row
                                            label={source.kind === "referrer" ? referrerName(source.label) : source.label}
                                            views={source.views}
                                            new={source.new}
                                            level={1}
                                            nested={
                                                source.children.length > 0
                                                    ? () => (
                                                          <For each={source.children}>
                                                              {(c) => (
                                                                  <Row label={c.path} views={c.views} new={c.new} level={2} />
                                                              )}
                                                          </For>
                                                      )
                                                    : undefined
                                            }
                                        />
                                    )}
                                </For>
                            )}
                        />
                    )}
                </Paged>
            </div>
        </section>
    );
}

// Shows `items` 10 at a time, with a row of page dots when there are more.
function Paged<T>(props: { items: T[]; size?: number; children: (item: T) => JSX.Element }) {
    const size = () => props.size ?? 10;
    const [page, setPage] = createSignal(0);
    const pages = () => Math.max(1, Math.ceil(props.items.length / size()));
    // Stay in range when the list shrinks (new period, filter or site).
    const current = () => Math.min(page(), pages() - 1);
    const start = () => current() * size();

    return (
        <>
            <For each={props.items.slice(start(), start() + size())}>{(item) => props.children(item)}</For>
            <Show when={pages() > 1}>
                <div class="pager">
                    <For each={Array.from({ length: pages() }, (_, i) => i)}>
                        {(i) => (
                            <button
                                classList={{ current: i === current() }}
                                aria-label={`Page ${i + 1} of ${pages()}`}
                                aria-current={i === current() ? "page" : undefined}
                                onClick={() => setPage(i)}
                            />
                        )}
                    </For>
                </div>
            </Show>
        </>
    );
}

// A list row. With `nested`, clicking it shows or hides the rows beneath it
// (rendered only while open).
function Row(props: { label: string; views: number; new: number; level: number; nested?: () => JSX.Element }) {
    const [open, setOpen] = createSignal(false);
    const cells = () => (
        <>
            <span class="label" title={props.label} style={{ "padding-left": `${props.level * 1.25}rem` }}>
                <Path text={props.label} />
            </span>
            <span class="num" style={{ color: theme.stats.views }}>
                {num(props.views)}
            </span>
            <span class="num" style={{ color: theme.stats.new }}>
                {props.new > 0 ? num(props.new) : ""}
            </span>
        </>
    );

    return (
        <Show when={props.nested} fallback={<div class="row" classList={{ inner: props.level > 0 }}>{cells()}</div>}>
            {(nested) => (
                <>
                    <button
                        class="row expandable"
                        classList={{ inner: props.level > 0 }}
                        aria-expanded={open()}
                        onClick={() => setOpen(!open())}
                    >
                        {cells()}
                    </button>
                    <Show when={open()}>{nested()()}</Show>
                </>
            )}
        </Show>
    );
}

// Page paths are monospace; other labels (referrers, "Direct") are plain.
function Path(props: { text: string }) {
    return (
        <Show when={props.text.startsWith("/")} fallback={props.text}>
            {/* "/posts/x/" shows as "posts/x"; the home page stays "/". */}
            <span class="path">{props.text.replace(/^\/+|\/+$/g, "") || "/"}</span>
        </Show>
    );
}

// Tabler "calendar-time", stroked in the current text colour. It labels the
// period select, so it carries the accessible name.
function CalendarIcon() {
    return (
        <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            role="img"
        >
            <title>Time period</title>
            <path d="M11.795 21h-6.795a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v4" />
            <path d="M14 18a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
            <path d="M15 3v4" />
            <path d="M7 3v4" />
            <path d="M3 11h16" />
            <path d="M18 16.496v1.504l1 1" />
        </svg>
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

function DeviceIcon(props: { w: number; h: number }) {
    return (
        <svg width={props.w + 2} height={props.h + 2} viewBox={`0 0 ${props.w + 2} ${props.h + 2}`} aria-hidden="true">
            <rect x="1" y="1" width={props.w} height={props.h} rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
    );
}
