import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// `scale` groups lines that share a y axis (e.g. "count", "ratio"); `area`
// draws it as a solid fill down to the baseline instead of a line, or with
// `light`, a light one (its colour must then be #rrggbb). Lines are drawn
// in order, later ones over earlier ones.
export type Line = { values: (number | null)[]; color: string; scale: string; area?: boolean; light?: boolean };

// A count's line over a fill in its colour, light or (unless `light`) solid.
export const filled = (values: (number | null)[], color: string, light = true): Line[] => [
    { values, color, scale: "count", area: true, light },
    { values, color, scale: "count" },
];

// The largest value seen on each key's charts this browser session, given
// the largest on them now: a scale's max that only ever grows, so the charts
// keep one scale as the period and filters change, and their heights compare.
// Kept in session storage, so it survives reloads; wherever that can't be
// used, for the page's life alone.
const PEAKS = "peaks";
const peaks: Record<string, number> = (() => {
    try {
        return JSON.parse(sessionStorage.getItem(PEAKS) ?? "{}");
    } catch {
        return {};
    }
})();
export function peak(key: string, max: number) {
    if (max <= (peaks[key] ?? 0)) return peaks[key] ?? 0;
    peaks[key] = max;
    try {
        sessionStorage.setItem(PEAKS, JSON.stringify(peaks));
    } catch {}
    return max;
}

// Top of a scale's 0..top range, given the largest value on it.
const scaleTop = (max: number) => (max > 0 ? max * 1.05 : 1);

// Padding above and below the plot, so thick lines along its top and bottom
// aren't clipped. None at the sides, where the lines run on past the ends
// (see the placeholder days), so the plot reaches the chart's edges.
const chartPadding = (lineWidth: number) => Math.ceil(lineWidth);

