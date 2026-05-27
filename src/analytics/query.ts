import { ColumnMappingToType, ColumnMappings } from "./schema";
import { SearchFilters } from "./types";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

interface AnalyticsQueryResult<
    SelectionSet extends Record<string, string | number>,
> {
    meta: string;
    data: SelectionSet[];
    rows: number;
    rows_before_limit_at_least: number;
}

interface AnalyticsCountResult {
    views: number;
    visitors: number;
    bounces: number;
}

export type ViewsGroupedByInterval = [string, AnalyticsCountResult][];

function accumulateCountsFromRowResult(
    counts: AnalyticsCountResult,
    row: {
        count: number;
        isVisitor: number;
        isBounce: number;
    },
) {
    if (row.isVisitor == 1) {
        counts.visitors += Number(row.count);
    }
    if (row.isBounce && row.isBounce != 0) {
        counts.bounces += Number(row.count) * row.isBounce;
    }
    counts.views += Number(row.count);
}

export function intervalToSql(
    interval: string,
    tz?: string,
    bucketIntervalMinutes: number = 5,
) {
    let startIntervalSql = "";
    let endIntervalSql = "";
    switch (interval) {
        case "today":
            startIntervalSql = `toDateTime('${dayjs().tz(tz).startOf("day").utc().format("YYYY-MM-DD HH:mm:ss")}')`;
            endIntervalSql = `toStartOfInterval(NOW(), INTERVAL '${bucketIntervalMinutes}' MINUTE)`;
            break;
        case "yesterday":
            startIntervalSql = `toDateTime('${dayjs().tz(tz).startOf("day").utc().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss")}')`;
            endIntervalSql = `toDateTime('${dayjs().tz(tz).startOf("day").utc().format("YYYY-MM-DD HH:mm:ss")}')`;
            break;
        case "1d":
        case "7d":
        case "30d":
        case "90d":
            startIntervalSql = `toStartOfInterval(NOW() - INTERVAL '${interval.split("d")[0]}' DAY, INTERVAL '${bucketIntervalMinutes}' MINUTE)`;
            endIntervalSql = `toStartOfInterval(NOW(), INTERVAL '${bucketIntervalMinutes}' MINUTE)`;
            break;
        default:
            startIntervalSql = `toStartOfInterval(NOW() - INTERVAL '1' DAY, INTERVAL '${bucketIntervalMinutes}' MINUTE)`;
            endIntervalSql = `toStartOfInterval(NOW(), INTERVAL '${bucketIntervalMinutes}' MINUTE)`;
    }
    return { startIntervalSql, endIntervalSql };
}

function generateEmptyRowsOverInterval(
    intervalType: "DAY" | "HOUR",
    startDateTime: Date,
    endDateTime: Date,
    tz?: string,
): { [key: string]: AnalyticsCountResult } {
    if (!tz) {
        tz = "Etc/UTC";
    }

    const initialRows: { [key: string]: AnalyticsCountResult } = {};

    while (startDateTime.getTime() < endDateTime.getTime()) {
        const key = dayjs(startDateTime).utc().format("YYYY-MM-DD HH:mm:ss");
        initialRows[key] = { views: 0, visitors: 0, bounces: 0 };

        if (intervalType === "DAY") {
            startDateTime = dayjs(startDateTime)
                .add(25, "hours")
                .tz(tz)
                .startOf("day")
                .toDate();
        } else if (intervalType === "HOUR") {
            startDateTime = dayjs(startDateTime).add(1, "hour").toDate();
        } else {
            throw new Error("Invalid interval type");
        }
    }

    return initialRows;
}

function filtersToSql(filters: SearchFilters) {
    const supportedFilters: Array<keyof SearchFilters> = [
        "path",
        "referrer",
        "browserName",
        "browserVersion",
        "country",
        "deviceType",
        "utmSource",
        "utmMedium",
        "utmCampaign",
        "utmTerm",
        "utmContent",
    ];

    let filterStr = "";
    supportedFilters.forEach((filter) => {
        if (Object.hasOwnProperty.call(filters, filter)) {
            filterStr += `AND ${ColumnMappings[filter]} = '${filters[filter]}'`;
        }
    });
    return filterStr;
}

