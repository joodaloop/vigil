// Local-only pages for exercising the tracker (enabled by VIGIL_DEV=1 in
// .dev.vars). They're served from the Worker's own origin, so cookies behave
// exactly as they do behind the Netlify proxy.
const PAGES = ["a", "b", "c"];

export function testPage(url: URL): Response {
    const name = url.pathname.split("/")[3] || "a";
    const links = PAGES.map((p) => `<a href="/_v/test/${p}">page ${p}</a>`).join(" · ");
    const para =
        "<p>Scroll to record a page view. Keep the tab visible for 30 seconds to count it as read.</p>";

    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Vigil test: ${name}</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 2rem auto">
  <h1>Test page ${name}</h1>
  <nav>${links} · <a href="/_v/test/${name}?utm_source=test&utm_medium=email">with UTMs</a></nav>
  ${para.repeat(80)}
  <nav>${links}</nav>
  <script defer src="/_v/v.js"></script>
</body>
</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
