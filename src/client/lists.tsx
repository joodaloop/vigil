import { createMemo, createSignal, flush, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { PageRow, Referrer } from "../shared/types";
import { referrerIcon, referrerName } from "../shared/referrers";
import { Chart, filled, type Line } from "./Chart";
import { num, pct, share } from "./format";
import { SourceIcon } from "./icons";
import { onShortcut } from "./keys";
import { theme } from "./theme";

// Pages by views; picking one filters by it. The number keys pick its pages.
export function Pages(props: {
  items: PageRow[];
  rows: number; // the list's rows unfiltered, for its height
  maxes: Record<string, number>; // the sparklines' scale (see List)
  days: number[];
  engaged: boolean;
  picked: string | null;
  onPick: (path: string | null) => void;
}) {
  return (
    <List
      class="pages"
      maxes={props.maxes}
      pageKeys={[..."1234567890"]}
      items={props.items}
      rows={props.rows}
      key={(p) => p.path}
      blank={(path) => ({ path, ...noViews(props.days) })}
      days={props.days}
      engaged={props.engaged}
      picked={props.picked}
      onPick={props.onPick}
      label={(p) => {
        // "/posts/x/" shows as "/posts/x"; the home page stays "/".
        const path = p.path.replace(/(.)\/+$/, "$1");
        // Its title, if it's been read, with the path shown instead after
        // ",", without its leading "/" ("posts/x"; the home page stays "/").
        return p.title ? (
          <Swap text={p.title} address={path.replace(/^\/(.)/, "$1")} />
        ) : (
          <span class="label" title={path}>
            {path}
          </span>
        );
      }}
    />
  );
}

// Referrers by new visitors, then views; picking one filters by it. Each
// shows its address in place of its name after ",". The keys q to p pick
// its pages.
export function Referrers(props: {
  items: Referrer[];
  rows: number; // the list's rows unfiltered, for its height
  maxes: Record<string, number>; // the sparklines' scale (see List)
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
      maxes={props.maxes}
      pageKeys={[..."qwertyuiopasdfghjkl"]}
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
          <Swap text={r.name ?? referrerName(r.source)} address={address(r.source, props.host)} />
        </span>
      )}
    />
  );
}