export class AnalyticsEngineAPI {
    cfApiToken: string;
    cfAccountId: string;
    defaultHeaders: {
        "content-type": string;
        "X-Source": string;
        Authorization: string;
    };
    defaultUrl: string;

    constructor(cfAccountId: string, cfApiToken: string) {
        this.cfAccountId = cfAccountId;
        this.cfApiToken = cfApiToken;

        this.defaultUrl = `https://api.cloudflare.com/client/v4/accounts/${this.cfAccountId}/analytics_engine/sql`;
        this.defaultHeaders = {
            "content-type": "application/json;charset=UTF-8",
            "X-Source": "Cloudflare-Workers",
            Authorization: `Bearer ${this.cfApiToken}`,
        };
    }

    async query(query: string) {
        return fetch(this.defaultUrl, {
            method: "POST",
            body: query,
            headers: this.defaultHeaders,
        });
    }

    async getViewsGroupedByInterval(
        siteId: string,
        intervalType: "DAY" | "HOUR",
        startDateTime: Date,
        endDateTime: Date,
        tz?: string,
        filters: SearchFilters = {},
    ): Promise<ViewsGroupedByInterval> {
        let intervalCount = 1;
        switch (intervalType) {
            case "DAY":
            case "HOUR":
                intervalCount = 1;
                break;
        }

        const initialRows = generateEmptyRowsOverInterval(
            intervalType,
            startDateTime,
            endDateTime,
            tz,
        );

        const filterStr = filtersToSql(filters);
        const localStartTime = dayjs(startDateTime).tz(tz).utc();
        const localEndTime = dayjs(endDateTime).tz(tz).utc();

        const query = `
            SELECT SUM(_sample_interval) as count,
            toStartOfInterval(timestamp, INTERVAL '${intervalCount}' ${intervalType}, '${tz}') as _bucket,
            ${ColumnMappings.newVisitor} as isVisitor,
            ${ColumnMappings.bounce} as isBounce,
            toDateTime(_bucket, 'Etc/UTC') as bucket
            FROM metricsDataset
            WHERE timestamp >= toDateTime('${localStartTime.format("YYYY-MM-DD HH:mm:ss")}')
                AND timestamp < toDateTime('${localEndTime.format("YYYY-MM-DD HH:mm:ss")}')
                AND ${ColumnMappings.siteId} = '${siteId}'
                ${filterStr}
            GROUP BY _bucket, isVisitor, isBounce
            ORDER BY _bucket ASC`;

        type SelectionSet = {
            count: number;
            bucket: string;
            isVisitor: number;
            isBounce: number;
        };

        const queryResult = this.query(query);
        const returnPromise = new Promise<[string, AnalyticsCountResult][]>(
            (resolve, reject) =>
                (async () => {
                    const response = await queryResult;

                    if (!response.ok) {
                        reject(response.statusText);
                    }

                    const responseData =
                        (await response.json()) as AnalyticsQueryResult<SelectionSet>;

                    const rowsByDateTime = responseData.data.reduce(
                        (accum, row) => {
                            const utcDateTime = new Date(row["bucket"]);
                            const key = dayjs(utcDateTime).format(
                                "YYYY-MM-DD HH:mm:ss",
                            );
                            if (!Object.hasOwn(accum, key)) {
                                accum[key] = {
                                    views: 0,
                                    visitors: 0,
                                    bounces: 0,
                                };
                            }
                            accumulateCountsFromRowResult(accum[key], row);
                            return accum;
                        },
                        initialRows,
                    );

                    const sortedRows = Object.entries(rowsByDateTime).sort(
                        (a, b) => {
                            if (a[0] < b[0]) return -1;
                            else if (a[0] > b[0]) return 1;
                            else return 0;
                        },
                    );

                    for (let i = 1; i < sortedRows.length; i++) {
                        const current = sortedRows[i][1];
                        if (current.bounces < 0) {
                            for (let j = i - 1; j >= 0; j--) {
                                const prev = sortedRows[j][1];
                                if (prev.bounces > 0) {
                                    prev.bounces += current.bounces;
                                    current.bounces = 0;
                                    break;
                                }
                            }
                        }
                    }

                    resolve(sortedRows);
                })(),
        );
        return returnPromise;
    }

