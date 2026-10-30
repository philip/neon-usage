import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCompactQuantity } from "../dashboard/src/lib/metrics.js";

describe("dashboard usage table markup", () => {
  let server: ViteDevServer;
  let BranchUsageTable: (props: Record<string, unknown>) => ReturnType<typeof createElement>;

  beforeAll(async () => {
    server = await createServer({
      configFile: resolve("dashboard/vite.config.ts"),
      server: { hmr: false, middlewareMode: true },
    });
    ({ BranchUsageTable } = await server.ssrLoadModule(
      "/src/components/branch-usage-table/branch-usage-table.tsx",
    ));
  });

  afterAll(async () => {
    await server.close();
  });

  it("associates grouped columns and preserves canonical mobile labels", () => {
    const html = renderToStaticMarkup(
      createElement(BranchUsageTable, {
        columns: [
          { id: "compute", label: "Compute", unit: "CU-hrs" },
          {
            id: "root",
            label: "Root",
            description: "Root storage",
            group: "Storage",
            unit: "GB-mo",
          },
          {
            id: "branch",
            label: "Branch",
            description: "Branch storage",
            format: formatCompactQuantity,
            group: "Storage",
            unit: "GB-mo",
          },
          {
            id: "active",
            label: "Active",
            description: "Functions active",
            format: formatCompactQuantity,
            group: "Functions",
            unit: "cap-hrs",
          },
          {
            id: "cost",
            label: "Cost",
            format: (value: number) => `$${value.toFixed(2)}`,
            unit: "USD",
          },
        ],
        layout: "table",
        rows: [
          {
            id: "p",
            name: "Project",
            metrics: { compute: 1, root: 2, branch: 0.004, active: 12_345, cost: 0.004 },
          },
        ],
      }),
    );

    expect(html).toContain('<colgroup span="1"></colgroup>');
    expect(html).toContain('<colgroup span="2"></colgroup>');
    expect(html).toContain('scope="colgroup">Storage</th>');
    expect(html).toContain('scope="colgroup">Functions</th>');
    expect(html).toContain('data-label="Storage Root · GB-mo"');
    expect(html).toContain("Root storage (GB-mo):  ");
    expect(html).toContain('aria-label="Approximately 0.004"');
    expect(html).toContain('title="≈0.004">—</span>');
    expect(html.match(/title="≈0\.004">—<\/span>/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Approximately 12,345"');
    expect(html).toContain('tabindex="0" title="≈12,345">12.3K</span>');
  });
});
