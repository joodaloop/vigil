/// <reference types="node" />
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ mode }) =>
    // A demo (`--mode demo`) is the dashboard alone, with made-up numbers
    // (src/client/demo.ts): static files, no Worker.
    mode === "demo"
        ? { plugins: [solid()], build: { outDir: "dist/demo" } }
        : {
              // WRANGLER_CONFIG picks another Wrangler config, e.g. a gitignored
              // wrangler.prod.json for your own deploy (see README).
              plugins: [solid(), cloudflare({ configPath: process.env.WRANGLER_CONFIG })],
          },
);
