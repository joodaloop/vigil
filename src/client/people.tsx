import { createMemo, For } from "solid-js";
import type { HostStats } from "../shared/types";
import { Chart, filled, peak } from "./Chart";
import { num, pct, perDevice } from "./format";
import { DeviceIcon, OsIcon } from "./icons";
import { theme } from "./theme";

// Visitors: their number and devices on one side and the countries they came
// from on the other, then their chart across the panel. While a day is
// hovered on the main chart (`day`, with `stats` as of it), the number and
// pages per device are that day's, and it's marked on the chart. Picking a
// country's flag filters by it (`onPick`), or if it's the one `picked`,
// clears that filter.
export function People(props: {
  host: string;
  stats: HostStats;
  days: number[];
  day: number | null; // the day hovered or pinned, marked on the chart
  pinned: number | null; // the day pinned (unix seconds), if any
  onHover: (i: number | null) => void;
  onPin: (day: number | null) => void;
  picked: string | null;
  onPick: (code: string | null) => void;
}) {
  const t = () => props.stats.totals;
  const devices = () => t().devices;
  // Devices, systems and countries are only known for the whole period, so
  // they're hidden while a day is (see .period-only).
  const dayShown = () => props.day !== null;
  // The chart's scale, the largest day of visitors seen on the host yet. A
  // number first, so hovering a day (new stats, the same days) leaves it be.
  const top = createMemo(() => peak(`${props.host} visitors`, Math.max(0, ...props.stats.daily.visitors)));
  const maxes = createMemo(() => ({ count: top() }));

  return (
    <div class="people">
      <div class="people-head">
        <div class="totals">
          <div class="beside">
            <div class="total" style={{ color: theme.stats.visitors }}>
              <div class="big">{num(t().visitors)}</div>
              <div class="big-label">Devices</div>
              <div class="sub">
                <span title="Page views per device">
                  {perDevice.format(t().visitors > 0 ? t().views / t().visitors : 0)} pages
                </span>
              </div>
            </div>
            {/* Each column most common first. */}
            <div class="sub stacked icons devices period-only" inert={dayShown()}>
              <For each={[...DEVICES].sort((a, b) => devices()[b.key] - devices()[a.key])}>
                {(d) => (
                  <span title={`${d.name}: ${pct(devices()[d.key], t().visitors)}%`}>
                    <DeviceIcon w={d.w} h={d.h} />
                    <Share part={devices()[d.key]} whole={t().visitors} />
                  </span>
                )}
              </For>
            </div>
            {/* Shares of the visitors whose OS is known. */}
            <div class="sub stacked icons systems period-only" inert={dayShown()}>
              <For each={[...SYSTEMS].sort((a, b) => t().systems[b[0]] - t().systems[a[0]])}>
                {([key, name]) => (
                  <span title={`${name}: ${pct(t().systems[key], t().systems.known)}%`}>
                    <OsIcon name={key} />
                    <Share part={t().systems[key]} whole={t().systems.known} />
                  </span>
                )}
              </For>
            </div>
          </div>
        </div>
        <div class="period-only" inert={dayShown()}>
          <Countries items={t().countries} picked={props.picked} onPick={props.onPick} />
        </div>
      </div>
      <Chart
        days={props.days}
        lines={filled(props.stats.daily.visitors, theme.stats.visitors)}
        maxes={maxes()}
        height={120}
        lineWidth={2}
        hoverDelay={50}
        onHover={props.onHover}
        pinned={props.pinned}
        onPin={props.onPin}
        marked={props.day}
      />
    </div>
  );
}

// A share as a bar, filled to that fraction of its width, with its percentage
// in the same place, shown instead while "." has switched the numbers to
// percentages.
function Share(props: { part: number; whole: number }) {
  return (
    <>
      <span
        class="bar main-form"
        style={{ "--fill": props.whole > 0 ? props.part / props.whole : 0 }}
        aria-hidden="true"
      />
      <span class="pct alt-form">{pct(props.part, props.whole)}%</span>
    </>
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
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
// A country's name by its code. Cloudflare also gives "T1" for Tor, which
// isn't a region code (DisplayNames throws on it), and "XX" for unknown.
function countryName(code: string) {
  if (code === "T1") return "Tor";
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// A row of flags for the countries visitors came from (the top 16), each with
// an area proportional to its visitors relative to the top one (at least 8px
// tall), and its name and numbers on hover. Each is a button that filters by
// its country, or if it's the one `picked`, clears that filter; the picked
// one is always there, smallest if no one came from it.
function Countries(props: {
  items: { code: string; visitors: number }[];
  picked: string | null;
  onPick: (code: string | null) => void;
}) {
  const shown = () => {
    const top = props.items.filter((c) => flag(c.code)).slice(0, 16);
    const p = props.picked;
    return p === null || !flag(p) || top.some((c) => c.code === p)
      ? top
      : [...top, { code: p, visitors: 0 }];
  };
  const total = () => props.items.reduce((n, c) => n + c.visitors, 0);
  return (
    <div class="countries">
      <For each={shown()}>
        {(c) => {
          const name = () => countryName(c.code);
          return (
            <button
              title={`${name()}: ${num(c.visitors)} visitors (${pct(c.visitors, total())}%)`}
              aria-pressed={c.code === props.picked ? "true" : "false"}
              onClick={() => props.onPick(c.code === props.picked ? null : c.code)}
            >
              <img
                src={flag(c.code)}
                alt={name()}
                height={Math.max(8, Math.round(40 * Math.sqrt(c.visitors / (shown()[0].visitors || 1))))}
              />
            </button>
          );
        }}
      </For>
    </div>
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
