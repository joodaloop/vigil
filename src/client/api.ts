export type CountsResponse = {
    views: number;
    visitors: number;
    bounces: number;
};

export type Row = [string, number, number?];

function qs(params: Record<string, string>) {
    return new URLSearchParams(params).toString();
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const r = await fetch(`${path}?${qs(params)}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json() as Promise<T>;
}

export function fetchSites(): Promise<string[]> {
    return get<string[]>("/api/sites", {});
}

export function fetchAll(siteId: string, interval: string) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const params = { siteId, interval, tz };
    return Promise.all([
        get<CountsResponse>("/api/counts", params),
        get<Row[]>("/api/paths", params),
        get<Row[]>("/api/referrers", params),
        get<Row[]>("/api/countries", params),
        get<Row[]>("/api/browsers", params),
        get<Row[]>("/api/devices", params),
        get<Row[]>("/api/timeseries", params),
    ]);
}
