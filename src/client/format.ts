// Number and date formats shared by the dashboard.

// 950 -> "950", 4321 -> "4.3k", 17694 -> "17.7k", 123456 -> "123k", 1250000 -> "1.3M":
// one decimal at most, and none once there are three digits.
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
  maximumSignificantDigits: 3,
  roundingPriority: "lessPrecision",
});
export const num = (n: number) => compact.format(n).replace("K", "k");
// 2.43 -> "2.4", 3 -> "3".
export const perDevice = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
// Whole percents, but a nonzero share that would round to 0 gets one decimal:
// 0.3 -> "0.3", 0.04 -> "<0.1", 12.6 -> "13".
export const pct = (part: number, whole: number) => {
  const p = whole > 0 ? (part / whole) * 100 : 0;
  if (p === 0 || p >= 0.5) return String(Math.round(p));
  return p < 0.05 ? "<0.1" : p.toFixed(1);
};
// A list row's share of its list, for the bar behind it; none under 0.25%.
export const share = (part: number, whole: number) =>
  whole > 0 && part / whole >= 0.005 ? part / whole : 0;

// "September 19, 2026"; days are UTC.
export const fullDate = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

