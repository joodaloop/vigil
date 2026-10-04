// Types shared by the Worker and dashboard.

export type HostTotals = {
    views: number;
    reads: number; // views that stayed visible long enough to count as read
    visitors: number;
    devices: { desktop: number; tablet: number; mobile: number }; // visitors per device type
    new: number; // visitors whose first ever hit on this host is in the period
    newBounced: number; // ...of those, ones with no other hit on this host, ever
};

export type HostDaily = {
    views: number[];
    visitors: number[];
    new: number[];
};

export type PageRow = {
    path: string;
    views: number;
    new: number; // visitors whose first ever hit on the host was this page
    daily: number[]; // views per day
};

export type HostStats = {
    totals: HostTotals;
    daily: HostDaily;
    referrers: Referrer[]; // where views came from, by views; page filter only
    pages: PageRow[]; // by views; referrer filter only
};

// The headline numbers for one host, for the sidebar: views (with a daily
// series, for its sparkline) and new visitors.
export type HostSummary = {
    totals: { views: number; new: number };
    daily: { views: number[] };
};

export type Referrer = {
    domain: string; // a referring site, or "/path" of a page on this one
    visits: number; // views that came from this source
    daily: number[];
};

// GET /api/overview: everything for one host.
export type Overview = {
    days: number[]; // unix seconds at the start of each UTC day
    ref: string | null; // active referrer filter
    page: string | null; // active page filter (a path)
    stats: HostStats;
};

// GET /api/hosts: every host on a site, by host name.
export type HostSummaries = {
    days: number[];
    hosts: Record<string, HostSummary>;
};
// One configured site: a hostname, with the name the dashboard shows.
export type Site = { host: string; name: string };
