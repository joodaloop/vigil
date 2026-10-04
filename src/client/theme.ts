// Alabaster by Nikita Prokopov. Colours are #rrggbb, which `tint` in App.tsx relies on.
export const theme = {
  background: "#F7F7F7",
  surface: "#F0F0F0", // line_highlight
  text: "#000000",
  muted: "#777777",
  stats: { views: "#325CC0", visitors: "#448C27", new: "#AA3731" },
};

// The colours CSS uses, as variables on <html>.
export function applyTheme() {
  const style = document.documentElement.style;
  style.setProperty("--bg", theme.background);
  style.setProperty("--surface", theme.surface);
  style.setProperty("--text", theme.text);
  style.setProperty("--muted", theme.muted);
  style.setProperty("--views", theme.stats.views);
  style.setProperty("--visitors", theme.stats.visitors);
  style.setProperty("--new", theme.stats.new);
}
