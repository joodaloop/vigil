// Types shared by the Worker and dashboard.

export type HostTotals = {
    views: number;
    avgScrollPct: number | null; // average max scroll depth, 0-100
    avgEngagedS: number | null; // average seconds visible per page view
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

// Views, distinct visitors and new visitors.
export type Counts = { views: number; visitors: number; new: number };

export type PageRow = {
    path: string;
    views: number;
    new: number; // visitors whose first ever hit on the host was this page
    daily: number[]; // views per day
};

export type HostStats = {
    totals: HostTotals;
    daily: HostDaily;
    referrers: Referrer[]; // arrivals by visits; page filter only
    pages: PageRow[]; // by views; referrer filter only
};

// The headline numbers for one host, for the sidebar.
export type HostSummary = {
    totals: Counts;
    daily: HostDaily;
};

export type Referrer = {
    domain: string;
    visits: number; // arrivals from this referrer
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
export type SiteConfig = {
    site: string;
    hosts: { host: string; name: string }[];
};
