import { createSignal, For, Show, onMount, type JSX } from "solid-js";
import { fetchAll, fetchSites, type CountsResponse, type Row } from "./api";

function getSearchParams() {
    return new URLSearchParams(window.location.search);
}

function pushParams(site: string, interval: string) {
    const p = new URLSearchParams({ site, interval });
    history.replaceState(null, "", `?${p}`);
}

export function App() {
    const params = getSearchParams();
    const [sites, setSites] = createSignal<string[]>([]);
    const [siteId, setSiteId] = createSignal(params.get("site") ?? "");
    const [interval, setInterval] = createSignal(params.get("interval") ?? "7d");
    const [status, setStatus] = createSignal("");
    const [error, setError] = createSignal(false);
    const [counts, setCounts] = createSignal<CountsResponse>({
        views: 0,
        visitors: 0,
        bounces: 0,
    });
    const [paths, setPaths] = createSignal<Row[]>([]);
    const [referrers, setReferrers] = createSignal<Row[]>([]);
    const [countries, setCountries] = createSignal<Row[]>([]);
    const [browsers, setBrowsers] = createSignal<Row[]>([]);
    const [devices, setDevices] = createSignal<Row[]>([]);

    function updateSiteId(value: string) {
        setSiteId(value);
        pushParams(value, interval());
    }

    function updateInterval(value: string) {
        setInterval(value);
        pushParams(siteId(), value);
    }

    onMount(async () => {
        try {
            const list = await fetchSites();
            setSites(list);
            if (!siteId() && list.length > 0) {
                setSiteId(list[0]);
                pushParams(list[0], interval());
            }
        } catch {
            // leave sites empty
        }
        await load();
    });

    async function load() {
        setError(false);
        setStatus("Loading…");
        try {
            const [c, p, r, co, b, d] = await fetchAll(siteId(), interval());
            setCounts(c);
            setPaths(p);
            setReferrers(r);
            setCountries(co);
            setBrowsers(b);
            setDevices(d);
            setStatus("");
        } catch (e) {
            setError(true);
            setStatus(e instanceof Error ? e.message : String(e));
        }
    }

    const bounceRate = () => {
        const { visitors, bounces } = counts();
        return visitors > 0
            ? Math.round((bounces / visitors) * 100) + "%"
            : "—";
    };

    return (
        <>
            <h1>Analytics</h1>
            <div class="controls">
                <select
                    value={siteId()}
                    onChange={(e) => updateSiteId(e.currentTarget.value)}
                >
                    <Show when={siteId() && !sites().includes(siteId())}>
                        <option value={siteId()}>{siteId()}</option>
                    </Show>
                    <For each={sites()}>
                        {(s) => <option value={s || "@unknown"}>{s || "(unknown)"}</option>}
                    </For>
                </select>
                <select
                    value={interval()}
                    onChange={(e) => updateInterval(e.currentTarget.value)}
                >
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="1d">Last 24h</option>
                    <option value="7d">Last 7d</option>
                    <option value="30d">Last 30d</option>
                    <option value="90d">Last 90d</option>
                </select>
                <button onClick={load}>Load</button>
                <span class={error() ? "error" : "loading"}>{status()}</span>
            </div>

            <div class="stats">
                <Stat label="Views" value={counts().views.toLocaleString()} />
                <Stat label="Visitors" value={counts().visitors.toLocaleString()} />
                <Stat label="Bounce Rate" value={bounceRate()} />
            </div>

            <div class="tables">
                <TopList
                    title="Top Pages"
                    rows={paths()}
                    label={(r) => r[0] || "(none)"}
                    value={(r) => `${r[1].toLocaleString()} visitors`}
                />
                <TopList
                    title="Top Referrers"
                    rows={referrers()}
                    label={(r) => r[0] || "(direct)"}
                    value={(r) => `${r[1].toLocaleString()} visitors`}
                />
                <TopList
                    title="Countries"
                    rows={countries()}
                    label={(r) => r[0] || "Unknown"}
                    value={(r) => r[1].toLocaleString()}
                />
                <TopList
                    title="Browsers"
                    rows={browsers()}
                    label={(r) => r[0] || "Unknown"}
                    value={(r) => r[1].toLocaleString()}
                />
                <TopList
                    title="Devices"
                    rows={devices()}
                    label={(r) => r[0] || "Unknown"}
                    value={(r) => r[1].toLocaleString()}
                />
            </div>
        </>
    );
}

function Stat(props: { label: string; value: JSX.Element }) {
    return (
        <div class="stat">
            <div class="label">{props.label}</div>
            <div class="value">{props.value}</div>
        </div>
    );
}

function TopList(props: {
    title: string;
    rows: Row[];
    label: (r: Row) => string;
    value: (r: Row) => string;
}) {
    return (
        <div class="table-card">
            <h2>{props.title}</h2>
            <table>
                <tbody>
                    <Show
                        when={props.rows.length > 0}
                        fallback={
                            <tr>
                                <td>No data</td>
                            </tr>
                        }
                    >
                        <For each={props.rows}>
                            {(r) => (
                                <tr>
                                    <td>{props.label(r)}</td>
                                    <td>{props.value(r)}</td>
                                </tr>
                            )}
                        </For>
                    </Show>
                </tbody>
            </table>
        </div>
    );
}
