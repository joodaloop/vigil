// Response shapes shared by the Worker API and the dashboard.

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

// Where a page's views came from.
export type Source = {
    kind: "within" | "host" | "direct" | "referrer";
    label: string; // "Within site", another host, "Direct", or a referrer domain
    views: number;
    new: number;
    // Previous pages, for "within" (this host) and "host" (another subdomain).
    children: { path: string; views: number; new: number }[];
};

export type PageRow = {
    path: string;
    views: number;
    new: number;
    sources: Source[];
};

export type HostStats = {
    totals: HostTotals;
    daily: HostDaily;
    pages: PageRow[];
};

// The whole site, all hosts together.
export type SiteStats = {
    totals: { views: number; visitors: number; new: number }; // new = first hit on the site, ever
    daily: { views: number[]; visitors: number[]; new: number[] };
};

export type Referrer = {
    domain: string;
    visits: number; // arrivals from this referrer
    daily: number[];
};

export type Overview = {
    days: number[]; // unix seconds at the start of each UTC day
    ref: string | null; // active referrer filter
    site: SiteStats;
    referrers: Referrer[]; // all referrers by visits, ignoring the filter
    hosts: Record<string, HostStats>;
};
