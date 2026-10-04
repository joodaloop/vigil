// Queries that run through `hits` rather than `views` (schema.sql), each
// reading only the hits it counts through one of hits' covering indexes.
// Kept free of imports so tests can run them against SQLite.
//
//   - unique visitors under any filter, since a reader isn't counted per
//     page, source or country in `views` or `visitors`
//   - every other number under a country filter, since `views` only breaks
//     the numbers down by what the dashboard lists (page and source)

export type Filters = { page: string | null; source: string | null; country: string | null };

// ?1 host, ?2 period start (unix s), then whichever filters are given.
function scope(host: string, firstDay: number, filters: Filters) {
    const params: unknown[] = [host, firstDay * 86400];
    const where = ["host = ?1", "ts >= ?2"];
    if (filters.page !== null) where.push(`page = ?${params.push(filters.page)}`);
    if (filters.source !== null) where.push(`source = ?${params.push(filters.source)}`);
    if (filters.country !== null) where.push(`country = ?${params.push(filters.country)}`);
    return { params, HITS: `FROM hits WHERE ${where.join(" AND ")}` };
}

// Visitors under a page, source and/or country filter.
export function filteredVisitors(host: string, firstDay: number, filters: Filters) {
    const { params, HITS } = scope(host, firstDay, filters);
    return {
        params,
        // Per day, for the chart.
        daily: `SELECT ts / 86400 AS day, COUNT(DISTINCT visitor_id) AS visitors ${HITS} GROUP BY day`,
        // Over the period, by device, country and OS, with those new in it
        // who never came back.
        people: `SELECT v.device, v.country, v.os, COUNT(*) AS visitors,
                        SUM(v.first_ts >= ?2 AND v.first_ts = v.last_ts) AS bounced
                 FROM (SELECT DISTINCT visitor_id ${HITS}) f
                 JOIN visitors v ON v.host = ?1 AND v.id = f.visitor_id
                 GROUP BY v.device, v.country, v.os`,
    };
}

// The chart, totals and lists under a country filter, as the `views` queries
// give them otherwise, every one taking every filter.
export function countrySums(host: string, firstDay: number, filters: Filters & { country: string }) {
    const { params, HITS } = scope(host, firstDay, filters);
    return {
        daily: {
            params,
            sql: `SELECT ts / 86400 AS day, COUNT(*) AS views, SUM(is_new) AS new, SUM(read) AS reads
                  ${HITS} GROUP BY day`,
        },
        pages: {
            params,
            sql: `SELECT page, ts / 86400 AS day, COUNT(*) AS views, SUM(is_new) AS new ${HITS} GROUP BY page, day`,
        },
        sources: {
            params,
            sql: `SELECT source, ts / 86400 AS day, COUNT(*) AS views, SUM(is_new) AS new
                  ${HITS} AND source != '' GROUP BY source, day`,
        },
    };
}
