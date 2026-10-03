import { render } from "solid-js/web";
import { App } from "./App";
import { theme } from "./theme";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const style = document.documentElement.style;
style.setProperty("--bg", theme.background);
style.setProperty("--surface", theme.surface);
style.setProperty("--text", theme.text);
style.setProperty("--muted", theme.muted);

render(() => <App />, root);
