// Sites on the dashboard (each is a cookie domain) and, for each, the hosts
// that get their own panel, in display order. The first site is the default.
export const SITES = [
  {
    site: "joodaloop.com",
    hosts: [
      { host: "map.joodaloop.com", name: "Map of my Internet" },
      { host: "joodaloop.com", name: "JOODALOOP" },
      { host: "webcraft.joodaloop.com", name: "Webcraft" },
      { host: "mac.joodaloop.com", name: "Mac apps" },
      { host: "buy.joodaloop.com", name: "Things You Could Buy" },
    ],
  },
  {
    site: "anjalishriva.com",
    hosts: [{ host: "anjalishriva.com", name: "Anjali Shrivastava" }],
  },
];

export const PERIODS = [7, 30, 90, 365];
export const DEFAULT_PERIOD = 30;
