export type ColumnMappingToType<
    T extends (typeof ColumnMappings)[keyof typeof ColumnMappings],
> = T extends `blob${number}`
    ? string
    : T extends `double${number}`
      ? number
      : never;

export const ColumnMappings = {
    host: "blob1",
    userAgent: "blob2",
    path: "blob3",
    country: "blob4",
    referrer: "blob5",
    browserName: "blob6",
    deviceModel: "blob7",
    siteId: "blob8",
    browserVersion: "blob9",
    deviceType: "blob10",
    utmSource: "blob11",
    utmMedium: "blob12",
    utmCampaign: "blob13",
    utmTerm: "blob14",
    utmContent: "blob15",

    newVisitor: "double1",
    newSession: "double2",
    bounce: "double3",
} as const;
