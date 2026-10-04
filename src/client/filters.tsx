import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { HostStats } from "../shared/types";
import { referrerIcon, referrerName } from "../shared/referrers";
import { SourceIcon } from "./icons";
import { countryName, flag } from "./people";

// Each filter's pick, or null for none.
export type Filters = {
  country: string | null; // an ISO code
  page: string | null; // a path
  source: string | null; // a referring site's domain, or a page's path
};

// The filters' menus, by country, page and referrer, in any combination.
// Their options are the unfiltered `options`' rows; those also in the
// filtered `stats` come first.
export function FilterMenus(props: {
  stats: HostStats;
  options: HostStats;
  filters: Filters;
  onFilter: (change: Partial<Filters>) => void;
}) {
  // What's in the filtered view; null without filters, when that's
  // everything.
  const within = <T,>(items: T[], key: (item: T) => string) =>
    props.stats === props.options ? null : new Set(items.map(key));
  return (
    <div class="filters">
      <FilterSelect
        label="Country"
        all="All countries"
        value={props.filters.country}
        onChange={(country) => props.onFilter({ country })}
        others="Other countries"
        options={props.options.totals.countries.map((c) => ({
          value: c.code,
          text: countryName(c.code),
        }))}
        within={within(props.stats.totals.countries, (c) => c.code)}
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
        options={props.options.referrers.map((r) => ({ value: r.source, text: referrerName(r.source) }))}
        within={within(props.stats.referrers, (r) => r.source)}
        // Its icon then its name, as in the list.
        show={(source) =>
          source ? (
            <span class="source-name">
              <SourceIcon name={referrerIcon(source)} />
              {referrerName(source)}
            </span>
          ) : (
            "All referrers"
          )
        }
      />
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
