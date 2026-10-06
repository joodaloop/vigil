import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { lookUpDue, lookUpPage, lookUpSource } from "../src/worker/sources.ts";

test("favicon refresh preserves saved icons on failed requests", async (t) => {
    const previousRewriter = globalThis.HTMLRewriter;
    globalThis.HTMLRewriter = class {
        on(selector, handler) {
            if (selector === "head title") handler.text({ text: "Updated name" });
            return this;
        }
        transform(page) {
            return page;
        }
    };
    t.after(() => {
        if (previousRewriter === undefined) delete globalThis.HTMLRewriter;
        else globalThis.HTMLRewriter = previousRewriter;
    });

    let fetchIcon;
    t.mock.method(globalThis, "fetch", async (url) => {
        if (String(url).endsWith("/favicon.ico")) return fetchIcon();
        const page = new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
        Object.defineProperty(page, "url", { value: "https://example.com/" });
        return page;
    });

    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(`CREATE TABLE sources (domain TEXT PRIMARY KEY, name TEXT, icon BLOB, icon_type TEXT, icon_ts INTEGER)`);
    const env = {
        DB: {
            prepare: (sql) => ({
                bind: (...params) => ({
                    run: async () => db.prepare(sql).run(Object.fromEntries(params.map((value, i) => [String(i + 1), value]))),
                }),
            }),
        },
    };
    const saved = new Uint8Array([1, 2, 3]);
    const cases = [
        ["network error", () => { throw new Error("Connection reset"); }, true],
        ["timeout", () => { throw new DOMException("Timed out", "TimeoutError"); }, true],
        ["server error", () => new Response(null, { status: 503 }), true],
        ["rate limit", () => new Response(null, { status: 429 }), true],
        ["broken body", () => new Response(new ReadableStream({
            start(controller) { controller.error(new Error("Connection reset")); },
        }), { headers: { "Content-Type": "image/png" } }), true],
        ["missing", () => new Response(null, { status: 404 }), false],
        ["gone", () => new Response(null, { status: 410 }), false],
        ["not an image", () => new Response("html", { headers: { "Content-Type": "text/html" } }), false],
        ["too large", () => new Response(new Uint8Array(30 * 1024 + 1), {
            headers: { "Content-Type": "image/png" },
        }), false],
    ];
    for (const [label, load, preserve] of cases) {
        db.prepare(`INSERT OR REPLACE INTO sources VALUES (?, ?, ?, ?, ?)`).run(
            "example.com", "Old name", saved, "image/png", 123,
        );
        fetchIcon = load;
        await lookUpSource(env, "example.com");
        const row = db.prepare("SELECT * FROM sources").get();
        assert.equal(row.name, "Updated name", label);
        assert.deepEqual(row.icon, preserve ? saved : null, label);
        assert.equal(row.icon_type, preserve ? "image/png" : null, label);
        assert.equal(row.icon_ts, preserve ? 123 : null, label);
    }
});