    async getCounts(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
    ) {
        const siteIdColumn = ColumnMappings["siteId"];
        const { startIntervalSql, endIntervalSql } = intervalToSql(interval, tz);
        const filterStr = filtersToSql(filters);

        const query = `
            SELECT SUM(_sample_interval) as count,
                ${ColumnMappings.newVisitor} as isVisitor,
                ${ColumnMappings.bounce} as isBounce
            FROM metricsDataset
            WHERE timestamp >= ${startIntervalSql} AND timestamp < ${endIntervalSql}
                ${filterStr}
            AND ${siteIdColumn} = '${siteId}'
            GROUP BY isVisitor, isBounce
            ORDER BY isVisitor, isBounce ASC`;

        type SelectionSet = {
            count: number;
            isVisitor: number;
            isBounce: number;
        };

        const queryResult = this.query(query);

        const returnPromise = new Promise<AnalyticsCountResult>(
            (resolve, reject) =>
                (async () => {
                    const response = await queryResult;

                    if (!response.ok) {
                        reject(response.statusText);
                    }

                    const responseData =
                        (await response.json()) as AnalyticsQueryResult<SelectionSet>;

                    const counts: AnalyticsCountResult = {
                        views: 0,
                        visitors: 0,
                        bounces: 0,
                    };

                    responseData.data.forEach((row) => {
                        accumulateCountsFromRowResult(counts, row);
                    });
                    resolve(counts);
                })(),
        );

        return returnPromise;
    }

    async getVisitorCountByColumn<T extends keyof typeof ColumnMappings>(
        siteId: string,
        column: T,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
        limit: number = 10,
    ) {
        const { startIntervalSql, endIntervalSql } = intervalToSql(interval, tz);
        const filterStr = filtersToSql(filters);
        const _column = ColumnMappings[column];

        const query = `
            SELECT ${_column}, SUM(_sample_interval) as count
            FROM metricsDataset
            WHERE timestamp >= ${startIntervalSql} AND timestamp < ${endIntervalSql}
                AND ${ColumnMappings.newVisitor} = 1
                AND ${ColumnMappings.siteId} = '${siteId}'
                ${filterStr}
            GROUP BY ${_column}
            ORDER BY count DESC
            LIMIT ${limit * page}`;

        type SelectionSet = {
            count: number;
        } & Record<
            (typeof ColumnMappings)[T],
            ColumnMappingToType<(typeof ColumnMappings)[T]>
        >;

        const queryResult = this.query(query);
        const returnPromise = new Promise<
            [ColumnMappingToType<typeof _column>, number][]
        >((resolve, reject) =>
            (async () => {
                const response = await queryResult;

                if (!response.ok) {
                    reject(response.statusText);
                }

                const responseData =
                    (await response.json()) as AnalyticsQueryResult<SelectionSet>;

                const pageData = responseData.data.slice(
                    limit * (page - 1),
                    limit * page,
                );

                resolve(
                    pageData.map((row) => {
                        const key = row[_column];
                        return [key, Number(row["count"])] as const;
                    }),
                );
            })(),
        );
        return returnPromise;
    }

