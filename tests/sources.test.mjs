import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { lookUpPage, lookUpSource } from "../src/worker/sources.ts";

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

test("page lookups keep the page's title, and the site's icon only when it's due", async (t) => {
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

    // Its og:title over its <title>; the site's icon left alone.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/posts/x', NULL, 1)`);
    head = { ogTitle: "Post X", title: "Post X — Blog" };
    await lookUpPage(env, "blog.example", "/posts/x", false);
    assert.equal(title("/posts/x"), "Post X");
    assert.deepEqual(requested, ["https://blog.example/posts/x"], "no icon fetched when the site isn't due");
    assert.equal(site().icon, null);

    // Its <title> without an og:title; with the site due, its icon too (and
    // without an og:site_name, the site keeps its name).
    requested.length = 0;
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/about', NULL, 1)`);
    head = { title: "  About   me " };
    await lookUpPage(env, "blog.example", "/about", true);
    assert.equal(title("/about"), "About me");
    assert.deepEqual(requested, ["https://blog.example/about", "https://blog.example/icon.png"]);
    assert.deepEqual(site(), { name: "Old name", icon: new Uint8Array([7, 7]), icon_type: "image/png" });

    // A blank og:title doesn't hide its <title>.
    db.exec(`INSERT INTO pages VALUES ('blog.example', '/blank', 'Kept', 1)`);
    head = { ogTitle: "   ", title: "Useful page title" };
    await lookUpPage(env, "blog.example", "/blank", false);
    assert.equal(title("/blank"), "Useful page title");

    // A path that would resolve to another host stays on the site.
    requested.length = 0;
    await lookUpPage(env, "blog.example", "//elsewhere.example/x", false);
    assert.equal(new URL(requested[0]).host, "blog.example");

    // A page that can't be fetched leaves its title as it was.
    pageStatus = 503;
    await lookUpPage(env, "blog.example", "/posts/x", false);
    assert.equal(title("/posts/x"), "Post X");
});
