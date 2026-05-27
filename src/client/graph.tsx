import { For, Show } from "solid-js";
import type { Row } from "./api";

export function Graph(props: { title: string; rows: Row[] }) {
  const max = () => Math.max(1, ...props.rows.map((r) => r[1]));

  return (
    <div class="graph-card">
      <h2>{props.title}</h2>
      <Show when={props.rows.length > 0} fallback={<div class="graph-empty">No data</div>}>
        <div class="graph">
          <For each={props.rows}>
            {(r) => {
              const height = () => (r[1] / max()) * 100;
              return (
                <div class="graph-bar-wrap" title={`${r[0]}: ${r[1].toLocaleString()}`}>
                  <div class="graph-bar" style={{ height: `${height()}%` }} />
                  <div class="graph-label">{formatLabel(r[0])}</div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

function formatLabel(s: string) {
  // hour bucket "2026-05-21T14:00" or "2026-05-21 14:00:00" -> "14:00"
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}/.test(s)) return s.slice(11, 16);
  // day bucket "2026-05-21" -> "05-21"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
  return s;
}
