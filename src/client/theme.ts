export type Theme = {
    background: string;
    surface: string; // background of the top section
    text: string;
    muted: string;
    // Colour for each stat, used for its number and its chart line.
    stats: { views: string; visitors: string; new: string };
};

export const themes = {
    monokai: {
        background: "#272822",
        surface: "#3E3D32",
        text: "#F8F8F2",
        muted: "#75715E",
        stats: {
            views: "#66D9EF",
            visitors: "#A6E22E",
            new: "#F92672",
        },
    },
    // Alabaster by Nikita Prokopov.
    alabaster: {
        background: "#F7F7F7",
        surface: "#F0F0F0", // line_highlight
        text: "#000000",
        muted: "#777777",
        stats: {
            views: "#325CC0",
            visitors: "#448C27",
            new: "#AA3731",
        },
    },
} satisfies Record<string, Theme>;

export const theme: Theme = themes.alabaster;
