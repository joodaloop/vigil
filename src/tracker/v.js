// Vigil tracker. Include on a page with:
//   <script defer src="/_v/v.js"></script>
// where /_v/* is proxied to the Vigil Worker (see README).
//
// A page view is recorded on the first scroll that follows real user input,
// so scroll restoration and #anchor jumps don't count. When the page is hidden,
// a beacon reports visible time and max scroll depth for that view.
(function () {
    var script = document.currentScript;
    if (!script) return;
    var base = script.src.replace(/\/[^/]*$/, ""); // ".../_v"
    var doc = document.documentElement;

    var ref, hitId, sent, input, visibleMs, visibleSince, maxScroll;

    function now() {
        return Date.now();
    }

    function reset(referrer) {
        ref = referrer;
        hitId = null;
        sent = false;
        input = false;
        visibleMs = 0;
        visibleSince = document.visibilityState === "visible" ? now() : 0;
        maxScroll = 0;
    }

    // How much of the page has been on screen, 0-100.
    function seen() {
        var h = doc.scrollHeight;
        return h > 0 ? Math.min(100, Math.round(((window.scrollY + window.innerHeight) / h) * 100)) : 100;
    }

    function onInput() {
        input = true;
    }

    function onScroll() {
        if (!input) return;
        var p = seen();
        if (p > maxScroll) maxScroll = p;
        if (sent) return;
        sent = true;

        var q = new URLSearchParams(location.search);
        var body = {
            h: location.hostname,
            p: location.pathname,
            r: ref || undefined,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            us: q.get("utm_source") || undefined,
            um: q.get("utm_medium") || undefined,
            uc: q.get("utm_campaign") || undefined,
        };
        fetch(base + "/hit", { method: "POST", body: JSON.stringify(body), keepalive: true })
            .then(function (r) {
                return r.ok ? r.json() : null;
            })
            .then(function (j) {
                if (j) hitId = j.id;
            })
            .catch(function () {});
    }

    function flush() {
        if (!hitId) return;
        var ms = visibleMs + (visibleSince ? now() - visibleSince : 0);
        navigator.sendBeacon(
            base + "/end",
            JSON.stringify({ id: hitId, e: Math.round(ms / 1000), s: maxScroll }),
        );
    }

    function onVisibility() {
        if (document.visibilityState === "hidden") {
            if (visibleSince) visibleMs += now() - visibleSince;
            visibleSince = 0;
            flush();
        } else {
            visibleSince = now();
        }
    }

    // SPA navigations: close out the current view and start a new one, with
    // the previous URL as referrer so the collector sees an internal click.
    var lastHref = location.href;
    function onNavigate() {
        if (location.href === lastHref) return;
        if (visibleSince) visibleMs += now() - visibleSince;
        visibleSince = 0;
        flush();
        reset(lastHref);
        lastHref = location.href;
    }
    var push = history.pushState;
    history.pushState = function () {
        push.apply(this, arguments);
        onNavigate();
    };
    window.addEventListener("popstate", onNavigate);

    var opts = { passive: true, capture: true };
    ["wheel", "touchmove", "keydown", "pointerdown"].forEach(function (t) {
        window.addEventListener(t, onInput, opts);
    });
    window.addEventListener("scroll", onScroll, opts);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);

    reset(document.referrer);
})();
