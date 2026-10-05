import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { PageRow, Referrer } from "../shared/types";
import { referrerIcon, referrerName } from "../shared/referrers";
import { Chart, type Line } from "./Chart";
import { num, pct, share } from "./format";
import { SourceIcon } from "./icons";
import { theme } from "./theme";

// Pages by views; picking one filters by it.
export function Pages(props: {
  items: PageRow[];
  rows: number; // the list's rows unfiltered, for its height
  days: number[];
  engaged: boolean;
  picked: string | null;
  onPick: (path: string | null) => void;
}) {
  return (
    <List
      class="pages"
      items={props.items}
      rows={props.rows}
      key={(p) => p.path}
      blank={(path) => ({ path, ...noViews(props.days) })}
      days={props.days}
      engaged={props.engaged}
      picked={props.picked}
      onPick={props.onPick}
      label={(p) => {
        // "/posts/x/" shows as "posts/x"; the home page stays "/".
        const path = p.path.replace(/^\/+|\/+$/g, "") || "/";
        // Its title, if it's been read, with the path shown instead while
        // hovered.
        return p.title ? (
          <Swap text={p.title} hover={path} />
        ) : (
          <span class="label">{path}</span>
        );
      }}
    />
  );
}

// Referrers by new visitors, then views; picking one filters by it. Each
// shows its address in place of its name while hovered.
export function Referrers(props: {
  items: Referrer[];
  rows: number; // the list's rows unfiltered, for its height
  host: string;
  icon?: number; // the site's saved favicon's version, for its own pages
  days: number[];
  engaged: boolean;
  picked: string | null;
  onPick: (source: string | null) => void;
}) {
  return (
    <List
      class="referrers"
      byNew
      items={props.items}
      rows={props.rows}
      key={(r) => r.source}
      blank={(source) => ({ source, ...noViews(props.days) })}
      days={props.days}
      engaged={props.engaged}
      picked={props.picked}
      onPick={props.onPick}
      label={(r) => (
        <span class="source-name">
          {/* A page of the site itself shows the site's icon. */}
          <SourceIcon
            name={referrerIcon(r.source)}
            site={r.source.startsWith("/") ? props.host : r.source}
            saved={r.source.startsWith("/") ? props.icon : r.icon}
          />
          <Swap text={r.name ?? referrerName(r.source)} hover={address(r.source, props.host)} />
        </span>
      )}
    />
  );
}