    async getAllCountsByColumn<T extends keyof typeof ColumnMappings>(
        siteId: string,
        column: T,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
        limit: number = 10,
    ): Promise<Record<string, AnalyticsCountResult>> {
        const { startIntervalSql, endIntervalSql } = intervalToSql(interval, tz);
        const _column = ColumnMappings[column];
        const baseFilterStr = filtersToSql(filters);

        const topNQuery = `
            SELECT ${_column}, SUM(_sample_interval) as count
            FROM metricsDataset
            WHERE timestamp >= ${startIntervalSql} AND timestamp < ${endIntervalSql}
                AND ${ColumnMappings.siteId} = '${siteId}'
                ${baseFilterStr}
            GROUP BY ${_column}
            ORDER BY count DESC
            LIMIT ${limit * page}`;

        const topNResponse = await this.query(topNQuery);
        if (!topNResponse.ok) {
            throw new Error(topNResponse.statusText);
        }
        const topNData = (
            (await topNResponse.json()) as AnalyticsQueryResult<
                { count: number } & Record<
                    (typeof ColumnMappings)[T],
                    ColumnMappingToType<(typeof ColumnMappings)[T]>
                >
            >
        ).data.slice(limit * (page - 1), limit * page);
        const keys = topNData.map((row) => row[_column] as string);

        let filterStr = baseFilterStr;
        if (keys.length > 0) {
            filterStr += ` AND ${_column} IN (${keys.map((key) => `'${key}'`).join(", ")})`;
        }

        const query = `
            SELECT ${_column},
                ${ColumnMappings.newVisitor} as isVisitor,
                ${ColumnMappings.bounce} as isBounce,
                SUM(_sample_interval) as count
            FROM metricsDataset
            WHERE timestamp >= ${startIntervalSql} AND timestamp < ${endIntervalSql}
                AND ${ColumnMappings.siteId} = '${siteId}'
                ${filterStr}
            GROUP BY ${_column}, ${ColumnMappings.newVisitor}, ${ColumnMappings.bounce}
            ORDER BY count DESC
            LIMIT ${limit * 2 * page}`;

        type SelectionSet = {
            count: number;
            isVisitor: number;
            isBounce: number;
        } & Record<
            (typeof ColumnMappings)[T],
            ColumnMappingToType<(typeof ColumnMappings)[T]>
        >;

        const queryResult = this.query(query);
        const returnPromise = new Promise<Record<string, AnalyticsCountResult>>(
            (resolve, reject) =>
                (async () => {
                    const response = await queryResult;

                    if (!response.ok) {
                        reject(response.statusText);
                    }

                    const responseData =
                        (await response.json()) as AnalyticsQueryResult<SelectionSet>;

                    const result = responseData.data.reduce(
                        (acc, row) => {
                            const key = row[_column] as string;
                            if (!Object.hasOwn(acc, key)) {
                                acc[key] = {
                                    views: 0,
                                    visitors: 0,
                                    bounces: 0,
                                } as AnalyticsCountResult;
                            }
                            accumulateCountsFromRowResult(acc[key], row);
                            return acc;
                        },
                        {} as Record<string, AnalyticsCountResult>,
                    );

                    resolve(result);
                })(),
        );
        return returnPromise;
    }