test("homepage metadata reads stop at the head or the HTML byte limit", async (t) => {
    const previousRewriter = globalThis.HTMLRewriter;
    t.after(() => {
        if (previousRewriter === undefined) delete globalThis.HTMLRewriter;
        else globalThis.HTMLRewriter = previousRewriter;
    });
    let page;
    let iconRequests = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
        if (String(url).endsWith("/favicon.ico")) {
            iconRequests++;
            return new Response(null, { status: 404 });
        }
        return page;
    });
    t.mock.method(Response.prototype, "arrayBuffer", () => {
        throw new Error("HTML must not be buffered");
    });

    for (const [label, closesHead, chunkSize] of [
        ["head ends before a large body", true, 1024],
        ["head never ends", false, 32 * 1024],
        ["single oversized chunk", false, 256 * 1024],
    ]) {
        let parsedBytes = 0;
        // Simulate the parser reporting the head's end after its first
        // chunk. Measure the bytes it receives, independently of fetching.
        globalThis.HTMLRewriter = class {
            on(selector, handler) {
                if (selector === "head") handler.element({ onEndTag: (callback) => { this.endHead = callback; } });
                return this;
            }
            transform(response) {
                const endHead = this.endHead;
                return new Response(response.body.pipeThrough(new TransformStream({
                    transform(chunk, controller) {
                        parsedBytes += chunk.byteLength;
                        if (closesHead) endHead();
                        controller.enqueue(chunk);
                    },
                })));
            }
        };
        let pulls = 0;
        let canceled = false;
        page = new Response(new ReadableStream({
            pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array(chunkSize));
            },
            cancel() { canceled = true; },
        }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/html" } });
        Object.defineProperty(page, "url", { value: "https://example.com/" });
        const writes = [];
        const env = { DB: { prepare: () => ({ bind: (...params) => ({ run: async () => { writes.push(params); } }) }) } };
        const previousIconRequests = iconRequests;
        await lookUpSource(env, "example.com");
        // Cancellation propagates through the two transform streams.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(canceled, true, label);
        assert.ok(pulls < 10, label);
        assert.ok(parsedBytes <= 128 * 1024, label);
        if (closesHead) {
            assert.equal(writes.length, 1, label);
            assert.equal(iconRequests, previousIconRequests + 1, label);
        } else {
            assert.equal(parsedBytes, 128 * 1024, label);
            assert.equal(writes.length, 0, `${label}: preserve saved metadata`);
            assert.equal(iconRequests, previousIconRequests, label);
        }
    }
});

test("page lookups keep the page's title, and fetch nothing else", async (t) => {
    const previousRewriter = globalThis.HTMLRewriter;
    t.after(() => {
        if (previousRewriter === undefined) delete globalThis.HTMLRewriter;
        else globalThis.HTMLRewriter = previousRewriter;
    });
    // The head's contents, as the parser would report them.
    let head;
    globalThis.HTMLRewriter = class {
        on(selector, handler) {
            const attr = (values) => ({ getAttribute: (n) => values[n] ?? null });
            if (selector === "head title" && head.title) handler.text({ text: head.title });
            if (selector === 'head meta[property="og:title"]' && head.ogTitle) handler.element(attr({ content: head.ogTitle }));
            if (selector === "head link[rel][href]") handler.element(attr({ rel: "icon", href: "/icon.png" }));
            return this;
        }
        transform(page) {
            return page;
        }
    };

    const requested = [];
    let pageStatus = 200;
    t.mock.method(globalThis, "fetch", async (url) => {
        requested.push(String(url));
        if (String(url).endsWith("/icon.png")) {
            return new Response(new Uint8Array([7, 7]), { headers: { "Content-Type": "image/png" } });
        }
        const page = new Response("<html></html>", { status: pageStatus, headers: { "Content-Type": "text/html" } });
        Object.defineProperty(page, "url", { value: String(url) });
        return page;
    });

    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(`CREATE TABLE sources (domain TEXT PRIMARY KEY, name TEXT, icon BLOB, icon_type TEXT, icon_ts INTEGER)`);
    db.exec(`CREATE TABLE pages (host TEXT, path TEXT, title TEXT, claimed_ts INTEGER, PRIMARY KEY (host, path))`);
    db.exec(`INSERT INTO sources VALUES ('blog.example', 'Old name', NULL, NULL, NULL)`);
    const env = {
        DB: {
            prepare: (sql) => ({
                bind: (...params) => ({
                    run: async () => db.prepare(sql).run(Object.fromEntries(params.map((value, i) => [String(i + 1), value]))),
                }),
            }),
        },
    };
    const title = (path) => db.prepare("SELECT title FROM pages WHERE path = ?").get(path)?.title;
    const site = () => ({ ...db.prepare("SELECT name, icon, icon_type FROM sources").get() });

    // Its og:title over its <title>; the site's icon (linked) left alone.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/posts/x', NULL, 1)`);
    head = { ogTitle: "Post X", title: "Post X — Blog" };
    await lookUpPage(env, "blog.example", "/posts/x");
    assert.equal(title("/posts/x"), "Post X");
    assert.deepEqual(requested, ["https://blog.example/posts/x"], "no icon fetched");
    assert.deepEqual(site(), { name: "Old name", icon: null, icon_type: null });

    // Its <title> without an og:title.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/about', NULL, 1)`);
    head = { title: "  About   me " };
    await lookUpPage(env, "blog.example", "/about");
    assert.equal(title("/about"), "About me");

    // A blank og:title doesn't hide its <title>.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/blank', 'Kept', 1)`);
    head = { ogTitle: "   ", title: "Useful page title" };
    await lookUpPage(env, "blog.example", "/blank");
    assert.equal(title("/blank"), "Useful page title");

    // A path that would resolve to another host stays on the site.
    requested.length = 0;
    await lookUpPage(env, "blog.example", "//elsewhere.example/x");
    assert.equal(new URL(requested[0]).host, "blog.example");

    // A page that can't be fetched leaves its title as it was.
    pageStatus = 503;
    await lookUpPage(env, "blog.example", "/posts/x");
    assert.equal(title("/posts/x"), "Post X");
});

