import { resolveTimeseriesWindow } from "./interval";

type Row = [string, number];

const sites = ["example.com", "blog.example.com", "shop.example.com"];

const counts = { views: 12480, visitors: 8341, bounces: 3120 };

const paths: Row[] = [
    ["/", 4210],
    ["/pricing", 1840],
    ["/blog/launch", 1205],
    ["/docs", 980],
    ["/about", 612],
    ["/contact", 318],
];

const referrers: Row[] = [
    ["", 3902],
    ["google.com", 2104],
    ["news.ycombinator.com", 1380],
    ["twitter.com", 612],
    ["github.com", 410],
];

const countries: Row[] = [
    ["US", 3420],
    ["GB", 980],
    ["DE", 742],
    ["FR", 510],
    ["CA", 388],
    ["AU", 240],
];

const browsers: Row[] = [
    ["Chrome", 5120],
    ["Safari", 1980],
    ["Firefox", 720],
    ["Edge", 410],
];

const devices: Row[] = [
    ["desktop", 5402],
    ["mobile", 2640],
    ["tablet", 299],
];

function makeTimeseries(interval: string, tz: string): Row[] {
    const { intervalType, start, end } = resolveTimeseriesWindow(interval, tz);
    const stepMs = intervalType === "HOUR" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const rows: Row[] = [];
    let t = new Date(start);
    if (intervalType === "HOUR") {
        t.setUTCMinutes(0, 0, 0);
    } else {
        t.setUTCHours(0, 0, 0, 0);
    }
    while (t.getTime() < end.getTime()) {
        const label =
            intervalType === "HOUR"
                ? t.toISOString().slice(0, 16)
                : t.toISOString().slice(0, 10);
        const base = intervalType === "HOUR" ? 40 : 900;
        const jitter = Math.round(Math.random() * (intervalType === "HOUR" ? 80 : 1200));
        rows.push([label, base + jitter]);
        t = new Date(t.getTime() + stepMs);
    }
    return rows;
}

export function getFixture(pathname: string, interval: string, tz: string): unknown {
    switch (pathname) {
        case "/api/counts": return counts;
        case "/api/timeseries": return makeTimeseries(interval, tz);
        case "/api/paths": return paths;
        case "/api/referrers": return referrers;
        case "/api/countries": return countries;
        case "/api/browsers": return browsers;
        case "/api/devices": return devices;
        case "/api/sites": return sites;
        default: return undefined;
    }
}
