// Well-known referrers: their display name, and icon where Tabler has one
// (client/icons.tsx). Used by the collector, to record one domain per source,
// and the dashboard, to show it.
//
// A domain matches its entry or any subdomain of it. `merge` records any of
// those subdomains as the entry itself ("old.reddit.com" is "reddit.com"),
// where they say nothing about where the reader came from; without it they
// stay apart ("someone.substack.com" names the newsletter). `alias` records
// another domain of the same site as that one ("t.co" is "x.com").
type Known = { name: string; icon?: string; merge?: boolean } | { alias: string };

const KNOWN: Record<string, Known> = {
    "google.com": { name: "Google", icon: "google", merge: true },
    "bing.com": { name: "Bing", icon: "bing", merge: true },
    "duckduckgo.com": { name: "DuckDuckGo", icon: "duckduckgo", merge: true },
    "kagi.com": { name: "Kagi", icon: "kagi", merge: true },
    "search.brave.com": { name: "Brave Search", icon: "brave" },
    "ecosia.org": { name: "Ecosia", icon: "ecosia", merge: true },
    "yandex.ru": { name: "Yandex", icon: "yandex", merge: true },
    "baidu.com": { name: "Baidu", icon: "baidu", merge: true },
    "news.ycombinator.com": { name: "Hacker News", icon: "ycombinator" },
    "lobste.rs": { name: "Lobsters", icon: "lobsters", merge: true },
    "reddit.com": { name: "Reddit", icon: "reddit", merge: true },
    "x.com": { name: "Twitter", icon: "twitter", merge: true },
    "twitter.com": { alias: "x.com" },
    "t.co": { alias: "x.com" },
    "bsky.app": { name: "Bluesky", icon: "bluesky", merge: true },
    "mastodon.social": { name: "Mastodon", icon: "mastodon" },
    "threads.net": { name: "Threads", icon: "threads", merge: true },
    "facebook.com": { name: "Facebook", icon: "facebook", merge: true },
    "instagram.com": { name: "Instagram", icon: "instagram", merge: true },
    "linkedin.com": { name: "LinkedIn", icon: "linkedin", merge: true },
    "lnkd.in": { alias: "linkedin.com" },
    "youtube.com": { name: "YouTube", icon: "youtube", merge: true },
    "github.com": { name: "GitHub", icon: "github", merge: true },
    "substack.com": { name: "Substack", icon: "substack" },
    "medium.com": { name: "Medium", icon: "medium" },
    "chatgpt.com": { name: "ChatGPT", icon: "openai", merge: true },
    "perplexity.ai": { name: "Perplexity", icon: "perplexity", merge: true },
    "claude.ai": { name: "Claude", icon: "claude", merge: true },
};

// The entry a domain falls under, and that entry's domain.
function lookup(domain: string): [string, Known] | null {
    for (let d = domain; d.includes("."); d = d.slice(d.indexOf(".") + 1)) {
        if (KNOWN[d]) return [d, KNOWN[d]];
    }
    return null;
}

// The domain to record for a referring site ("www." already dropped).
export function canonicalSource(domain: string): string {
    const found = lookup(domain);
    if (!found) return domain;
    const [root, entry] = found;
    if ("alias" in entry) return entry.alias;
    return entry.merge ? root : domain;
}

function known(domain: string) {
    const entry = lookup(domain)?.[1];
    return entry && !("alias" in entry) ? entry : null;
}

// A source is a referring site's domain, or for a click within the site, the
// path of the page it came from, shown as in the pages list ("posts/x").
export function referrerName(source: string): string {
    if (source.startsWith("/")) return source.replace(/^\/+|\/+$/g, "") || "/";
    return known(source)?.name ?? source;
}

// The icons.tsx key to show beside a source.
export function referrerIcon(source: string): string {
    if (source.startsWith("/")) return "file";
    return known(source)?.icon ?? "link";
}