test("due lookups fetch only what they claim, the site's icon from its home page", async (t) => {
    const previousRewriter = globalThis.HTMLRewriter;
    t.after(() => {
        if (previousRewriter === undefined) delete globalThis.HTMLRewriter;
        else globalThis.HTMLRewriter = previousRewriter;
    });
    globalThis.HTMLRewriter = class {
        on(selector, handler) {
            const attr = (values) => ({ getAttribute: (n) => values[n] ?? null });
            if (selector === "head title") handler.text({ text: "A title" });
            if (selector === "head link[rel][href]") handler.element(attr({ rel: "icon", href: "/icon.png" }));
            return this;
        }
        transform(page) {
            return page;
        }
    };

    const requested = [];
    t.mock.method(globalThis, "fetch", async (url) => {
        requested.push(String(url));
        if (String(url).endsWith("/icon.png")) {
            return new Response(new Uint8Array([7]), { headers: { "Content-Type": "image/png" } });
        }
        const page = new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
        Object.defineProperty(page, "url", { value: String(url) });
        return page;
    });

    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(`CREATE TABLE sources (domain TEXT PRIMARY KEY, name TEXT, icon BLOB, icon_type TEXT, icon_ts INTEGER,
                                   claimed_ts INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE pages (host TEXT, path TEXT, title TEXT, claimed_ts INTEGER NOT NULL, PRIMARY KEY (host, path))`);
    const named = (params) => Object.fromEntries(params.map((value, i) => [String(i + 1), value]));
    const env = {
        DB: {
            prepare: (sql) => ({
                bind: (...params) => ({
                    all: async () => ({ results: db.prepare(sql).all(named(params)) }),
                    run: async () => db.prepare(sql).run(named(params)),
                }),
            }),
            batch: async (statements) => Promise.all(statements.map((s) => s.all())),
        },
    };
    const claimedAt = (table, key, value) =>
        db.prepare(`SELECT claimed_ts FROM ${table} WHERE ${key} = ?`).get(value)?.claimed_ts;

    // Claimed by another load a moment ago: left to it. The rest are new, so
    // claimed here and fetched: a page for its title only, and the site and
    // another, each from its home page.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/taken', NULL, unixepoch())`);
    await lookUpDue(env, "blog.example", [
        { path: "/a" },
        { path: "/taken" },
        { domain: "blog.example" },
        { domain: "other.example" },
    ]);
    assert.deepEqual(requested.sort(), [
        "https://blog.example/",
        "https://blog.example/a",
        "https://blog.example/icon.png",
        "https://other.example/",
        "https://other.example/icon.png",
    ]);
    assert.equal(db.prepare("SELECT title FROM pages WHERE path = '/a'").get().title, "A title");
    assert.deepEqual(db.prepare("SELECT icon FROM sources WHERE domain = 'blog.example'").get().icon, new Uint8Array([7]));
    // Each stamped as done just now, not left at its lease.
    const now = Date.now() / 1000;
    for (const at of [claimedAt("pages", "path", "/a"), claimedAt("sources", "domain", "other.example")]) {
        assert.ok(Math.abs(at - now) < 5, `claimed_ts ${at}`);
    }

    // Claimed again within 30 days: nothing to do.
    requested.length = 0;
    await lookUpDue(env, "blog.example", [{ path: "/a" }, { domain: "blog.example" }]);
    assert.deepEqual(requested, []);

    // Claimed by a load that never finished: held for 5 minutes, then
    // another takes it.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/held', NULL, unixepoch() - ${30 * 86400 - 60})`);
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/lapsed', NULL, unixepoch() - ${30 * 86400 + 1})`);
    await lookUpDue(env, "blog.example", [{ path: "/held" }, { path: "/lapsed" }]);
    assert.deepEqual(requested, ["https://blog.example/lapsed"]);
});

