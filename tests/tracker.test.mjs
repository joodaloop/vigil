import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/tracker/v.js", import.meta.url), "utf8");

// The tracker in a fake page, with a clock that only moves on tick() (firing
// any timers that come due) and /hit responses resolved by hand.
function tracker(dataset = {}) {
    let time = 1000;
    let timers = [];
    let nextTimer = 1;
    const listeners = new Map();
    const requests = [];
    const attempts = [];
    const reads = [];
    const queueResults = [];
    const listen = (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
    };
    const emit = (event) => listeners.get(event)?.forEach((handler) => handler({ type: event }));
    const location = { href: "https://example.com/a", pathname: "/a", hostname: "example.com", search: "" };
    const document = {
        currentScript: { src: "https://example.com/_v/v.js", dataset },
        visibilityState: "visible",
        referrer: "https://search.example/",
        addEventListener: listen,
    };
    const window = { addEventListener: listen };
    const setUrl = (_state, _title, path) => {
        const url = new URL(path, location.href);
        Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search });
    };
    const history = { pushState: setUrl, replaceState: setUrl };
    vm.runInNewContext(source, {
        document, window, history, location, Intl, URLSearchParams,
        Date: { now: () => time },
        setTimeout: (fn, ms) => {
            timers.push({ id: nextTimer, at: time + ms, fn });
            return nextTimer++;
        },
        clearTimeout: (id) => {
            timers = timers.filter((t) => t.id !== id);
        },
        fetch: (url, options) => new Promise((resolve) => requests.push({ url, body: JSON.parse(options.body), resolve })),
        navigator: {
            sendBeacon(url, body) {
                const payload = { url: url.replace("https://example.com", ""), ...JSON.parse(body) };
                attempts.push(payload);
                const queued = queueResults.shift() ?? true;
                if (queued) reads.push(payload);
                return queued;
            },
        },
    });
    return {
        requests, attempts, reads, queueResults,
        tick(ms) {
            const end = time + ms;
            for (let due; (due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]); ) {
                timers = timers.filter((t) => t !== due);
                time = Math.max(time, due.at);
                due.fn();
            }
            time = end;
        },
        emit,
        scroll() { emit("wheel"); emit("scroll"); },
        navigate(path, method = "pushState") { history[method](null, "", path); },
        hide() { document.visibilityState = "hidden"; emit("visibilitychange"); },
        show() { document.visibilityState = "visible"; emit("visibilitychange"); },
        async resolve(index, id) {
            requests[index].resolve({ ok: true, json: async () => ({ id }) });
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
}

test("a view counts as read after 30 visible seconds, once", async () => {
    const t = tracker();
    t.scroll();
    assert.equal(t.requests[0].body.r, "https://search.example/");
    await t.resolve(0, 101);
    t.tick(29_999);
    assert.deepEqual(t.reads, []);
    t.tick(1);
    assert.deepEqual(t.reads, [{ url: "/_v/read", id: 101 }]);
    t.hide();
    t.show();
    t.tick(60_000);
    assert.equal(t.attempts.length, 1);
});

test("hidden time doesn't count", async () => {
    const t = tracker();
    t.scroll();
    await t.resolve(0, 202);
    t.tick(20_000);
    t.hide();
    t.tick(600_000);
    assert.deepEqual(t.reads, []);
    t.show();
    t.tick(9_999);
    assert.deepEqual(t.reads, []);
    t.tick(1);
    assert.deepEqual(t.reads, [{ url: "/_v/read", id: 202 }]);
});

test("data-read-after sets the threshold", async () => {
    const t = tracker({ readAfter: "10" });
    t.scroll();
    await t.resolve(0, 303);
    t.tick(10_000);
    assert.deepEqual(t.reads, [{ url: "/_v/read", id: 303 }]);
});

test("data-count-on=input counts a view on input alone", () => {
    const t = tracker({ countOn: "input" });
    t.emit("scroll");
    assert.equal(t.requests.length, 0, "scrolling without input still doesn't count");
    t.emit("pointerdown");
    t.emit("wheel");
    assert.equal(t.requests.length, 1, "counted once");

    const plain = tracker();
    plain.emit("pointerdown");
    assert.equal(plain.requests.length, 0, "by default it waits for a scroll");
});

test("a read reached before the hit's id arrives is sent with it", async () => {
    const t = tracker();
    t.tick(40_000); // reading the top, without scrolling
    assert.equal(t.requests.length, 0, "no view until a real scroll");
    t.scroll();
    assert.deepEqual(t.reads, []);
    await t.resolve(0, 404);
    assert.deepEqual(t.reads, [{ url: "/_v/read", id: 404 }]);
});

test("a view never scrolled is never read", () => {
    const t = tracker();
    t.tick(120_000);
    t.hide();
    assert.equal(t.requests.length, 0);
    assert.deepEqual(t.attempts, []);
});

test("late SPA responses read only their own views", async () => {
    const t = tracker();
    t.scroll();
    t.tick(31_000); // /a read, but its id hasn't arrived
    t.navigate("/b");
    t.scroll();
    assert.equal(t.requests[1].body.r, "https://example.com/a");
    await t.resolve(1, 606);
    assert.deepEqual(t.reads, [], "/b has only just started");
    await t.resolve(0, 505);
    assert.deepEqual(t.reads, [{ url: "/_v/read", id: 505 }]);
    t.tick(30_000);
    assert.deepEqual(t.reads.map((r) => r.id), [505, 606]);
});

test("a rejected read is retried when the page is hidden", async () => {
    const t = tracker();
    t.scroll();
    await t.resolve(0, 707);
    t.queueResults.push(false);
    t.tick(30_000);
    assert.deepEqual(t.reads, []);
    t.hide();
    assert.deepEqual(t.reads, [{ url: "/_v/read", id: 707 }]);
    assert.equal(t.attempts.length, 2);
});

test("query and hash changes stay in the same view; path replacement starts another", async () => {
    const t = tracker();
    t.scroll();
    await t.resolve(0, 808);
    t.tick(20_000);
    t.navigate("/a?tab=2#section");
    t.scroll();
    assert.equal(t.requests.length, 1);
    t.tick(10_000);
    assert.deepEqual(t.reads.map((r) => r.id), [808], "the clock kept running");
    t.navigate("/b", "replaceState");
    t.scroll();
    assert.equal(t.requests.length, 2);
    assert.equal(t.requests[1].body.r, "https://example.com/a?tab=2#section");
});
