// Types shared by the Worker and dashboard.

export type HostTotals = {
    views: number;
    reads: number; // views that stayed visible long enough to count as read
    visitors: number;
    devices: { desktop: number; tablet: number; mobile: number }; // visitors per device type
    // Visitors per operating system, of the five shown, and how many have a
    // known one at all (visitors from before it was recorded don't).
    systems: { windows: number; mac: number; ios: number; android: number; linux: number; known: number };
    // Visitors per browser engine, and how many have a known browser at all.
    engines: { blink: number; webkit: number; gecko: number; known: number };
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

// A page's or referrer's per-day series: one value per day (`S`), or as the
// API sends them, only the days with one (Sparse).
type RowNumbers<S> = {
    views: number;
    new: number;
    reads: number; // views that counted as read (engaged)
    daily: S; // views per day
    dailyNew: S; // new visitors per day
    dailyReads: S; // reads per day
};

export type PageRow<S = number[]> = RowNumbers<S> & {
    path: string; // `new`: visitors whose first ever hit on the host was this page
    title?: string; // its title, read from it, if it's been looked up and has one
};

export type HostStats<S = number[]> = {
    totals: HostTotals;
    daily: HostDaily;
    referrers: Referrer<S>[]; // where views came from, by new visitors then views
    pages: PageRow<S>[]; // by views
};

// The headline numbers for one host, for the sidebar: views, reads and new
// visitors, for the period and each day (views' and reads' also for its
// sparkline).
export type HostSummary = {
    totals: { views: number; reads: number; new: number };
    daily: { views: number[]; reads: number[]; new: number[] };
};

export type Referrer<S = number[]> = RowNumbers<S> & {
    source: string; // a referring site's domain, or "/path" of a page on this one
    name?: string; // another site's name, from its home page, if it's not a well-known one; a page's title
    icon?: number; // the version of its favicon, served at /api/icon/{source}?v=, if one's saved
    // `views`: views that came from this source; `new`: visitors whose first
    // view came from it
};

// GET /api/overview: everything for one host. Sent with its rows' series
// sparse (Overview<Sparse>).
export type Overview<S = number[]> = {
    days: number[]; // unix seconds at the start of each UTC day
    icon?: number; // the version of the site's own favicon, served at /api/icon/{host}?v=, if one's saved
    stats: HostStats<S>;
};

// GET /api/hosts: every host on a site, by host name.
export type HostSummaries = {
    days: number[];
    hosts: Record<string, HostSummary>;
};
// One configured site: a hostname, with the name the dashboard shows.
export type Site = { host: string; name: string };
