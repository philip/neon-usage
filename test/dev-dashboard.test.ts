import { describe, expect, it } from "vitest";
import { devDashboardCommands, exitCodeForChild } from "../scripts/dev-dashboard.js";

describe("devDashboardCommands", () => {
  const commands = devDashboardCommands();
  const byName = Object.fromEntries(commands.map((c) => [c.name, c.command]));

  it("runs exactly the api and web processes", () => {
    expect(commands.map((c) => c.name)).toEqual(["api", "web"]);
  });

  it("serves the api with demo data on the proxy's fixed port, token off", () => {
    // vite.config.ts proxies /api to 127.0.0.1:4321, so the port must match and
    // the demo/token posture is what keeps the open port safe. Guard all four.
    expect(byName.api).toContain("--port 4321");
    expect(byName.api).toContain("--demo");
    expect(byName.api).toContain("--no-token");
    expect(byName.api).toContain("--no-open");
  });

  it("never serves real account data on the unauthenticated loop", () => {
    // The safety invariant of Proposal 1: the token-off server is demo-only.
    expect(byName.api).toContain("--demo");
  });

  it("runs the Vite dev server for the page", () => {
    expect(byName.web).toBe("npm --prefix dashboard run dev");
  });
});

describe("exitCodeForChild", () => {
  it("treats Ctrl+C and our own teardown as a clean quit", () => {
    expect(exitCodeForChild(null, "SIGINT")).toBe(0);
    expect(exitCodeForChild(null, "SIGTERM")).toBe(0);
  });

  it("propagates a nonzero exit code", () => {
    expect(exitCodeForChild(127, null)).toBe(127); // missing binary via the shell
    expect(exitCodeForChild(1, null)).toBe(1);
  });

  it("passes a normal zero exit through", () => {
    expect(exitCodeForChild(0, null)).toBe(0);
  });

  it("fails on a crash signal like SIGSEGV", () => {
    expect(exitCodeForChild(null, "SIGSEGV")).toBe(1);
  });
});
