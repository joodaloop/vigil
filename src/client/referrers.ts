// Display names for well-known referrers. A domain matches its entry or any
// subdomain of it, so "old.reddit.com" and "l.facebook.com" are covered.
// Anything not listed shows its domain.
const NAMES: Record<string, string> = {
    "google.com": "Google",
    "bing.com": "Bing",
    "duckduckgo.com": "DuckDuckGo",
    "kagi.com": "Kagi",
    "search.brave.com": "Brave Search",
    "ecosia.org": "Ecosia",
    "yandex.ru": "Yandex",
    "baidu.com": "Baidu",
    "news.ycombinator.com": "Hacker News",
    "lobste.rs": "Lobsters",
    "reddit.com": "Reddit",
    "x.com": "Twitter",
    "twitter.com": "Twitter",
    "t.co": "Twitter",
    "bsky.app": "Bluesky",
    "mastodon.social": "Mastodon",
    "threads.net": "Threads",
    "facebook.com": "Facebook",
    "instagram.com": "Instagram",
    "linkedin.com": "LinkedIn",
    "lnkd.in": "LinkedIn",
    "youtube.com": "YouTube",
    "github.com": "GitHub",
    "substack.com": "Substack",
    "medium.com": "Medium",
    "chatgpt.com": "ChatGPT",
    "perplexity.ai": "Perplexity",
    "claude.ai": "Claude",
};

// A source is a referring site's domain, or for a click within the site, the
// path of the page it came from, shown as in the pages list ("posts/x").
export function referrerName(domain: string): string {
    if (domain.startsWith("/")) return domain.replace(/^\/+|\/+$/g, "") || "/";
    for (let d = domain; d.includes("."); d = d.slice(d.indexOf(".") + 1)) {
        if (NAMES[d]) return NAMES[d];
    }
    return domain;
}
