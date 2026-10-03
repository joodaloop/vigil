import { createEffect, onCleanup, onMount } from "solid-js";
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
export function Chart(props: {
    days: number[];
    lines: Line[];
    height: number;
    lineWidth: number;
    maxes?: Record<string, number>;
}) {
    let el!: HTMLDivElement;
    let plot: uPlot | undefined;

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
                height: props.height,
                padding: [pad, pad, pad, pad],
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
        const observer = new ResizeObserver(() => plot?.setSize({ width: el.clientWidth, height: props.height }));
        observer.observe(el);
        onCleanup(() => {
            observer.disconnect();
            plot?.destroy();
        });
    });

    // Rebuild whenever the data or the set of lines changes.
    createEffect(build);

    return <div ref={el} class="chart" style={{ height: `${props.height}px` }} />;
}
