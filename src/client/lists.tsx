import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { PageRow, Referrer } from "../shared/types";
import { referrerIcon, referrerName } from "../shared/referrers";
import { Chart } from "./Chart";
import { num, pct, share } from "./format";
import { SourceIcon } from "./icons";
import { theme } from "./theme";

// Pages by views, each a link to it.
export function Pages(props: { items: PageRow[]; host: string; days: number[] }) {
  return (
    <List
      class="pages"
      items={props.items}
      key={(p) => p.path}
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
  );
}

// Referrers by new visitors, then views, each a link to it.
export function Referrers(props: { items: Referrer[]; host: string; days: number[] }) {
  return (
    <List
      class="referrers"
      byNew
      items={props.items}
      key={(r) => r.source}
      days={props.days}
      label={(r) => (
        <a
          class="source-name"
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
  );
}

// Pages or referrers, as they come: each row its label (`label`), a
// sparkline of its daily views, its views and its new visitors, over a bar
// as long as its share of the list's views, or with `byNew`, of its new
// visitors.
function List<T extends { views: number; new: number; daily: number[] }>(props: {
  class: string;
  items: T[];
  key: (item: T) => string;
  byNew?: boolean;
  label: (item: T) => JSX.Element;
  days: number[];
}) {
  const viewsTotal = () => props.items.reduce((n, x) => n + x.views, 0);
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
                : share(x().views, viewsTotal()),
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
              <Count n={x().views} total={viewsTotal()} />
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
