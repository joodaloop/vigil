import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";
import { IDevice, UAParser } from "ua-parser-js";

function maskBrowserVersion(version?: string) {
    if (!version) return version;
    const majorEnd = version.indexOf(".");
    if (majorEnd != -1) {
        version =
            version.substring(0, majorEnd) +
            version.slice(majorEnd).replaceAll(/\.[^.]+/g, ".x");
    }
    return version;
}

function getMidnightDate(): Date {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return midnight;
}

function getNextLastModifiedDate(current: Date | null): Date {
    if (current && isNaN(current.getTime())) {
        current = null;
    }
    const midnight = getMidnightDate();
    let next = current ? current : midnight;
    next = midnight.getTime() - next.getTime() > 0 ? midnight : next;
    const currentSeconds = next.getSeconds();
    next.setSeconds(Math.min(3, currentSeconds + 1));
    return next;
}

function getBounceValue(hits: number): number {
    if (hits === 1) return 1;
    else if (hits === 2) return -1;
    else return 0;
}

function checkVisitorSession(ifModifiedSince: string | null): {
    newVisitor: boolean;
} {
    let newVisitor = true;
    if (ifModifiedSince) {
        const today = new Date();
        const ifModifiedSinceDate = new Date(ifModifiedSince);
        if (
            today.getFullYear() === ifModifiedSinceDate.getFullYear() &&
            today.getMonth() === ifModifiedSinceDate.getMonth() &&
            today.getDate() === ifModifiedSinceDate.getDate()
        ) {
            newVisitor = false;
        }
    }
    return { newVisitor };
}

export function handleCacheHeaders(ifModifiedSince: string | null): {
    hits: number;
    nextLastModifiedDate: Date;
} {
    const { newVisitor } = checkVisitorSession(ifModifiedSince);
    const nextLastModifiedDate = getNextLastModifiedDate(
        ifModifiedSince ? new Date(ifModifiedSince) : null,
    );
    let hits = newVisitor ? 1 : nextLastModifiedDate.getSeconds();
    if (hits > 3) hits = 3;
    return { hits, nextLastModifiedDate };
}

function extractParamsFromQueryString(requestUrl: string): {
    [key: string]: string;
} {
    const url = new URL(requestUrl);
    const queryString = url.search.slice(1).split("&");
    const params: { [key: string]: string } = {};
    queryString.forEach((item) => {
        const kv = item.split("=");
        if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1]);
    });
    return params;
}

function getDeviceTypeFromDevice(device: IDevice): string {
    return device.type === undefined ? "desktop" : device.type;
}

export function collectRequestHandler(
    request: Request,
    env: Env,
    extra: Record<string, string> = {},
) {
    const params = extractParamsFromQueryString(request.url);

    const siteId = params.sid;
    if (!siteId || siteId === "") {
        return new Response("Missing siteId", { status: 400 });
    }

    const userAgent = request.headers.get("user-agent") || undefined;
    const parsedUserAgent = new UAParser(userAgent);

    let isVisit = false;
    let bounceValue = 0;
    let nextLastModifiedDate: Date | undefined;
    let hits = 0;

    if (params.ht !== undefined) {
        hits = parseInt(params.ht, 10);
        if (isNaN(hits) || hits <= 0) hits = 1;
        if (hits > 3) hits = 3;
        nextLastModifiedDate = undefined;
    } else {
        const ifModifiedSince = request.headers.get("if-modified-since");
        const cacheResult = handleCacheHeaders(ifModifiedSince);
        hits = cacheResult.hits;
        nextLastModifiedDate = cacheResult.nextLastModifiedDate;
    }

    isVisit = hits === 1;
    bounceValue = getBounceValue(hits);

    const browserVersion = maskBrowserVersion(
        parsedUserAgent.getBrowser().version,
    );

    const data: DataPoint = {
        siteId,
        host: params.h,
        path: params.p,
        referrer: params.r,
        newVisitor: isVisit ? 1 : 0,
        newSession: 0,
        bounce: bounceValue,
        userAgent,
        browserName: parsedUserAgent.getBrowser().name,
        browserVersion,
        deviceModel: parsedUserAgent.getDevice().model,
        deviceType: getDeviceTypeFromDevice(parsedUserAgent.getDevice()),
        utmSource: params.us,
        utmMedium: params.um,
        utmCampaign: params.uc,
        utmTerm: params.ut,
        utmContent: params.uco,
    };

    const country = extra?.country;
    if (typeof country === "string") {
        data.country = country;
    }

    writeDataPoint(env.WEB_COUNTER_AE, data);

    const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const gifData = atob(gif);
    const gifLength = gifData.length;
    const arrayBuffer = new ArrayBuffer(gifLength);
    const uintArray = new Uint8Array(arrayBuffer);
    for (let i = 0; i < gifLength; i++) {
        uintArray[i] = gifData.charCodeAt(i);
    }

    const headers: HeadersInit = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "image/gif",
        Expires: "Mon, 01 Jan 1990 00:00:00 GMT",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Tk: "N",
    };

    if (nextLastModifiedDate) {
        headers["Last-Modified"] = nextLastModifiedDate.toUTCString();
    }

    return new Response(arrayBuffer, { headers, status: 200 });
}

interface DataPoint {
    siteId?: string;
    host?: string;
    userAgent?: string;
    path?: string;
    country?: string;
    referrer?: string;
    browserName?: string;
    browserVersion?: string;
    deviceModel?: string;
    deviceType?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
    newVisitor: number;
    newSession: number;
    bounce: number;
}

export function writeDataPoint(
    analyticsEngine: AnalyticsEngineDataset,
    data: DataPoint,
) {
    const datapoint = {
        indexes: [data.siteId || ""],
        blobs: [
            data.host || "",        // blob1
            data.userAgent || "",   // blob2
            data.path || "",        // blob3
            data.country || "",     // blob4
            data.referrer || "",    // blob5
            data.browserName || "", // blob6
            data.deviceModel || "", // blob7
            data.siteId || "",      // blob8
            data.browserVersion || "", // blob9
            data.deviceType || "",  // blob10
            data.utmSource || "",   // blob11
            data.utmMedium || "",   // blob12
            data.utmCampaign || "", // blob13
            data.utmTerm || "",     // blob14
            data.utmContent || "",  // blob15
        ],
        doubles: [data.newVisitor || 0, data.newSession || 0, data.bounce],
    };

    if (!analyticsEngine) {
        console.log("Can't save datapoint: Analytics unavailable");
        console.dir(datapoint, { depth: null });
        return;
    }

    analyticsEngine.writeDataPoint(datapoint);
}
