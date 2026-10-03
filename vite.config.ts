/// <reference types="node" />
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
    // WRANGLER_CONFIG picks another Wrangler config, e.g. a gitignored
    // wrangler.prod.json for your own deploy (see README).
    plugins: [solid(), cloudflare({ configPath: process.env.WRANGLER_CONFIG })],
});