    async getCountByPath(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[path: string, visitors: number, views: number][]> {
        return this.getAllCountsByColumn(siteId, "path", interval, tz, filters, page).then(
            (allCountsResult) => {
                const result: [string, number, number][] = [];
                for (const [key] of Object.entries(allCountsResult)) {
                    const record = allCountsResult[key];
                    result.push([key, record.visitors, record.views]);
                }
                return result.sort((a, b) => b[1] - a[1]);
            },
        );
    }

    async getCountByReferrer(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[referrer: string, visitors: number, views: number][]> {
        return this.getAllCountsByColumn(siteId, "referrer", interval, tz, filters, page).then(
            (allCountsResult) => {
                const result: [string, number, number][] = [];
                for (const [key] of Object.entries(allCountsResult)) {
                    const record = allCountsResult[key];
                    result.push([key, record.visitors, record.views]);
                }
                return result.sort((a, b) => b[1] - a[1]);
            },
        );
    }

    async getCountByCountry(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[country: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "country", interval, tz, filters, page);
    }

    async getCountByBrowser(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[browser: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "browserName", interval, tz, filters, page);
    }

    async getCountByBrowserVersion(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[browser: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "browserVersion", interval, tz, filters, page);
    }

    async getCountByDeviceModel(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[deviceModel: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "deviceModel", interval, tz, filters, page);
    }

    async getCountByDeviceType(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[deviceType: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "deviceType", interval, tz, filters, page);
    }

    async getCountByUtmSource(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[utmSource: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "utmSource", interval, tz, filters, page);
    }

    async getCountByUtmMedium(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[utmMedium: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "utmMedium", interval, tz, filters, page);
    }

    async getCountByUtmCampaign(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[utmCampaign: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "utmCampaign", interval, tz, filters, page);
    }

    async getCountByUtmTerm(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[utmTerm: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "utmTerm", interval, tz, filters, page);
    }

    async getCountByUtmContent(
        siteId: string,
        interval: string,
        tz?: string,
        filters: SearchFilters = {},
        page: number = 1,
    ): Promise<[utmContent: string, visitors: number][]> {
        return this.getVisitorCountByColumn(siteId, "utmContent", interval, tz, filters, page);
    }

    async getSitesOrderedByHits(interval: string, limit?: number) {
        limit = limit || 10;
        const { startIntervalSql, endIntervalSql } = intervalToSql(interval);

        const query = `
            SELECT SUM(_sample_interval) as count,
                ${ColumnMappings.siteId} as siteId
            FROM metricsDataset
            WHERE timestamp >= ${startIntervalSql} AND timestamp < ${endIntervalSql}
            GROUP BY siteId
            ORDER BY count DESC
            LIMIT ${limit}
        `;

        type SelectionSet = {
            count: number;
            siteId: string;
        };

        const queryResult = this.query(query);
        const returnPromise = new Promise<[string, number][]>(
            (resolve, reject) =>
                (async () => {
                    const response = await queryResult;

                    if (!response.ok) {
                        reject(response.statusText);
                        return;
                    }

                    const responseData =
                        (await response.json()) as AnalyticsQueryResult<SelectionSet>;
                    const result = responseData.data.reduce(
                        (acc, cur) => {
                            acc.push([cur["siteId"], cur["count"]]);
                            return acc;
                        },
                        [] as [string, number][],
                    );

                    resolve(result);
                })(),
        );
        return returnPromise;
    }

    async getEarliestEvents(siteId: string): Promise<{
        earliestEvent: Date | null;
        earliestBounce: Date | null;
    }> {
        const query = `
            SELECT
                MIN(timestamp) as earliestEvent,
                ${ColumnMappings.bounce} as isBounce
            FROM metricsDataset
            WHERE ${ColumnMappings.siteId} = '${siteId}'
            GROUP by isBounce
        `;

        type SelectionSet = {
            earliestEvent: string;
            isBounce: number;
        };

        const queryResult = this.query(query);
        const returnPromise = new Promise<{
            earliestEvent: Date | null;
            earliestBounce: Date | null;
        }>((resolve, reject) => {
            (async () => {
                const response = await queryResult;

                if (!response.ok) {
                    reject(response.statusText);
                    return;
                }

                const responseData =
                    (await response.json()) as AnalyticsQueryResult<SelectionSet>;

                const data = responseData.data;

                const earliestEvent = data.find(
                    (row) => row["isBounce"] === 0,
                )?.earliestEvent;

                const earliestBounce = data.find(
                    (row) => row["isBounce"] === 1,
                )?.earliestEvent;

                resolve({
                    earliestEvent: earliestEvent ? new Date(earliestEvent) : null,
                    earliestBounce: earliestBounce ? new Date(earliestBounce) : null,
                });
            })();
        });

        return returnPromise;
    }
}
