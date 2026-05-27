import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export type IntervalType = "HOUR" | "DAY";

export function resolveTimeseriesWindow(
    interval: string,
    tz: string = "Etc/UTC",
): { intervalType: IntervalType; start: Date; end: Date } {
    const now = dayjs();
    const dayMs = 24 * 60 * 60 * 1000;

    if (interval === "today") {
        return {
            intervalType: "HOUR",
            start: now.tz(tz).startOf("day").toDate(),
            end: now.toDate(),
        };
    }
    if (interval === "yesterday") {
        const startOfToday = now.tz(tz).startOf("day");
        return {
            intervalType: "HOUR",
            start: startOfToday.subtract(1, "day").toDate(),
            end: startOfToday.toDate(),
        };
    }
    if (interval === "1d") {
        return {
            intervalType: "HOUR",
            start: new Date(now.valueOf() - dayMs),
            end: now.toDate(),
        };
    }
    const days = Number(interval.replace("d", "")) || 7;
    return {
        intervalType: "DAY",
        start: new Date(now.valueOf() - days * dayMs),
        end: now.toDate(),
    };
}
