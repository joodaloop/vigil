import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import uPlot from "uplot";
import { onShortcut } from "./keys";
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

// Top of a scale's 0..top range, given the largest value on it.
const scaleTop = (max: number) => (max > 0 ? max * 1.05 : 1);

// Padding around the plot, so thick lines at the edges aren't clipped.
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
// With `onHover`, hovering marks the day nearest the pointer (never a
// placeholder) with dots on the lines, and reports its index; null once the
// pointer leaves. With `hoverDelay`, a mouse entering marks nothing until it
// comes to rest (stays still that many ms), so passing across the chart
// doesn't; moving between days after that is immediate, until it leaves. Clicking pins the day, adding a line down through it: it
// stays marked and reported, whatever the pointer does, until another day is
// clicked (pinning that one instead), it is clicked again, or the days
// change to ones without it (another period that doesn't reach it); unless
// `pinnable` is false, when clicks are left alone. While a day is pinned,
// the left and right arrows move the pin to the day before and after (round
// from one end to the other); while
// none is, right pins the first day and left the last. Escape unpins it.
//
// `marked` marks a day chosen elsewhere (e.g. on another chart) with dots
// on the lines alone.
export function Chart(props: {
    days: number[];
    lines: Line[];
    height: number;
    lineWidth: number;
    maxes?: Record<string, number>;
    headroom?: number;
    onHover?: (i: number | null) => void;
    hoverDelay?: number;
    pinnable?: boolean;
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
    // The day pinned by a click, if any: its index, and the day itself (unix
    // seconds), to find it again among other days.
    const [pinned, setPinned] = createSignal<number | null>(null);
    let pinnedDay: number | null = null;
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
            // A fill's dot is a ring, and goes over a line's at the same
            // place (the line along its top edge).
            dots: props.lines
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

    function showHover(clientX: number) {
        if (!plot || !props.onHover || props.days.length === 0 || pinned() !== null) return;
        const i = dayAt(plot, { clientX });
        markDay(plot, i, false);
        hover(i);
    }

    function onMove(e: PointerEvent) {
        if (!plot || !props.onHover || props.days.length === 0 || pinned() !== null) return;
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
        if (pinned() !== null) return;
        setMark(null);
        hover(null);
    }

    function onClick(e: MouseEvent) {
        // A tap pins on lifting (see onUp); this is its click, if any.
        if (performance.now() - tappedAt < 1000) return;
        pin(e.clientX);
    }

    // Pins the day at clientX (moving the pin there if another is pinned),
    // or if it's the pinned one, unpins it and goes back to following the
    // pointer. The day is the click's or tap's own, not the hovered one.
    function pin(clientX: number) {
        if (!plot || !props.onHover || props.days.length === 0 || props.pinnable === false) return;
        resetHoverDelay();
        hoverReady = true;
        const i = dayAt(plot, { clientX });
        if (pinned() === i) {
            // Back to hovering it (not through onMove, which would still
            // read it as pinned until the next flush).
            setPinned(null);
            markDay(plot, i, false);
            hover(i);
        } else {
            setPinned(i);
            pinnedDay = props.days[i];
            markDay(plot, i, true);
            hover(i);
        }
    }

    // Moves the pin `by` days, past either end round to the other; or with
    // none pinned, pins the first day (moving later) or the last (moving
    // earlier). Whether it could (this chart pins).
    function movePin(by: number) {
        if (!plot || !props.onHover || props.days.length === 0 || props.pinnable === false) return false;
        const from = pinned();
        const n = props.days.length;
        const i = from === null ? (by > 0 ? 0 : n - 1) : (((from + by) % n) + n) % n;
        if (i === from) return true;
        setPinned(i);
        pinnedDay = props.days[i];
        markDay(plot, i, true);
        hover(i);
        return true;
    }

    function unpin() {
        if (pinned() === null) return;
        setPinned(null);
        pinnedDay = null;
        setMark(null);
        hover(null);
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

    // After every redraw (new data, a resize), the pinned day is re-marked
    // where it now is among the days, or unpinned if they don't have it.
    function redrawn(u: uPlot) {
        if (props.marked != null) markDay(u, props.marked, false);
        if (pinned() === null) return;
        const i = props.days.indexOf(pinnedDay!);
        if (i >= 0) {
            setPinned(i);
            markDay(u, i, true);
            hover(i);
        } else {
            unpin();
        }
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
                padding: [pad + (props.headroom ?? 0), pad, pad, pad],
                scales,
                series,
                axes: [{ show: false }, { show: false }],
                legend: { show: false },
                cursor: { show: false },
                hooks: { draw: [redrawn] },
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

    onShortcut((e) => {
        if (e.shiftKey) return;
        const by = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        if (by !== undefined) {
            if (movePin(by)) e.preventDefault();
        } else if (e.key === "Escape") unpin();
    });

    // Follow `marked`.
    createEffect(
        () => props.marked,
        (i) => {
            if (!plot) return;
            if (i == null) setMark(null);
            else markDay(plot, i, false);
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
