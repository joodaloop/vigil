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

    var view;

    function now() {
        return Date.now();
    }

    function reset(referrer) {
        view = {
            ref: referrer,
            hitId: null,
            sent: false,
            input: false,
            visibleMs: 0,
            visibleSince: document.visibilityState === "visible" ? now() : 0,
            maxScroll: 0,
            pendingEnd: null,
            lastEnd: null,
        };
    }

    // How much of the page has been on screen, 0-100.
    function seen() {
        var h = doc.scrollHeight;
        return h > 0 ? Math.min(100, Math.round(((window.scrollY + window.innerHeight) / h) * 100)) : 100;
    }

    function onInput() {
        view.input = true;
    }

    function onScroll() {
        // The request belongs to this view even if an SPA navigation happens
        // before its response arrives.
        var current = view;
        if (!current.input) return;
        var p = seen();
        if (p > current.maxScroll) current.maxScroll = p;
        if (current.sent) return;
        current.sent = true;

        var q = new URLSearchParams(location.search);
        var body = {
            h: location.hostname,
            p: location.pathname,
            r: current.ref || undefined,
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
                if (j) {
                    current.hitId = j.id;
                    sendEnd(current);
                }
            })
            .catch(function () {});
    }

    function sendEnd(current) {
        var end = current.pendingEnd;
        if (!current.hitId || !end) return;
        if (current.lastEnd && current.lastEnd.e === end.e && current.lastEnd.s === end.s) {
            current.pendingEnd = null;
            return;
        }
        if (navigator.sendBeacon(
            base + "/end",
            JSON.stringify({ id: current.hitId, e: end.e, s: end.s }),
        )) {
            // Only suppress duplicates after the browser accepts the beacon.
            current.lastEnd = end;
            current.pendingEnd = null;
        }
    }

    function flush(current) {
        if (!current.sent) return;
        var ms = current.visibleMs + (current.visibleSince ? now() - current.visibleSince : 0);
        // Keep a snapshot if /hit is still pending, including for an old view.
        current.pendingEnd = { e: Math.round(ms / 1000), s: current.maxScroll };
        sendEnd(current);
    }

    function onVisibility() {
        if (document.visibilityState === "hidden") {
            if (view.visibleSince) view.visibleMs += now() - view.visibleSince;
            view.visibleSince = 0;
            flush(view);
        } else {
            if (!view.visibleSince) view.visibleSince = now();
        }
    }

    // SPA navigations: close out the current view and start a new one, with
    // the previous URL as referrer so the collector sees an internal click.
    // Only path changes count, since only the path is recorded; query and hash
    // updates (filters, tabs, scroll state) stay part of the same view.
    var lastHref = location.href;
    var lastPath = location.pathname;
    function onNavigate() {
        if (location.pathname === lastPath) {
            lastHref = location.href;
            return;
        }
        if (view.visibleSince) view.visibleMs += now() - view.visibleSince;
        view.visibleSince = 0;
        flush(view);
        reset(lastHref);
        lastHref = location.href;
        lastPath = location.pathname;
    }
    ["pushState", "replaceState"].forEach(function (name) {
        var orig = history[name];
        history[name] = function () {
            var result = orig.apply(this, arguments);
            onNavigate();
            return result;
        };
    });
    window.addEventListener("popstate", onNavigate);

    var opts = { passive: true, capture: true };
    ["wheel", "touchmove", "keydown", "pointerdown"].forEach(function (t) {
        window.addEventListener(t, onInput, opts);
    });
    window.addEventListener("scroll", onScroll, opts);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", function () { flush(view); });

    reset(document.referrer);
})();
