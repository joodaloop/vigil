// Unique visitors under a page and/or source filter, which `views` and
// `visitors` can't answer (a reader isn't counted per page or source there).
// Reads only the hits matching the filter in the period, through the
// hits_page and hits_source indexes (schema.sql), which hold
// everything these need. Kept free of imports so tests can run it against
// SQLite.
export function filteredVisitors(host: string, firstDay: number, page: string | null, source: string | null) {
    // ?1 host, ?2 period start (unix s), then the filters.
    const params: unknown[] = [host, firstDay * 86400];
    const where = ["host = ?1", "ts >= ?2"];
    if (page !== null) where.push(`page = ?${params.push(page)}`);
    if (source !== null) where.push(`source = ?${params.push(source)}`);
    const HITS = `FROM hits WHERE ${where.join(" AND ")}`;
    return {
        params,
        // Per day, for the chart.
        daily: `SELECT ts / 86400 AS day, COUNT(DISTINCT visitor_id) AS visitors ${HITS} GROUP BY day`,
        // Over the period, by device, with those new in it who never came back.
        people: `SELECT v.device, COUNT(*) AS visitors, SUM(v.first_ts >= ?2 AND v.first_ts = v.last_ts) AS bounced
                 FROM (SELECT DISTINCT visitor_id ${HITS}) f
                 JOIN visitors v ON v.host = ?1 AND v.id = f.visitor_id
                 GROUP BY v.device`,
    };
}