// Pages or referrers, as they come: each row its label (`label`), a
// sparkline of its daily views (on `maxes`' scale), its views and its new visitors, over a bar
// as long as its share of the list's views, or with `byNew`, of its new
// visitors. In engaged mode (`engaged`), engaged views stand in for views,
// in bold, their sparklines show them filled solid under the views, and the bars are their shares
// (`byNew` too, as the rows are then ranked by them). Each row is a button that filters by it (`onPick` with its
// key), or if it's the one `picked`, clears that filter. The picked row is
// always there to clear it: one with no views (`blank`) if it's not in
// `items` (nothing in the period). Filtered down to it, it stays where it
// was on its page when it was clicked, rather than moving up to the top.
function List<T extends { views: number; new: number; reads: number; daily: number[]; dailyReads: number[] }>(props: {
  class: string;
  maxes: Record<string, number>;
  items: T[];
  rows: number; // its rows unfiltered: it's at least as tall as that many, up to a page
  key: (item: T) => string;
  blank: (key: string) => T;
  byNew?: boolean;
  pageKeys?: string[];
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
  // Worked out once for the list, not for each row that reads them.
  const items = createMemo(() =>
    props.picked === null || props.items.some((x) => props.key(x) === props.picked)
      ? props.items
      : [props.blank(props.picked), ...props.items],
  );
  const viewsTotal = createMemo(() => items().reduce((n, x) => n + views(x), 0));
  const newTotal = createMemo(() => items().reduce((n, x) => n + x.new, 0));
  return (
    <div class={props.class}>
      <Paged items={items()} key={props.key} offset={offset()} minRows={props.rows} pageKeys={props.pageKeys}>
        {(x) => {
          // The row's sparkline, only new when its series are (not when a
          // day is hovered, which leaves them be) or engaged mode changes; a
          // new one redraws it.
          const viewSeries = createMemo(() => x().daily);
          const readSeries = createMemo(() => (props.engaged ? x().dailyReads : null));
          const lines = createMemo(() => sparkline(viewSeries(), readSeries()));
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
                  maxes={props.maxes}
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

// Views as a line over a light fill, and given `reads` (engaged mode),
// engaged views filled solid between the two.
export function viewLines(views: number[], reads: number[] | null): Line[] {
  const [fill, line] = filled(views, theme.stats.views);
  return reads ? [fill, { values: reads, color: theme.stats.views, scale: "count", area: true }, line] : [fill, line];
}

// A sparkline's lines (see viewLines).
export const sparkline = viewLines;

// A source's address, without its scheme: a page on the site itself
// ("blog.example/posts/x"), or the referring site ("someblog.com").
const address = (source: string, host: string) => (source.startsWith("/") ? host + source : source);

// A row's name (`text`), and in the same place, shown instead while ","
// has switched the lists to addresses (.address), its address or path
// (`address`); each cut short if it has to be, so the address is its tooltip
// too.
function Swap(props: { text: string; address: string }) {
  return (
    <span class="label swap" title={props.address}>
      <span>{props.text}</span>
      <span class="address-form">{props.address}</span>
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

// Shows `items` 10 at a time, with a row of page buttons when there are
// more, each labelled with its key from `pageKeys` (or its number).
// The list keeps a full page's height (or `minRows`' height, if fewer), dots
// included, however few items there are. Rows are matched by `key`, so one stays the same element as its
// data changes. Whenever the rows come in another order (a day hovered,
// another site or period), it's back to the first page. `offset` leaves that
// many empty rows above the first.
// From a row, the up and down arrows move to the row above and below, on
// through to the pages before and after. The page buttons are one tab stop,
// the current page's: the up and down arrows move between pages from there
// (left and right are the main chart's). Anywhere on the page but a text
// field, the nth of `pageKeys` picks the nth page, if there is one ("" for
// none), and focuses its first row.
function Paged<T>(props: {
  items: T[];
  size?: number;
  key: (item: T) => string;
  offset?: number; // empty rows above the first
  minRows?: number; // the fewest rows' height it takes, up to a page (all of one, by default)
  pageKeys?: string[];
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
  let rows!: HTMLDivElement;
  const onRowKey = (e: KeyboardEvent) => {
    const by = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (by === undefined || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const shown = [...rows.children] as HTMLElement[];
    const at = shown.indexOf((e.target as Element).closest(".paged > *") as HTMLElement);
    if (at < 0) return;
    e.preventDefault(); // or the arrows would scroll the page
    const to = at + by;
    if (to >= 0 && to < shown.length) return shown[to].focus();
    // Past the page's first or last row: the next page's first, or the
    // previous page's last.
    const page = current() + by;
    if (page < 0 || page >= pages()) return;
    setPage(page);
    flush(); // so the page's rows are there to focus
    const next = (by > 0 ? rows.firstElementChild : rows.lastElementChild) as HTMLElement | null;
    next?.focus();
  };
  const onPagerKey = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
    const by = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (by === undefined || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault(); // or the arrows would scroll the page
    const next = Math.max(0, Math.min(current() + by, pages() - 1));
    setPage(next);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  onShortcut((e) => {
    if (e.shiftKey || e.repeat || !props.pageKeys) return;
    const page = props.pageKeys.indexOf(e.key);
    if (page < 0 || page >= pages()) return;
    setPage(page);
    flush(); // so the page's rows are there to focus
    (rows.firstElementChild as HTMLElement | null)?.focus();
  });

  return (
    <>
      <div ref={rows} class="paged" onKeyDown={onRowKey} style={{ "--rows": Math.min(size(), props.minRows ?? size()), "--offset": props.offset ?? 0 }}>
        <For each={props.items.slice(start(), start() + size())} keyed={props.key}>
          {(item) => props.children(item)}
        </For>
      </div>
      <div class="pager" onKeyDown={onPagerKey}>
        <Show when={pages() > 1}>
          <For each={Array.from({ length: pages() }, (_, i) => i)}>
            {(i) => (
              <button
                class={{ current: i === current() }}
                aria-label={`Page ${i + 1} of ${pages()}`}
                aria-current={i === current() ? "page" : undefined}
                tabindex={i === current() ? 0 : -1}
                onClick={() => setPage(i)}
              >
                {props.pageKeys?.[i] ?? i + 1}
              </button>
            )}
          </For>
        </Show>
      </div>
    </>
  );
}

// A list's number, with its share of the list's total in the same place,
// shown instead once "." switches to percentages. `blankZero` leaves both
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
