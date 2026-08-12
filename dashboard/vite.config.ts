import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;

// The page builds into dist/dashboard so the published package ships it and
// the local server (src/dashboard-server.ts) can serve it from the same
// process. The dev server proxies /api to a running `dashboard` command.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(here, "src") },
  },
  build: {
    outDir: resolve(here, "../dist/dashboard"),
    emptyOutDir: true,
    // The bundle (React + Recharts) is served from 127.0.0.1 off local disk,
    // not over a network, so a single ~660 kB chunk loads instantly and
    // code-splitting would add complexity for no real gain. Raise the advisory
    // limit rather than leave a misleading warning.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4321",
    },
  },
});
