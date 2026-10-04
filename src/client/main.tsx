import { render } from "@solidjs/web";
import { get } from "./api";
import { App } from "./App";
import { applyTheme } from "./theme";
import type { Site } from "../shared/types";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

applyTheme();

async function start() {
  const { sites } = await get<{ sites: Site[] }>("/api/config");
  if (!sites.length) throw new Error("No sites configured in SITES (wrangler.json)");
  render(() => <App sites={sites} />, root!);
}

start().catch((error) => {
  root.textContent = `Couldn't load Vigil: ${String(error)}`;
});
