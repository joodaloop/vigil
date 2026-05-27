import { collectRequestHandler } from "../analytics/collect";
import { AnalyticsEngineAPI } from "../analytics/query";

export default {
    async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (url.pathname === "/collect") {
            return collectRequestHandler(
                request,
                env,
                (request as any).cf ?? {},
            );
        }

        if (url.pathname.startsWith("/api/")) {
            return handleApiRequest(url, env);
        }

        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;

async function handleApiRequest(url: URL, env: Env): Promise<Response> {
    const api = new AnalyticsEngineAPI(
        env.CF_ACCOUNT_ID,
        env.CF_BEARER_TOKEN,
    );

    const siteId = url.searchParams.get("siteId") ?? "";
    const interval = url.searchParams.get("interval") ?? "7d";
    const tz = url.searchParams.get("tz") ?? "Etc/UTC";

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
    };

    try {
        switch (url.pathname) {
            case "/api/counts": {
                const counts = await api.getCounts(siteId, interval, tz);
                return Response.json(counts, { headers: corsHeaders });
            }
            case "/api/timeseries": {
                const intervalType = interval === "today" || interval === "yesterday" || interval === "1d"
                    ? "HOUR"
                    : "DAY";
                const now = new Date();
                const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                const rows = await api.getViewsGroupedByInterval(siteId, intervalType, start, now, tz);
                return Response.json(rows, { headers: corsHeaders });
            }
            case "/api/paths": {
                const page = Number(url.searchParams.get("page") ?? 1);
                const rows = await api.getCountByPath(siteId, interval, tz, {}, page);
                return Response.json(rows, { headers: corsHeaders });
            }
            case "/api/referrers": {
                const page = Number(url.searchParams.get("page") ?? 1);
                const rows = await api.getCountByReferrer(siteId, interval, tz, {}, page);
                return Response.json(rows, { headers: corsHeaders });
            }
            case "/api/countries": {
                const rows = await api.getCountByCountry(siteId, interval, tz);
                return Response.json(rows, { headers: corsHeaders });
            }
            case "/api/browsers": {
                const rows = await api.getCountByBrowser(siteId, interval, tz);
                return Response.json(rows, { headers: corsHeaders });
            }
            case "/api/devices": {
                const rows = await api.getCountByDeviceType(siteId, interval, tz);
                return Response.json(rows, { headers: corsHeaders });
            }
            case "/api/sites": {
                const sites = await api.getSitesOrderedByHits("90d");
                return Response.json(sites.map(([site]: [string, number]) => site), { headers: corsHeaders });
            }
            default:
                return new Response("Not found", { status: 404 });
        }
    } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        return new Response(msg || "(empty error)", { status: 500 });
    }
}
