import { render } from "@solidjs/web";
import { App } from "./App";
import { applyTheme } from "./theme";
import type { Site } from "../shared/types";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

applyTheme();

async function start() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error(`Config request failed: ${response.status}`);
  const { sites } = (await response.json()) as { sites: Site[] };
  if (!sites.length) throw new Error("No sites configured in SITES (wrangler.json)");
  render(() => <App sites={sites} />, root!);
}

start().catch((error) => {
  root.textContent = `Couldn't load Vigil: ${String(error)}`;
});
