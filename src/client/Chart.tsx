import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// `scale` groups lines that share a y axis (e.g. "count", "ratio").
export type Line = { values: (number | null)[]; color: string; scale: string };

const HALF_DAY = 43200; // s

// Top of a scale's 0..top range, given the largest value on it.
const scaleTop = (max: number) => (max > 0 ? max * 1.05 : 1);

// Padding around the plot, so thick lines at the edges aren't clipped.
const chartPadding = (lineWidth: number) => Math.ceil(lineWidth);

// How far above the chart's bottom edge (px) its lowest point is drawn, using
// the same scales as Chart. Null when there's nothing to draw.
export function lowestPointOffset(
    lines: Line[],
    height: number,
    lineWidth: number,
    maxes?: Record<string, number>,
): number | null {
    const pad = chartPadding(lineWidth);
    const tops = new Map<string, number>();
    for (const line of lines) {
        const max = maxes?.[line.scale] ?? Math.max(0, ...line.values.map((v) => v ?? 0));
        tops.set(line.scale, Math.max(tops.get(line.scale) ?? 0, max));
    }

    let lowest: number | null = null;
    for (const line of lines) {
        const top = scaleTop(tops.get(line.scale)!);
        for (const v of line.values) {
            if (v === null) continue;
            const y = pad + ((height - 2 * pad) * v) / top;
            if (lowest === null || y < lowest) lowest = y;
        }
    }
    return lowest;
}

// A bare line chart: no axes, grid, legend or cursor. Lines on the same scale
// are drawn against one 0..max range; `maxes` pins a scale's max so several
// charts can be compared at the same scale.
//
// With `bars`, each day gets one bar per line, all overlapping and drawn in
// order, so later (smaller) series sit in front of earlier ones.
//
// `headroom` adds empty space (px) above the plot, which still counts for
// hovering.
//
// With `onHover`, hovering marks the day nearest the pointer with a line down
// through it, and dots on the lines (or, as bars, the other days in `dim`
// colours), and reports its index; null once the pointer leaves.
export function Chart(props: {
    days: number[];
    lines: Line[];
    height: number;
    lineWidth: number;
    maxes?: Record<string, number>;
    bars?: boolean;
    headroom?: number;
    dim?: (color: string) => string;
    onHover?: (i: number | null) => void;
}) {
    const height = () => props.height + (props.headroom ?? 0);
    let box!: HTMLDivElement; // the chart, with the hover overlay
    let el!: HTMLDivElement; // just uPlot's, so Solid never clears it when the overlay changes
    let plot: uPlot | undefined;
    // The hovered day, read while drawing bars.
    let hovered: number | null = null;
    // Where the hovered day is drawn, in px from the chart's top left: its x,
    // a dot per line, and how far the plot's baseline is above the chart's
    // bottom edge (its padding), where the day's line stops.
    const [mark, setMark] = createSignal<{
        x: number;
        dots: { y: number; color: string }[];
        base: number;
    } | null>(null);

    function hover(i: number | null) {
        if (i === hovered) return;
        hovered = i;
        props.onHover?.(i);
        if (props.bars) plot?.redraw(true, false); // recolour the bars
    }

    function onMove(e: PointerEvent) {
        if (!plot || !props.onHover || props.days.length === 0) return;
        const b = box.getBoundingClientRect();
        const over = plot.over.getBoundingClientRect();
        const i = Math.max(0, Math.min(props.days.length - 1, plot.posToIdx(e.clientX - over.left)));
        const top = over.top - b.top;
        setMark({
            x: over.left - b.left + plot.valToPos(props.days[i], "x"),
            dots: props.bars
                ? []
                : props.lines.map((l) => ({ y: top + plot!.valToPos(l.values[i] ?? 0, l.scale), color: l.color })),
            base: b.bottom - over.bottom,
        });
        hover(i);
    }

    function onLeave() {
        setMark(null);
        hover(null);
    }

    function build() {
        plot?.destroy();
        // Bars are centred on their day, so leave half a day at each end. From
        // the days, not the current range: redraws pass in the padded one.
        const first = props.days[0];
        const last = props.days[props.days.length - 1];
        const scales: uPlot.Scales = {
            x: { time: true, range: props.bars ? () => [first - HALF_DAY, last + HALF_DAY] : undefined },
        };
        const series: uPlot.Series[] = [{}];
        // Each bar's colour: its line's, dimmed while another day is hovered.
        const colors: uPlot.Series.BarsPathBuilderFacet = {
            unit: 3,
            values: (_u, s) => {
                const color = props.lines[s - 1].color;
                const dimmed = props.dim?.(color) ?? color;
                return props.days.map((_, i) => (hovered === null || i === hovered ? color : dimmed));
            },
        };
        const bars = props.bars
            ? uPlot.paths.bars!({ size: [0.7, Infinity], align: 0, disp: { fill: colors, stroke: colors } })
            : undefined;
        for (const line of props.lines) {
            const fixed = props.maxes?.[line.scale];
            scales[line.scale] ??= {
                range: (_u, _min, max) => [0, scaleTop(fixed ?? max)],
            };
            series.push(
                bars
                    ? { scale: line.scale, stroke: line.color, fill: line.color, width: 1, paths: bars, points: { show: false } }
                    : { scale: line.scale, stroke: line.color, width: props.lineWidth, points: { show: false } },
            );
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
                select: { show: false, left: 0, top: 0, width: 0, height: 0 },
            },
            [props.days, ...props.lines.map((l) => l.values)] as uPlot.AlignedData,
            el,
        );
    }

    onMount(() => {
        const observer = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height: height() }));
        observer.observe(el);
        onCleanup(() => {
            observer.disconnect();
            plot?.destroy();
        });
    });

    // Rebuild whenever the data or the set of lines changes.
    createEffect(build);

    return (
        <div
            ref={box}
            class="chart"
            classList={{ hoverable: !!props.onHover }}
            style={{ height: `${height()}px` }}
            // Touch: a finger down shows its day, dragging sideways moves
            // through days, lifting it (or a scroll taking over) clears it.
            onPointerDown={onMove}
            onPointerMove={onMove}
            onPointerLeave={onLeave}
            onPointerCancel={onLeave}
        >
            <div ref={el} class="chart-plot" />
            <Show when={mark()}>
                {(m) => (
                    <>
                        <div class="chart-day" style={{ left: `${m().x}px`, bottom: `${m().base}px` }} />
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
