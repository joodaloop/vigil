import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/tracker/v.js", import.meta.url), "utf8");

function tracker() {
    let time = 1000;
    const listeners = new Map();
    const requests = [];
    const attempts = [];
    const beacons = [];
    const queueResults = [];
    const listen = (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
    };
    const emit = (event) => listeners.get(event)?.forEach((handler) => handler({ type: event }));
    const location = { href: "https://example.com/a", pathname: "/a", hostname: "example.com", search: "" };
    const document = {
        currentScript: { src: "https://example.com/_v/v.js" },
        documentElement: { scrollHeight: 2000 },
        visibilityState: "visible",
        referrer: "https://search.example/",
        addEventListener: listen,
    };
    const window = { scrollY: 200, innerHeight: 800, addEventListener: listen };
    const setUrl = (_state, _title, path) => {
        const url = new URL(path, location.href);
        Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search });
    };
    const history = { pushState: setUrl, replaceState: setUrl };
    vm.runInNewContext(source, {
        document, window, history, location, Intl, URLSearchParams,
        Date: { now: () => time },
        fetch: (url, options) => new Promise((resolve) => requests.push({ url, body: JSON.parse(options.body), resolve })),
        navigator: {
            sendBeacon(url, body) {
                const payload = JSON.parse(body);
                attempts.push(payload);
                const queued = queueResults.shift() ?? true;
                if (queued) beacons.push(payload);
                return queued;
            },
        },
    });
    return {
        requests, attempts, beacons, queueResults, emit,
        tick(ms) { time += ms; },
        scroll(y = 200) { window.scrollY = y; emit("wheel"); emit("scroll"); },
        navigate(path, method = "pushState") { history[method](null, "", path); },
        hide() { document.visibilityState = "hidden"; emit("visibilitychange"); },
        show() { document.visibilityState = "visible"; emit("visibilitychange"); },
        async resolve(index, id) {
            requests[index].resolve({ ok: true, json: async () => ({ id }) });
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
}

test("late SPA responses keep each view's ID, time, and scroll depth", async () => {
    const t = tracker();
    t.scroll();
    t.tick(2000);
    t.navigate("/b");
    t.scroll(800);
    assert.equal(t.requests[1].body.r, "https://example.com/a");
    await t.resolve(1, 202);
    assert.equal(t.beacons.length, 0, "a visible view should wait until it is flushed");
    t.tick(5000);
    await t.resolve(0, 101);
    t.hide();
    assert.deepEqual(t.beacons, [{ id: 101, e: 2, s: 50 }, { id: 202, e: 5, s: 80 }]);
});

test("a view hidden before its hit response sends its pending metrics", async () => {
    const t = tracker();
    t.scroll();
    t.tick(4000);
    t.hide();
    t.emit("pagehide");
    assert.equal(t.attempts.length, 0);
    t.tick(10000);
    await t.resolve(0, 303);
    assert.deepEqual(t.beacons, [{ id: 303, e: 4, s: 50 }]);
    t.emit("pagehide");
    assert.equal(t.attempts.length, 1);
});

test("pending metrics survive visibility changes without counting hidden time", async () => {
    const t = tracker();
    t.scroll();
    t.tick(2000);
    t.hide();
    t.tick(10000);
    t.show();
    t.tick(3000);
    await t.resolve(0, 404);
    assert.deepEqual(t.beacons, [{ id: 404, e: 2, s: 50 }]);
    t.hide();
    assert.deepEqual(t.beacons[1], { id: 404, e: 5, s: 50 });
});

test("hidden and pagehide deduplicate, but later time and scroll still send", async () => {
    const t = tracker();
    t.scroll();
    await t.resolve(0, 505);
    t.tick(2000);
    t.hide();
    t.emit("pagehide");
    assert.equal(t.attempts.length, 1);
    t.show();
    t.scroll(1000);
    t.hide();
    assert.deepEqual(t.beacons[1], { id: 505, e: 2, s: 90 });
    t.show();
    t.tick(3000);
    t.hide();
    assert.deepEqual(t.beacons[2], { id: 505, e: 5, s: 90 });
});

test("a rejected beacon may be retried with identical metrics", async () => {
    const t = tracker();
    t.scroll();
    await t.resolve(0, 606);
    t.queueResults.push(false, true);
    t.hide();
    t.emit("pagehide");
    t.emit("pagehide");
    assert.equal(t.attempts.length, 2);
    assert.deepEqual(t.beacons, [{ id: 606, e: 0, s: 50 }]);
});

test("query and hash changes stay in the same view; path replacement starts another", async () => {
    const t = tracker();
    t.scroll();
    await t.resolve(0, 707);
    t.navigate("/a?tab=2#section");
    t.scroll();
    assert.equal(t.requests.length, 1);
    assert.equal(t.beacons.length, 0);
    t.navigate("/b", "replaceState");
    t.scroll();
    assert.equal(t.requests.length, 2);
    assert.equal(t.requests[1].body.r, "https://example.com/a?tab=2#section");
    await t.resolve(1, 808);
    t.hide();
    assert.deepEqual(t.beacons.map((b) => b.id), [707, 808]);
});