// Pages or referrers, as they come: each row its label (`label`), a
// sparkline of its daily views, its views and its new visitors, over a bar
// as long as its share of the list's views, or with `byNew`, of its new
// visitors. In engaged mode (`engaged`), engaged views stand in for views,
// in bold, their sparklines filled solid, and the bars are their shares
// (`byNew` too, as the rows are then ranked by them). Each row is a button that filters by it (`onPick` with its
// key), or if it's the one `picked`, clears that filter. The picked row is
// always there to clear it: one with no views (`blank`) if it's not in
// `items` (nothing in the period). Filtered down to it, it stays where it
// was on its page when it was clicked, rather than moving up to the top.
function List<T extends { views: number; new: number; reads: number; daily: number[]; dailyReads: number[] }>(props: {
  class: string;
  items: T[];
  rows: number; // its rows unfiltered: it's at least as tall as that many, up to a page
  key: (item: T) => string;
  blank: (key: string) => T;
  byNew?: boolean;
  label: (item: T) => JSX.Element;
  days: number[];
  engaged: boolean;
  picked: string | null;
  onPick: (key: string | null) => void;
}) {
  // Where the row clicked to filter by sat on its page, and while the list
  // is filtered down to it, the rows to leave empty above it.
  const [clicked, setClicked] = createSignal<{ key: string; slot: number } | null>(null);
  const offset = () => {
    const c = clicked();
    return c && c.key === props.picked && items().length === 1 ? c.slot : 0;
  };
  const views = (x: T) => (props.engaged ? x.reads : x.views);
  const byNew = () => props.byNew && !props.engaged;
  const daily = (x: T) => (props.engaged ? x.dailyReads : x.daily);
  // Worked out once for the list, not for each row that reads them.
  const items = createMemo(() =>
    props.picked === null || props.items.some((x) => props.key(x) === props.picked)
      ? props.items
      : [props.blank(props.picked), ...props.items],
  );
  const viewsTotal = createMemo(() => items().reduce((n, x) => n + views(x), 0));
  const newTotal = createMemo(() => items().reduce((n, x) => n + x.new, 0));
  // One scale for every sparkline (across all pages of the list), so their
  // heights compare. A number first, so the scale only changes (and the
  // sparklines are only redrawn) when it does: hovering a day leaves it be.
  const maxCount = createMemo(() => {
    let max = 0;
    for (const x of items()) for (const v of daily(x)) if (v > max) max = v;
    return max;
  });
  const maxes = createMemo(() => ({ count: maxCount() }));
  return (
    <div class={props.class}>
      <Paged items={items()} key={props.key} offset={offset()} minRows={props.rows}>
        {(x) => {
          // The row's sparkline, only new when its series is (not when a day
          // is hovered, which leaves it be) or engaged mode changes; a new
          // one redraws it.
          const series = createMemo(() => daily(x()));
          const lines = createMemo(() => sparkline(series(), props.engaged));
          return (
            <button
              class={["row", { "by-new": byNew() }]}
              aria-pressed={props.key(x()) === props.picked ? "true" : "false"}
              onClick={(e) => {
                const key = props.key(x());
                if (key === props.picked) return props.onPick(null);
                const row = e.currentTarget;
                setClicked({ key, slot: [...row.parentElement!.children].indexOf(row) });
                props.onPick(key);
              }}
              style={{
                "--share": byNew()
                  ? share(x().new, newTotal())
                  : share(views(x()), viewsTotal()),
              }}
            >
              {props.label(x())}
              <span class="spark" aria-hidden="true">
                <Chart
                  days={props.days}
                  lines={lines()}
                  maxes={maxes()}
                  height={22}
                  lineWidth={1.25}
                />
              </span>
              <span class={["num", { engaged: props.engaged }]} style={{ color: theme.stats.views }}>
                <Count n={views(x())} total={viewsTotal()} />
              </span>
              <span class="num" style={{ color: theme.stats.new }}>
                <Count n={x().new} total={newTotal()} blankZero />
              </span>
            </button>
          );
        }}
      </Paged>
    </div>
  );
}

// A sparkline's lines: views as a line, or engaged views filled solid.
export const sparkline = (values: number[], engaged: boolean): Line[] => [
  { values, color: theme.stats.views, scale: "count" },
  ...(engaged ? [{ values, color: theme.stats.views, scale: "count", area: true }] : []),
];

// A source's address, without its scheme: a page on the site itself
// ("blog.example/posts/x"), or the referring site ("someblog.com").
const address = (source: string, host: string) => (source.startsWith("/") ? host + source : source);

// A row's name (`text`), and in the same place, shown instead while the row
// is hovered, its address or path (`hover`); each cut short if it has to be.
function Swap(props: { text: string; hover: string }) {
  return (
    <span class="label swap">
      <span>{props.text}</span>
      <span class="on-hover">{props.hover}</span>
    </span>
  );
}

// A row's numbers, with none on any of `days`.
const noViews = (days: number[]) => ({
  views: 0,
  new: 0,
  reads: 0,
  daily: days.map(() => 0),
  dailyNew: days.map(() => 0),
  dailyReads: days.map(() => 0),
});

// Shows `items` 10 at a time, with a row of page dots when there are more.
// The list keeps a full page's height (or `minRows`' height, if fewer), dots
// included, however few items there are. Rows are matched by `key`, so one stays the same element as its
// data changes. Whenever the rows come in another order (a day hovered,
// another site or period), it's back to the first page. `offset` leaves that
// many empty rows above the first.
// The page buttons are one tab stop, the current page's: arrow keys, Home
// and End move between pages from there.
function Paged<T>(props: {
  items: T[];
  size?: number;
  key: (item: T) => string;
  offset?: number; // empty rows above the first
  minRows?: number; // the fewest rows' height it takes, up to a page (all of one, by default)
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
      <div class="paged" style={{ "--rows": Math.min(size(), props.minRows ?? size()), "--offset": props.offset ?? 0 }}>
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
// shown instead once space switches to percentages. `blankZero` leaves both
// empty for none.
function Count(props: { n: number; total: number; blankZero?: boolean }) {
  return (
    <Show when={!props.blankZero || props.n > 0}>
      <span class="count">
        <span class="main-form">{num(props.n)}</span>
        <span class="alt-form">{pct(props.n, props.total)}%</span>
      </span>
    </Show>
  );
}
