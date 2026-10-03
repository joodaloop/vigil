import { createSignal } from "solid-js";

export type Theme = {
    name: string;
    background: string;
    surface: string; // background of the top section
    text: string;
    muted: string;
    // Colour for each stat, used for its number and its chart line.
    stats: { views: string; visitors: string; new: string };
};

// In the order clicking "Vigil" cycles through them. Colours are "#rrggbb",
// which `tint` in App.tsx relies on.
export const themes: Theme[] = [
    {
        name: "Monokai",
        background: "#272822",
        surface: "#3E3D32",
        text: "#F8F8F2",
        muted: "#75715E",
        stats: { views: "#66D9EF", visitors: "#A6E22E", new: "#F92672" },
    },
    // Alabaster by Nikita Prokopov.
    {
        name: "Alabaster",
        background: "#F7F7F7",
        surface: "#F0F0F0", // line_highlight
        text: "#000000",
        muted: "#777777",
        stats: { views: "#325CC0", visitors: "#448C27", new: "#AA3731" },
    },
];

const DEFAULT = "Alabaster";
const KEY = "vigil-theme";

function saved(): Theme {
    let name: string | null = null;
    try {
        name = localStorage.getItem(KEY);
    } catch {}
    return themes.find((t) => t.name === name) ?? themes.find((t) => t.name === DEFAULT)!;
}

const [current, setCurrent] = createSignal(saved());
export const theme = current;

// The colours CSS uses, as variables on <html>.
export function applyTheme(t: Theme) {
    const style = document.documentElement.style;
    style.setProperty("--bg", t.background);
    style.setProperty("--surface", t.surface);
    style.setProperty("--text", t.text);
    style.setProperty("--muted", t.muted);
    style.setProperty("--views", t.stats.views);
    style.setProperty("--visitors", t.stats.visitors);
    style.setProperty("--new", t.stats.new);
}

export function nextTheme() {
    const next = themes[(themes.indexOf(current()) + 1) % themes.length];
    setCurrent(next);
    applyTheme(next);
    try {
        localStorage.setItem(KEY, next.name);
    } catch {}
}