test("due lookups follow redirects within the budget, five at a time, and release what's left", async (t) => {
    const previousRewriter = globalThis.HTMLRewriter;
    t.after(() => {
        if (previousRewriter === undefined) delete globalThis.HTMLRewriter;
        else globalThis.HTMLRewriter = previousRewriter;
    });
    globalThis.HTMLRewriter = class {
        on(selector, handler) {
            if (selector === "head title") handler.text({ text: "A title" });
            return this;
        }
        transform(page) {
            return page;
        }
    };

    const requested = [];
    let open = 0;
    let mostOpen = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
        assert.equal(init.redirect, "manual");
        requested.push(String(url));
        open++;
        mostOpen = Math.max(mostOpen, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open--;
        // /moved redirects to /moved/, relative to it.
        if (new URL(url).pathname === "/moved") return new Response(null, { status: 301, headers: { Location: "/moved/" } });
        const page = new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
        Object.defineProperty(page, "url", { value: String(url) });
        return page;
    });

    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(`CREATE TABLE sources (domain TEXT PRIMARY KEY, name TEXT, icon BLOB, icon_type TEXT, icon_ts INTEGER,
                                   claimed_ts INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE pages (host TEXT, path TEXT, title TEXT, claimed_ts INTEGER NOT NULL, PRIMARY KEY (host, path))`);
    const named = (params) => Object.fromEntries(params.map((value, i) => [String(i + 1), value]));
    const env = {
        DB: {
            prepare: (sql) => ({
                bind: (...params) => ({
                    all: async () => ({ results: db.prepare(sql).all(named(params)) }),
                    run: async () => db.prepare(sql).run(named(params)),
                }),
            }),
            batch: async (statements) => Promise.all(statements.map((s) => s.all())),
        },
    };
    const page = (path) => db.prepare("SELECT title, claimed_ts FROM pages WHERE path = ?").get(path);

    // A redirect is followed, and counts: /moved takes two of the budget's
    // eight, leaving six pages room, so the last of the eight is released.
    const paths = ["/moved", "/1", "/2", "/3", "/4", "/5", "/6", "/7"];
    await lookUpDue(env, "blog.example", paths.map((path) => ({ path })), 8);
    assert.ok(requested.includes("https://blog.example/moved/"));
    assert.equal(page("/moved").title, "A title");
    assert.equal(requested.length, 8);
    assert.ok(mostOpen <= 5, `${mostOpen} open at once`);
    for (const path of paths.slice(1, 7)) assert.equal(page(path).title, "A title", path);
    assert.deepEqual({ ...page("/7") }, { title: null, claimed_ts: 0 }, "released");

    // So the next load claims it.
    requested.length = 0;
    await lookUpDue(env, "blog.example", [{ path: "/7" }], 8);
    assert.deepEqual(requested, ["https://blog.example/7"]);
    assert.equal(page("/7").title, "A title");
});
