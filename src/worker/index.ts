import { handleApi } from "./api";
import { handleHit, handleRead } from "./collect";
import { handleIcon } from "./sources";
import { testPage } from "./test-page";
import tracker from "../tracker/v.js?raw";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const { pathname } = url;

        if (pathname === "/_v/v.js") {
            return new Response(tracker, {
                headers: {
                    "Content-Type": "text/javascript; charset=utf-8",
                    // Served from cache for a day, then from cache while it
                    // revalidates in the background, so updates land within ~a day.
                    "Cache-Control": "public, max-age=86400, stale-while-revalidate=2592000",
                },
            });
        }
        if ((pathname === "/_v/hit" || pathname === "/_v/read") && !env.COOKIE_SECRET) {
            // Without it cookies can't be signed or checked; fail loudly.
            return new Response("COOKIE_SECRET is not set", { status: 500 });
        }
        if (pathname === "/_v/hit" && request.method === "POST") {
            return handleHit(request, env, ctx);
        }
        if (pathname === "/_v/read" && request.method === "POST") {
            return handleRead(request, env);
        }
        if (pathname.startsWith("/_v/test") && env.VIGIL_DEV === "1") {
            return testPage(url);
        }

        if (pathname.startsWith("/api/icon/") && request.method === "GET") {
            return handleIcon(url, env);
        }
        if (pathname.startsWith("/api/")) {
            return handleApi(url, env);
        }

        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;
