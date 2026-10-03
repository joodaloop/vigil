import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// `scale` groups lines that share a y axis (e.g. "count", "ratio").
export type Line = { values: (number | null)[]; color: string; scale: string };

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
// `headroom` adds empty space (px) above the plot, which still counts for
// hovering.
//
// With `onHover`, hovering marks the day nearest the pointer with a line down
// through it and dots on the lines, and reports its index; null once the
// pointer leaves.
export function Chart(props: {
    days: number[];
    lines: Line[];
    height: number;
    lineWidth: number;
    maxes?: Record<string, number>;
    headroom?: number;
    onHover?: (i: number | null) => void;
}) {
    const height = () => props.height + (props.headroom ?? 0);
    let box!: HTMLDivElement; // the chart, with the hover overlay
    let el!: HTMLDivElement; // just uPlot's, so Solid never clears it when the overlay changes
    let plot: uPlot | undefined;
    // The hovered day, so moving within it doesn't report it again.
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
    }

    function onMove(e: PointerEvent) {
        if (!plot || !props.onHover || props.days.length === 0) return;
        const b = box.getBoundingClientRect();
        const over = plot.over.getBoundingClientRect();
        const i = Math.max(0, Math.min(props.days.length - 1, plot.posToIdx(e.clientX - over.left)));
        const top = over.top - b.top;
        setMark({
            x: over.left - b.left + plot.valToPos(props.days[i], "x"),
            dots: props.lines.map((l) => ({ y: top + plot!.valToPos(l.values[i] ?? 0, l.scale), color: l.color })),
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
        const scales: uPlot.Scales = { x: { time: true } };
        const series: uPlot.Series[] = [{}];
        for (const line of props.lines) {
            const fixed = props.maxes?.[line.scale];
            scales[line.scale] ??= {
                range: (_u, _min, max) => [0, scaleTop(fixed ?? max)],
            };
            series.push({ scale: line.scale, stroke: line.color, width: props.lineWidth, points: { show: false } });
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

    onSettled(() => {
        const observer = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height: height() }));
        observer.observe(el);
        return () => {
            observer.disconnect();
            plot?.destroy();
        };
    });

    // Rebuild whenever the data or the set of lines changes.
    createEffect(
        () => [props.days, props.lines, props.maxes, props.headroom, props.lineWidth, props.height],
        () => untrack(build),
    );

    return (
        <div
            ref={box}
            class={["chart", { hoverable: !!props.onHover }]}
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