// A bare line chart: no axes, grid, legend or cursor. Lines on the same scale
// are drawn against one 0..max range; `maxes` pins a scale's max so several
// charts can be compared at the same scale.
//
// `headroom` adds empty space (px) above the plot, which still counts for
// hovering.
//
// Each chart draws a placeholder day past each end, repeating the end's
// values, so the lines run to the edges while the first and last real days
// sit clear of them.
//
// With `onHover`, hovering reports the index of the day nearest the pointer
// (never a placeholder); null once the pointer leaves. With `hoverDelay`, a
// mouse entering reports nothing until it comes to rest (stays still that
// many ms), so passing across the chart doesn't; moving between days after
// that is immediate, until it leaves.
//
// With `onPin` too, clicking a day reports it (unix seconds) to be pinned,
// or null if it's `pinned` already. The pin itself is kept by the caller,
// so several charts can share it.
//
// The chart marks `pinned` (if it has that day) with dots on the lines and a
// line down through it, or else `marked` (an index, e.g. the day hovered
// here or on another chart) with dots alone.
export function Chart(props: {
    days: number[];
    lines: Line[];
    height: number;
    lineWidth: number;
    maxes?: Record<string, number>;
    headroom?: number;
    onHover?: (i: number | null) => void;
    hoverDelay?: number;
    pinned?: number | null;
    onPin?: (day: number | null) => void;
    marked?: number | null;
}) {
    const height = () => props.height + (props.headroom ?? 0);
    let box!: HTMLDivElement; // the chart, with the hover overlay
    let el!: HTMLDivElement; // just uPlot's, so Solid never clears it when the overlay changes
    let plot: uPlot | undefined;
    // The hovered day, so moving within it doesn't report it again.
    let hovered: number | null = null;
    let hoverTimer: number | undefined;
    let mouseX: number | null = null;
    let hoverReady = false;

    function resetHoverDelay() {
        window.clearTimeout(hoverTimer);
        hoverTimer = undefined;
        mouseX = null;
        hoverReady = false;
    }
    // The pinned day's index, if it's among the days.
    const pinned = () => {
        const i = props.pinned == null ? -1 : props.days.indexOf(props.pinned);
        return i < 0 ? null : i;
    };
    // Where the hovered day is drawn, in px from the chart's top left: its x,
    // a dot per line, and how far the plot's baseline is above the chart's
    // bottom edge (its padding), where the day's line stops.
    const [mark, setMark] = createSignal<{
        x: number;
        dots: { y: number; color: string; ring: boolean }[];
        base: number;
        line: boolean; // the line down through the day too
    } | null>(null);

    function hover(i: number | null) {
        if (i === hovered) return;
        hovered = i;
        props.onHover?.(i);
    }

    // Marks day i, as drawn by `u`: dots on the lines, and with `line` (a
    // pinned day), a line down through it.
    function markDay(u: uPlot, i: number, line: boolean) {
        const b = box.getBoundingClientRect();
        const over = u.over.getBoundingClientRect();
        const top = over.top - b.top;
        setMark({
            x: over.left - b.left + u.valToPos(props.days[i], "x"),
            // A light fill has none (the line over it marks the day); a
            // solid one's is a ring, and goes over a line's at the same place.
            dots: props.lines
                .filter((l) => !l.light)
                .map((l) => ({ y: top + u.valToPos(l.values[i] ?? 0, l.scale), color: l.color, ring: !!l.area }))
                .sort((a, b) => Number(a.ring) - Number(b.ring)),
            base: b.bottom - over.bottom,
            line,
        });
    }

    // The day nearest the pointer, never a placeholder.
    function dayAt(u: uPlot, e: Pick<MouseEvent, "clientX">) {
        const over = u.over.getBoundingClientRect();
        return Math.max(0, Math.min(props.days.length - 1, u.posToIdx(e.clientX - over.left) - ends()));
    }

    // Reported even while a day is pinned (which the caller shows instead),
    // so the day under the pointer is known once it's unpinned.
    function showHover(clientX: number) {
        if (!plot || !props.onHover || props.days.length === 0) return;
        hover(dayAt(plot, { clientX }));
    }

    function onMove(e: PointerEvent) {
        if (!plot || !props.onHover || props.days.length === 0) return;
        if (e.pointerType === "mouse" && (props.hoverDelay ?? 0) > 0 && !hoverReady) {
            // Each move starts the wait over.
            mouseX = e.clientX;
            window.clearTimeout(hoverTimer);
            hoverTimer = window.setTimeout(() => {
                hoverTimer = undefined;
                hoverReady = true;
                if (mouseX !== null) showHover(mouseX);
            }, props.hoverDelay);
            return;
        }
        showHover(e.clientX);
    }

    function onLeave() {
        resetHoverDelay();
        hover(null);
    }

    function onClick(e: MouseEvent) {
        // A tap pins on lifting (see onUp); this is its click, if any.
        if (performance.now() - tappedAt < 1000) return;
        pin(e.clientX);
    }

    // Pins the day at clientX (moving the pin there if another is pinned),
    // or if it's the pinned one, unpins it, leaving it hovered. The day is
    // the click's or tap's own, not the hovered one.
    function pin(clientX: number) {
        if (!plot || !props.onPin || props.days.length === 0) return;
        resetHoverDelay();
        hoverReady = true;
        const i = dayAt(plot, { clientX });
        hover(i);
        props.onPin(pinned() === i ? null : props.days[i]);
    }

    // Touch and pen pin on lifting rather than on the click after: iOS
    // Safari drops a tap's click when the tap changes what's shown (as
    // marking its day does). A drag isn't a tap, and pins nothing.
    let tapX: number | null = null;
    let tappedAt = -Infinity;

    function onDown(e: PointerEvent) {
        tapX = e.pointerType === "mouse" ? null : e.clientX;
        onMove(e);
    }

    function onUp(e: PointerEvent) {
        if (tapX === null) return;
        const tap = Math.abs(e.clientX - tapX) < 10;
        tapX = null;
        if (!tap) return;
        tappedAt = performance.now();
        pin(e.clientX);
    }

    function onCancel() {
        tapX = null;
        onLeave();
    }

    // Marks the pinned day, or else the marked one, as drawn by `u`; after
    // every redraw (new data, a resize) too, where it now is.
    function remark(u: uPlot) {
        const p = pinned();
        if (p !== null) markDay(u, p, true);
        else if (props.marked != null && props.marked < props.days.length) markDay(u, props.marked, false);
        else setMark(null);
    }

    // Placeholder days, one before the first and one after the last: data
    // index i is day i - 1.
    const ends = () => (props.days.length > 0 ? 1 : 0);
    function padded(): (number | null)[][] {
        const days = props.days;
        if (!ends()) return [days, ...props.lines.map((l) => l.values)];
        const step = days.length > 1 ? days[1] - days[0] : 86400;
        return [
            [days[0] - step, ...days, days[days.length - 1] + step],
            ...props.lines.map((l) => [l.values[0], ...l.values, l.values[l.values.length - 1]]),
        ];
    }

    function build() {
        plot?.destroy();
        const scales: uPlot.Scales = { x: { time: true } };
        const series: uPlot.Series[] = [{}];
        for (const line of props.lines) {
            const fixed = props.maxes?.[line.scale];
            scales[line.scale] ??= {
                range: (_u, _min, max) => [0, scaleTop(fixed ?? max)],
            };
            // A fill reaches half a line's width below the baseline, as far
            // as a line along it does, so the two end level. (Its width,
            // though nothing's stroked, keeps uPlot from clipping it there.)
            series.push({
                scale: line.scale,
                stroke: line.area ? "transparent" : line.color,
                width: props.lineWidth,
                fillTo: line.area ? (u) => u.posToVal(u.valToPos(0, line.scale) + props.lineWidth / 2, line.scale) : undefined,
                fill: line.area ? (line.light ? `${line.color}26` : line.color) : undefined, // 26: 15% opaque
                points: { show: false },
            });
        }

        const pad = chartPadding(props.lineWidth);
        plot = new uPlot(
            {
                width: el.clientWidth,
                height: height(),
                padding: [pad + (props.headroom ?? 0), 0, pad, 0],
                scales,
                series,
                axes: [{ show: false }, { show: false }],
                legend: { show: false },
                cursor: { show: false },
                hooks: { draw: [remark] },
                select: { show: false, left: 0, top: 0, width: 0, height: 0 },
            },
            padded() as uPlot.AlignedData,
            el,
        );
    }

    onSettled(() => {
        const observer = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height: height() }));
        observer.observe(el);
        return () => {
            resetHoverDelay();
            observer.disconnect();
            plot?.destroy();
        };
    });

    // Follow `pinned` and `marked`.
    createEffect(
        () => [pinned(), props.marked],
        () => {
            if (plot) untrack(() => remark(plot!));
        },
    );

    // Rebuild whenever the data or the set of lines changes.
    createEffect(
        () => [props.days, props.lines, props.maxes, props.headroom, props.lineWidth, props.height],
        () => untrack(build),
    );

    return (
        <div
            ref={box}
            class={["chart", { hoverable: !!props.onHover, pinned: pinned() !== null }]}
            // At least the plot's height (before it's drawn too), or taller
            // if the page's styles lay the plot out in a line of text.
            style={{ "min-height": `${height()}px` }}
            // Touch: a finger down shows its day, dragging sideways moves
            // through days, lifting it (or a scroll taking over) clears it.
            onPointerEnter={onMove}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onLeave}
            onPointerCancel={onCancel}
            onClick={onClick}
        >
            <div ref={el} class="chart-plot" />
            <Show when={mark()}>
                {(m) => (
                    <>
                        <Show when={m().line}>
                            <div class="chart-day" style={{ left: `${m().x}px`, bottom: `${m().base}px` }} />
                        </Show>
                        <For each={m().dots}>
                            {(d) => (
                                <div
                                    class={["chart-dot", { ring: d.ring }]}
                                    style={{ left: `${m().x}px`, top: `${d.y}px`, "--color": d.color }}
                                />
                            )}
                        </For>
                    </>
                )}
            </Show>
        </div>
    );
}
