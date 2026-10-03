import { render } from "@solidjs/web";
import { App } from "./App";
import { applyTheme, theme } from "./theme";
import type { SiteConfig } from "../shared/types";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

applyTheme(theme());

async function start() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error(`Config request failed: ${response.status}`);
  const { sites } = (await response.json()) as { sites: SiteConfig[] };
  if (!Array.isArray(sites) || !sites.some((site) => site.hosts?.length)) {
    throw new Error("No dashboard hosts configured in wrangler.json");
  }
  render(() => <App sites={sites} />, root!);
}

start().catch((error) => {
  root.textContent = `Couldn't load Vigil: ${String(error)}`;
});
