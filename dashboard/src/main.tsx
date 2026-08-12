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
// address bar so reloads keep working).
const authorized = bootstrapToken();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App authorized={authorized} />
    </StrictMode>,
  );
}
