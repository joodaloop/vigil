// Types shared by the Worker and dashboard.

export type HostTotals = {
    views: number;
    reads: number; // views that stayed visible long enough to count as read
    visitors: number;
    devices: { desktop: number; tablet: number; mobile: number }; // visitors per device type
    // Visitors per operating system, of the five shown, and how many have a
    // known one at all (visitors from before it was recorded don't).
    systems: { windows: number; mac: number; ios: number; android: number; linux: number; known: number };
    countries: { code: string; visitors: number }[]; // ISO codes, most visitors first; unknown left out
    new: number; // visitors whose first ever hit on this host is in the period
    newBounced: number; // ...of those, ones with no other hit on this host, ever
};

export type HostDaily = {
    views: number[];
    visitors: number[];
    new: number[];
    reads: number[];
};

export type PageRow = {
    path: string;
    views: number;
    new: number; // visitors whose first ever hit on the host was this page
    daily: number[]; // views per day
    dailyNew: number[]; // new visitors per day
};

export type HostStats = {
    totals: HostTotals;
    daily: HostDaily;
    referrers: Referrer[]; // where views came from, by new visitors then views
    pages: PageRow[]; // by views
};

// The headline numbers for one host, for the sidebar: views (with a daily
// series, for its sparkline) and new visitors.
export type HostSummary = {
    totals: { views: number; new: number };
    daily: { views: number[] };
};

export type Referrer = {
    source: string; // a referring site's domain, or "/path" of a page on this one
    views: number; // views that came from this source
    new: number; // visitors whose first view came from it
    daily: number[];
    dailyNew: number[];
};

// GET /api/overview: everything for one host.
export type Overview = {
    days: number[]; // unix seconds at the start of each UTC day
    stats: HostStats;
};

// GET /api/hosts: every host on a site, by host name.
export type HostSummaries = {
    days: number[];
    hosts: Record<string, HostSummary>;
};
// One configured site: a hostname, with the name the dashboard shows.
export type Site = { host: string; name: string };
