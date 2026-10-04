import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// `scale` groups lines that share a y axis (e.g. "count", "ratio"); `area`
// draws it as a faint fill down to the baseline instead of a line (its
// colour must be #rrggbb).
export type Line = { values: (number | null)[]; color: string; scale: string; area?: boolean };

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
// pointer leaves. Clicking pins the day, adding a line down through it: it
// stays marked and reported, whatever the pointer does, until another day is
// clicked (pinning that one instead), it is clicked again, or the days
// change (another period, or the next day arriving).
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
    marked?: number | null;
}) {
    const height = () => props.height + (props.headroom ?? 0);
    let box!: HTMLDivElement; // the chart, with the hover overlay
    let el!: HTMLDivElement; // just uPlot's, so Solid never clears it when the overlay changes
    let plot: uPlot | undefined;
    // The hovered day, so moving within it doesn't report it again.
    let hovered: number | null = null;
    // The day pinned by a click, if any, and the days it was pinned among.
    const [pinned, setPinned] = createSignal<number | null>(null);
    let pinnedAmong = "";
    const daysKey = () => `${props.days[0]}:${props.days.length}`;
    // Where the hovered day is drawn, in px from the chart's top left: its x,
    // a dot per line, and how far the plot's baseline is above the chart's
    // bottom edge (its padding), where the day's line stops.
    const [mark, setMark] = createSignal<{
        x: number;
        dots: { y: number; color: string }[];
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
            dots: props.lines.map((l) => ({ y: top + u.valToPos(l.values[i] ?? 0, l.scale), color: l.color })),
            base: b.bottom - over.bottom,
            line,
        });
    }

    // The day nearest the pointer, never a placeholder.
    function dayAt(u: uPlot, e: MouseEvent) {
        const over = u.over.getBoundingClientRect();
        return Math.max(0, Math.min(props.days.length - 1, u.posToIdx(e.clientX - over.left) - ends()));
    }

    function onMove(e: MouseEvent) {
        if (!plot || !props.onHover || props.days.length === 0 || pinned() !== null) return;
        const i = dayAt(plot, e);
        markDay(plot, i, false);
        hover(i);
    }

    function onLeave() {
        if (pinned() !== null) return;
        setMark(null);
        hover(null);
    }

    // Pins the day clicked (moving the pin there if another is pinned), or
    // if it's the pinned one, unpins it and goes back to following the
    // pointer. The day is the click's own, as a tap has already cleared the
    // hover.
    function onClick(e: MouseEvent) {
        if (!plot || !props.onHover || props.days.length === 0) return;
        const i = dayAt(plot, e);
        if (pinned() === i) {
            // Back to hovering it (not through onMove, which would still
            // read it as pinned until the next flush).
            setPinned(null);
            markDay(plot, i, false);
            hover(i);
        } else {
            setPinned(i);
            pinnedAmong = daysKey();
            markDay(plot, i, true);
            hover(i);
        }
    }

    // After every redraw (new data, a resize), the pinned day is re-marked
    // where it now is, or unpinned if the days have changed.
    function redrawn(u: uPlot) {
        if (props.marked != null) markDay(u, props.marked, false);
        const i = pinned();
        if (i === null) return;
        if (daysKey() === pinnedAmong) {
            markDay(u, i, true);
            hover(i);
        } else {
            setPinned(null);
            setMark(null);
            hover(null);
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
            series.push({
                scale: line.scale,
                stroke: line.area ? "transparent" : line.color,
                width: line.area ? 0 : props.lineWidth,
                fill: line.area ? `${line.color}26` : undefined, // 15% opaque
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
            observer.disconnect();
            plot?.destroy();
        };
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
            style={{ height: `${height()}px` }}
            // Touch: a finger down shows its day, dragging sideways moves
            // through days, lifting it (or a scroll taking over) clears it.
            onPointerDown={onMove}
            onPointerMove={onMove}
            onPointerLeave={onLeave}
            onPointerCancel={onLeave}
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
                                <div class="chart-dot" style={{ left: `${m().x}px`, top: `${d.y}px`, background: d.color }} />
                            )}
                        </For>
                    </>
                )}
            </Show>
        </div>
    );
}
