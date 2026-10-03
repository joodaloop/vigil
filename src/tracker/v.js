// Vigil tracker. Include on a page with:
//   <script defer src="/_v/v.js"></script>
// where /_v/* is proxied to the Vigil Worker (see README).
//
// A page view is recorded on the first scroll that follows real user input,
// so scroll restoration and #anchor jumps don't count. Once the page has been
// visible for 30 seconds (or data-read-after="N" on the script tag), the view
// also counts as a read.
(function () {
    var script = document.currentScript;
    if (!script) return;
    var base = script.src.replace(/\/[^/]*$/, ""); // ".../_v"
    var readAfterMs = (Number(script.dataset && script.dataset.readAfter) || 30) * 1000;

    var view, timer;

    function now() {
        return Date.now();
    }

    function reset(referrer) {
        view = {
            ref: referrer,
            hitId: null,
            sent: false, // the hit
            input: false,
            visibleMs: 0,
            visibleSince: document.visibilityState === "visible" ? now() : 0,
            read: false, // visible for long enough
            readSent: false,
        };
    }

    function visibleMs(v) {
        return v.visibleMs + (v.visibleSince ? now() - v.visibleSince : 0);
    }

    // Report the read once the view has its hit id, whichever comes last.
    function sendRead(v) {
        if (v.read && v.hitId && !v.readSent) {
            v.readSent = navigator.sendBeacon(base + "/read", JSON.stringify({ id: v.hitId }));
        }
    }

    function check(v) {
        if (!v.read && visibleMs(v) >= readAfterMs) v.read = true;
        sendRead(v);
    }

    // Time the current view's read for when it will have been visible long
    // enough, if it's visible now.
    function arm() {
        clearTimeout(timer);
        var v = view;
        if (v.read || !v.visibleSince) return;
        timer = setTimeout(function () {
            check(v);
        }, readAfterMs - visibleMs(v));
    }

    // Stop the current view's clock, e.g. when it's hidden or left.
    function pause() {
        if (view.visibleSince) view.visibleMs += now() - view.visibleSince;
        view.visibleSince = 0;
        clearTimeout(timer);
        check(view);
    }

    function onInput() {
        view.input = true;
    }

    function onScroll() {
        // The request belongs to this view even if an SPA navigation happens
        // before its response arrives.
        var current = view;
        if (!current.input || current.sent) return;
        current.sent = true;

        var q = new URLSearchParams(location.search);
        var body = {
            h: location.hostname,
            p: location.pathname,
            r: current.ref || undefined,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            us: q.get("utm_source") || undefined,
        };
        fetch(base + "/hit", { method: "POST", body: JSON.stringify(body), keepalive: true })
            .then(function (r) {
                return r.ok ? r.json() : null;
            })
            .then(function (j) {
                if (j) {
                    current.hitId = j.id;
                    sendRead(current);
                }
            })
            .catch(function () {});
    }

    function onVisibility() {
        if (document.visibilityState === "hidden") {
            pause();
        } else {
            if (!view.visibleSince) view.visibleSince = now();
            arm();
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
        pause();
        reset(lastHref);
        arm();
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

    reset(document.referrer);
    arm();
})();
