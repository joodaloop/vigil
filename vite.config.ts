import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
    plugins: [solid(), cloudflare()],
});
