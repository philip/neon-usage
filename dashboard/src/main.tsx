import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapToken } from "./lib/auth";
import { applyTheme, storedTheme } from "./lib/theme";
import "./index.css";

// Apply the theme before first paint (no flash) — the stored choice, or the OS
// preference on first visit.
applyTheme(storedTheme());
// Capture the launch URL's fragment token before render (it stays in the
// address bar so reloads keep working). Under the Vite dev server there is no
// launch URL — it proxies /api to a `dashboard --no-token` process — so treat
// dev as authorized; this branch compiles out of the shipped production build.
const authorized = bootstrapToken() || import.meta.env.DEV;

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App authorized={authorized} />
    </StrictMode>,
  );
}
