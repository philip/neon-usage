import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { toSourceErrorDetail } from "../src/errors.js";
import {
  createNeonApiSource,
  NeonApiError,
  type NeonSourceEvidence,
} from "../src/neon-api-source.js";

describe("Neon API source", () => {
  it.each(["credential-short", `credential-${"s".repeat(700)}`])(
    "screens full credentials in raw provider message and code before bounding them (%s)",
    async (apiKey) => {
      const source = createNeonApiSource({
        apiKey,
        maxRetries: 0,
        fetch: async () =>
          Response.json(
            { message: `prefix-${apiKey}-suffix`, code: `CODE-${apiKey}-suffix` },
            { status: 403 },
          ),
      });
      const error = await source.getOrganization("org-1").catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        message: "Neon API request failed with HTTP 403: unrecognized error response",
        code: undefined,
      });
      expect(JSON.stringify(toSourceErrorDetail(error))).not.toContain("credential-");
    },
  );

  it.each([
    ["organization", "extra-cursor"],
    ["organization", `prefix-credential-secret-suffix`],
    ["organization", "x".repeat(2001)],
    ["quota", "prefix-credential-secret-suffix"],
    ["project", "page-two"],
    ["project", "x".repeat(2001)],
    ["project", "prefix-credential-secret-suffix"],
  ])(
    "retains only validated endpoint cursors in hash evidence (%s, %s)",
    async (endpoint, cursor) => {
      const records: NeonSourceEvidence[] = [];
      const source = createNeonApiSource({
        apiKey: "credential-secret",
        evidence: {
          sourceAccount: "test",
          retention: "hash_only",
          write: async (record) => {
            records.push(record);
          },
        },
        fetch: async () =>
          Response.json(
            endpoint === "organization"
              ? { id: "org-1", plan: "free", pagination: { cursor } }
              : endpoint === "quota"
                ? { project: { id: "project-1" }, pagination: { cursor } }
                : { projects: [], pagination: { cursor } },
          ),
      });
      if (endpoint !== "project") {
        await (endpoint === "organization"
          ? source.getOrganization("org-1")
          : source.getProjectQuota("project-1"));
        expect(records[0]?.response.cursorOut).toBeNull();
      } else {
        const result = source.getProjectPage(
          {
            organizationId: "org-1",
            from: "2026-08-01T00:00:00Z",
            to: "2026-08-02T00:00:00Z",
            granularity: "daily",
            metrics: ["compute_unit_seconds"],
          },
          null,
        );
        if (cursor === "page-two") {
          expect((await result).nextCursor).toBe(cursor);
          expect(records[0]?.response.cursorOut).toBe(cursor);
        } else {
          await expect(result).rejects.toMatchObject({ name: "NeonResponseError" });
          expect(records.every((record) => record.response.cursorOut === null)).toBe(true);
        }
      }
      expect(JSON.stringify(records)).not.toContain("credential-secret");
      expect(records.every((record) => !record.response.bodyBase64)).toBe(true);
      expect(records.every((record) => (record.response.cursorOut?.length ?? 0) <= 2000)).toBe(
        true,
      );
    },
  );

  it("keeps credential cursors out of durable hash evidence metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "neon-usage-cursor-evidence-"));
    const path = join(directory, "evidence.json");
    try {
      const source = createNeonApiSource({
        apiKey: "credential-secret",
        evidence: {
          sourceAccount: "test",
          retention: "hash_only",
          write: async (record) => {
            writeFileSync(path, JSON.stringify(record));
          },
        },
        fetch: async () =>
          Response.json({
            id: "org-1",
            plan: "free",
            pagination: { cursor: "prefix-credential-secret-suffix" },
          }),
      });
      await source.getOrganization("org-1");
      const evidence = readFileSync(path, "utf8");
      expect(evidence).not.toContain("credential-secret");
      expect(JSON.parse(evidence).response).toMatchObject({ cursorOut: null });
      expect(JSON.parse(evidence).response).not.toHaveProperty("bodyBase64");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["message", "code"])(
    "preserves unrelated diagnostics when only provider %s contains the credential",
    async (field) => {
      const source = createNeonApiSource({
        apiKey: "credential-secret",
        maxRetries: 0,
        fetch: async () =>
          Response.json(
            {
              message: "useful diagnostic",
              code: "USEFUL_CODE",
              [field]: "prefix-credential-secret-suffix",
            },
            { status: 403 },
          ),
      });
      const error = await source.getOrganization("org-1").catch((reason: unknown) => reason);
      expect(toSourceErrorDetail(error)).toMatchObject(
        field === "message"
          ? {
              code: "USEFUL_CODE",
              message: "Neon API request failed with HTTP 403: unrecognized error response",
            }
          : {
              code: "NEON_API_ERROR",
              message: "Neon API request failed with HTTP 403: useful diagnostic",
            },
      );
    },
  );

  it("walks unavailable-only project pages using the same combined item count as its limit", async () => {
    const requested: Array<string | null> = [];
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async (input) => {
        const cursor = new URL(String(input)).searchParams.get("cursor");
        requested.push(cursor);
        return Response.json(
          cursor === null
            ? {
                projects: [],
                unavailable_project_ids: ["project-a"],
                pagination: { cursor: "next" },
              }
            : { projects: [], unavailable_project_ids: ["project-b"] },
        );
      },
    });
    await expect(source.listProjects("org-1", { maxItems: 2 })).resolves.toMatchObject({
      projectIds: [],
      unavailableProjectIds: ["project-a", "project-b"],
    });
    expect(requested).toEqual([null, "next"]);
    await expect(source.listProjects("org-1", { maxItems: 1 })).rejects.toMatchObject({
      kind: "item_limit",
    });
  });
  it.each([200, 403])(
    "suppresses raw credential-bearing request IDs before bounding status %i diagnostics",
    async (status) => {
      const apiKey = `credential-${"s".repeat(300)}`;
      const evidence: unknown[] = [];
      const source = createNeonApiSource({
        apiKey,
        maxRetries: 0,
        evidence: {
          sourceAccount: "test",
          retention: "hash_only",
          write: async (record) => {
            evidence.push(record);
          },
        },
        fetch: async () =>
          Response.json(
            { id: "org-1", plan: "free" },
            { status, headers: { "x-neon-ret-request-id": `prefix-${apiKey}-suffix` } },
          ),
      });
      const result = await source.getOrganization("org-1").catch((error: unknown) => error);
      if (status === 403) expect(result).toHaveProperty("requestId", undefined);
      expect(JSON.stringify([result, evidence])).not.toContain("credential-");
    },
  );
  it("rejects malformed resource IDs before constructing authenticated paths", async () => {
    let fetchCalled = false;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        fetchCalled = true;
        return Response.json({});
      },
    });

    await expect(source.getOrganization("../projects")).rejects.toThrow(
      "organization ID is malformed",
    );
    await expect(source.getProjectSnapshot("project-1?org_id=other")).rejects.toThrow(
      "project ID is malformed",
    );
    expect(fetchCalled).toBe(false);
  });

  it("rejects oversized responses before retaining or parsing them", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "31", "x-request-id": "request-large" },
    });
    const source = createNeonApiSource({
      apiKey: "secret",
      maxResponseBytes: 10,
      fetch: async () => response,
    });

    const error = await source.getOrganization("org-1").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "NeonResponseTooLargeError",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(toSourceErrorDetail(error)).toEqual({
      code: "NEON_RESPONSE_TOO_LARGE",
      message: "Neon API response exceeds the 10-byte limit",
      status: 200,
      requestId: "request-large",
      attempts: 1,
      retryable: false,
    });
  });

  it("exposes bounded structured API errors without printing arbitrary bodies", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ code: "NOT_FOUND", message: "not an organization member\nretry" }),
          { status: 404 },
        ),
    });

    const error = await source.getOrganization("org-1").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "NeonApiError",
      status: 404,
      code: "NOT_FOUND",
      message: "Neon API request failed with HTTP 404: not an organization member retry",
    });
    expect(error).not.toHaveProperty("body");
  });

  it("bounds provider codes and request IDs without exposing malformed response bodies", async () => {
    const secret = "provider-secret-value";
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        new Response(`not-json ${secret}`, {
          status: 500,
          headers: { "x-request-id": `request-${"x".repeat(500)}` },
        }),
    });

    const error = await source.getOrganization("org-1").catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "NeonApiError",
      status: 500,
      message: "Neon API request failed with HTTP 500: unrecognized error response",
    });
    if (!(error instanceof NeonApiError)) throw new Error("Expected NeonApiError");
    expect(error.requestId?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("bounds provider error codes", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        Response.json({ code: `CODE\n${"x".repeat(500)}`, message: "failed" }, { status: 400 }),
    });

    const error = await source.getOrganization("org-1").catch((reason: unknown) => reason);

    if (!(error instanceof NeonApiError)) throw new Error("Expected NeonApiError");
    expect(error.code).not.toContain("\n");
    expect(error.code?.length).toBeLessThanOrEqual(100);
  });

  it("rejects organization metadata attributed to another organization", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => Response.json({ id: "org-other", plan: "free" }),
    });

    await expect(source.getOrganization("org-requested")).rejects.toThrow(
      "Neon returned organization org-other for requested organization org-requested",
    );
  });

  it("maps a project page and preserves an unsafe JSON integer exactly", async () => {
    let requestedUrl = "";
    let authorization = "";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        `{
          "projects": [{
            "project_id": "project-1",
            "periods": [{
              "period_id": "period-1",
              "period_plan": "scale",
              "period_start": "2026-08-01T00:00:00Z",
              "consumption": [{
                "timeframe_start": "2026-08-07T00:00:00Z",
                "timeframe_end": "2026-08-08T00:00:00Z",
                "metrics": [{"metric_name": "compute_unit_seconds", "value": 9007199254740993}]
              }]
            }]
          }],
          "pagination": {"cursor": "next-project"}
        }`,
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const source = createNeonApiSource({ apiKey: "secret", fetch });

    const page = await source.getProjectPage(
      {
        organizationId: "org-1",
        projectIds: ["project-1"],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
      null,
    );

    expect(authorization).toBe("Bearer secret");
    expect(new URL(requestedUrl).searchParams.get("org_id")).toBe("org-1");
    expect(new URL(requestedUrl).searchParams.get("project_ids")).toBe("project-1");
    expect(new URL(requestedUrl).searchParams.get("metrics")).toBe("compute_unit_seconds");
    expect(page).toEqual({
      responseBytes: expect.any(Number),
      projects: [
        {
          projectId: "project-1",
          periods: [
            {
              id: "period-1",
              plan: "scale",
              start: "2026-08-01T00:00:00Z",
              buckets: [
                {
                  start: "2026-08-07T00:00:00Z",
                  end: "2026-08-08T00:00:00Z",
                  metrics: [
                    {
                      name: "compute_unit_seconds",
                      value: "9007199254740993",
                      evidence: {
                        payloadHash: expect.stringMatching(/^sha256:/),
                        sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      nextCursor: "next-project",
    });
  });

  it("maps beta branch history with project and branch attribution", async () => {
    let requestedUrl = "";
    const fetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(
        `{"branches":[{"project_id":"project-1","branch_id":"branch-1","periods":[{"period_id":"period-1","period_plan":"scale","period_start":"2026-08-01T00:00:00Z","period_end":"2026-09-01T00:00:00Z","consumption":[{"timeframe_start":"2026-08-07T00:00:00Z","timeframe_end":"2026-08-08T00:00:00Z","metrics":[{"metric_name":"compute_unit_seconds","value":9007199254740993}]}]}]}],"pagination":{}}`,
        { status: 200 },
      );
    };
    const source = createNeonApiSource({ apiKey: "secret", fetch });

    const page = await source.getBranchPage(
      {
        organizationId: "org-1",
        projectIds: ["project-1"],
        branchIds: ["branch-1"],
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
      null,
    );

    const search = new URL(requestedUrl).searchParams;
    expect(search.get("project_ids")).toBe("project-1");
    expect(search.get("branch_ids")).toBe("branch-1");
    expect(page.branches[0]).toMatchObject({
      projectId: "project-1",
      branchId: "branch-1",
      periods: [
        {
          end: "2026-09-01T00:00:00Z",
          buckets: [{ metrics: [{ value: "9007199254740993" }] }],
        },
      ],
    });
  });

  it("maps plan metadata and Free-compatible current snapshots", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === "/api/v2/organizations/org-1") {
        return Response.json({ id: "org-1", plan: "free" });
      }
      if (path === "/api/v2/projects") {
        return Response.json({
          projects: [{ id: "project-1", name: "Project One" }],
          pagination: {},
        });
      }
      if (path === "/api/v2/projects/project-1") {
        return new Response(
          `{"project":{"id":"project-1","consumption_period_start":"2026-08-01T00:00:00Z","consumption_period_end":"2026-09-01T00:00:00Z","active_time_seconds":3600,"compute_time_seconds":900,"written_data_bytes":1000,"data_transfer_bytes":2000,"data_storage_bytes_hour":9007199254740993}}`,
          { status: 200 },
        );
      }
      if (path === "/api/v2/projects/project-1/branches") {
        expect(url.searchParams.get("sort_by")).toBe("created_at");
        expect(url.searchParams.get("sort_order")).toBe("asc");
        if (url.searchParams.get("cursor") === "next-branch") {
          return new Response(`{"branches":[{"id":"branch-2","logical_size":7}],"pagination":{}}`, {
            status: 200,
          });
        }
        return new Response(
          `{"branches":[{"id":"branch-1","logical_size":9007199254740993}],"pagination":{"next":"next-branch"}}`,
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const source = createNeonApiSource({ apiKey: "secret", fetch });

    await expect(source.getOrganization("org-1")).resolves.toEqual({
      id: "org-1",
      plan: "free",
    });
    await expect(source.listProjects("org-1")).resolves.toEqual({
      projectIds: ["project-1"],
      unavailableProjectIds: [],
    });
    await expect(source.listProjectDirectory("org-1")).resolves.toEqual({
      projects: [{ id: "project-1", name: "Project One" }],
      unavailableProjectIds: [],
    });
    await expect(source.getProjectSnapshot("project-1")).resolves.toMatchObject({
      projectId: "project-1",
      computeTimeSeconds: "900",
      dataStorageByteHours: "9007199254740993",
    });
    await expect(source.listBranchSizes("project-1")).resolves.toMatchObject({
      branches: [
        {
          branchId: "branch-1",
          logicalSizeBytes: "9007199254740993",
          evidence: { sourcePath: "/branches/0/logical_size" },
        },
        {
          branchId: "branch-2",
          logicalSizeBytes: "7",
          evidence: { sourcePath: "/branches/0/logical_size" },
        },
      ],
    });
  });

  it("lists organizations visible to the credential", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        Response.json({
          organizations: [{ id: "org-1", name: "Example", handle: "example", plan: "launch" }],
        }),
    });

    await expect(source.listOrganizations()).resolves.toEqual([
      { id: "org-1", name: "Example", handle: "example", plan: "launch" },
    ]);
  });

  it("reports an omitted branch logical_size as an explicit unknown (live-validated)", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => Response.json({ branches: [{ id: "branch-1" }], pagination: {} }),
    });

    const collection = await source.listBranchSizes("project-1");
    expect(collection.branches).toEqual([
      {
        branchId: "branch-1",
        logicalSizeBytes: null,
        evidence: {
          payloadHash: expect.stringMatching(/^sha256:/),
          sourcePath: "/branches/0",
        },
      },
    ]);
  });

  it("rejects duplicate branch resources across branch-list pages", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return Response.json({
          branches: [{ id: "branch-1", logical_size: 10 }],
          pagination: calls === 1 ? { next: "next" } : {},
        });
      },
    });

    await expect(source.listBranchSizes("project-1")).rejects.toThrow(
      "Neon branch list repeated branch branch-1",
    );
  });

  it("stops a non-adjacent project-list cursor cycle", async () => {
    const cursors = ["cursor-a", "cursor-b", "cursor-a"];
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const cursor = cursors[calls];
      calls += 1;
      if (cursor === undefined) {
        throw new Error("adapter requested a page after detecting the cursor cycle");
      }
      return Response.json({
        projects: Array.from({ length: 400 }, (_, index) => ({
          id: `project-${calls}-${index}`,
          name: `Project ${calls}-${index}`,
        })),
        pagination: { cursor },
      });
    };
    const source = createNeonApiSource({ apiKey: "secret", fetch });

    await expect(source.listProjects("org-1")).rejects.toThrow(
      "Neon project list returned a repeated cursor",
    );
    expect(calls).toBe(3);
  });

  it("treats an empty page echoing its cursor as completion (live-validated)", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({
              projects: [{ id: "project-1", name: "Project One" }],
              pagination: { cursor: "cursor-1" },
            })
          : Response.json({ projects: [], pagination: { cursor: "cursor-1" } });
      },
    });

    await expect(source.listProjectDirectory("org-1")).resolves.toEqual({
      projects: [{ id: "project-1", name: "Project One" }],
      unavailableProjectIds: [],
    });
    expect(calls).toBe(2);
  });

  it("rejects an empty page advancing to a new cursor", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({
              projects: [{ id: "project-1", name: "Project One" }],
              pagination: { cursor: "cursor-1" },
            })
          : Response.json({ projects: [], pagination: { cursor: "cursor-new" } });
      },
    });

    await expect(source.listProjectDirectory("org-1")).rejects.toThrow(
      "Neon project list returned an empty page with a continuation cursor",
    );
  });

  it("rejects a repeated non-empty project page even when every project was seen", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return Response.json({
          projects: [{ id: "project-1", name: "Project One" }],
          pagination: { cursor: "terminal-cursor" },
        });
      },
    });

    await expect(source.listProjectDirectory("org-1")).rejects.toThrow(
      "Neon project list returned a repeated cursor",
    );
    expect(calls).toBe(2);
  });

  it("preserves unavailable project IDs from project inventory", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        Response.json({
          projects: [{ id: "project-1", name: "Project One" }],
          unavailable_project_ids: ["project-2"],
          pagination: {},
        }),
    });

    await expect(source.listProjects("org-1")).resolves.toEqual({
      projectIds: ["project-1"],
      unavailableProjectIds: ["project-2"],
    });
  });

  it.each(["-1", "1.5", "not-a-number", "1".repeat(41)])(
    "rejects invalid consumption integer %s",
    async (value) => {
      const source = createNeonApiSource({
        apiKey: "secret",
        fetch: async () =>
          new Response(
            `{"projects":[{"project_id":"project-1","periods":[{"period_id":"period-1","period_plan":"scale","period_start":"2026-08-01T00:00:00Z","consumption":[{"timeframe_start":"2026-08-07T00:00:00Z","timeframe_end":"2026-08-08T00:00:00Z","metrics":[{"metric_name":"compute_unit_seconds","value":"${value}"}]}]}]}],"pagination":{}}`,
          ),
      });

      await expect(
        source.getProjectPage(
          {
            organizationId: "org-1",
            from: "2026-08-07T00:00:00Z",
            to: "2026-08-08T00:00:00Z",
            granularity: "daily",
            metrics: ["compute_unit_seconds"],
          },
          null,
        ),
      ).rejects.toMatchObject({ name: "NeonResponseError" });
    },
  );

  it("retries a rate-limited GET using Retry-After before returning data", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({ id: "org-1", plan: "scale" });
    };
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(source.getOrganization("org-1")).resolves.toEqual({
      id: "org-1",
      plan: "scale",
    });
    expect(calls).toBe(2);
    expect(delays).toEqual([0]);
  });

  it("charges retry response bodies to the operation response-byte budget", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
          : Response.json({ id: "org-1", plan: "scale" });
      },
      sleep: async () => {},
    });

    await expect(source.getOrganization("org-1", { maxResponseBytes: 31 })).rejects.toMatchObject({
      name: "OperationByteLimitError",
    });
    expect(calls).toBe(2);
  });

  it("charges every consumption retry to the request coordinator", async () => {
    let calls = 0;
    let acquisitions = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
          : Response.json({ projects: [], pagination: {} });
      },
      requestCoordinator: {
        acquire: async () => {
          acquisitions += 1;
        },
      },
      sleep: async () => {},
    });

    await source.getProjectPage(
      {
        organizationId: "org-1",
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
      null,
    );

    expect(acquisitions).toBe(2);
  });

  it("bounds retries and preserves request metadata on the final error", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "x-neon-ret-request-id": "request-1" },
      });
    };
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch,
      random: () => 0,
      sleep: async () => {},
    });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonApiError",
      status: 503,
      requestId: "request-1",
      attempts: 3,
    });
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable client error", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    };
    const source = createNeonApiSource({ apiKey: "secret", fetch });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      status: 400,
      attempts: 1,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("retries a transient network failure", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("connection reset");
      }
      return Response.json({ id: "org-1", plan: "scale" });
    };
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch,
      random: () => 0,
      sleep: async () => {},
    });

    await expect(source.getOrganization("org-1")).resolves.toMatchObject({ id: "org-1" });
    expect(calls).toBe(2);
  });

  it("bounds the entire request by one deadline", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const source = createNeonApiSource({ apiKey: "secret", fetch, requestTimeoutMs: 10 });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonTransportError",
      kind: "timeout",
      retryable: true,
    });
  });

  it("starts transport timeout after queued admission and preserves it across retries", async () => {
    vi.useFakeTimers();
    let admitted!: () => void;
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 4));
        throw new TypeError("retry network error");
      }
      return new Promise(() => {});
    });
    const source = createNeonApiSource({
      apiKey: "secret",
      requestTimeoutMs: 10,
      random: () => 0.012,
      fetch,
      requestCoordinator: {
        acquire: () =>
          new Promise<void>((resolve) => {
            admitted = resolve;
          }),
      },
    });
    let settled = false;
    const request = source.getOrganization("org-1").catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      admitted();
      await vi.advanceTimersByTimeAsync(7);
      expect(fetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      admitted();
      await vi.advanceTimersByTimeAsync(2);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toMatchObject({ kind: "timeout", attempts: 2 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops queued admission on an inventory deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const source = createNeonApiSource({
      apiKey: "secret",
      requestTimeoutMs: 10,
      fetch,
      requestCoordinator: { acquire: async () => new Promise(() => {}) },
    });
    try {
      const request = source
        .listProjectDirectory("org-1", { maxDurationMs: 100 })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(99);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toMatchObject({ kind: "time_limit" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([-(2 ** 40), 2 ** 40])(
    "keeps the transport budget monotonic after a %s ms wall-clock jump",
    async (jump) => {
      vi.useFakeTimers();
      const wallClock = Date.now;
      let offset = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => wallClock() + offset);
      let admitted!: () => void;
      let admissions = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        if (fetch.mock.calls.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 4));
          offset = jump;
          throw new TypeError("retry after clock adjustment");
        }
        return new Promise(() => {});
      });
      const source = createNeonApiSource({
        apiKey: "secret",
        requestTimeoutMs: 10,
        random: () => 0.012,
        fetch,
        requestCoordinator: {
          async acquire() {
            admissions += 1;
            if (admissions > 1)
              await new Promise<void>((resolve) => {
                admitted = resolve;
              });
          },
        },
      });
      let settled = false;
      const request = source.getOrganization("org-1").catch((error: unknown) => {
        settled = true;
        return error;
      });
      try {
        await vi.advanceTimersByTimeAsync(7);
        expect(fetch).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(100);
        offset = -jump;
        admitted();
        await vi.advanceTimersByTimeAsync(2);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(request).resolves.toMatchObject({ kind: "timeout", attempts: 2 });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        clock.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("declines a retry whose server minimum exceeds the configured delay budget", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "10", "x-request-id": "request-2" },
      });
    };
    const source = createNeonApiSource({ apiKey: "secret", fetch, maxRetryDelayMs: 5000 });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      status: 429,
      requestId: "request-2",
      retryable: true,
      retryAfterMs: 10_000,
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  it("bounds arbitrarily large Retry-After metadata", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "999999999999999999999999" },
        }),
    });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonApiError",
      retryAfterMs: 86_400_000,
    });
  });

  it("honors an HTTP-date Retry-After value", async () => {
    const now = Date.UTC(2026, 7, 8, 12, 0, 0);
    let calls = 0;
    const delays: number[] = [];
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "Saturday, 08-Aug-26 12:00:02 GMT" },
        });
      }
      return Response.json({ id: "org-1", plan: "scale" });
    };
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await source.getOrganization("org-1");
    expect(delays).toEqual([2000]);
  });

  it("uses fallback jitter for malformed Retry-After", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("busy", { status: 503, headers: { "retry-after": "-1" } });
      }
      return Response.json({ id: "org-1", plan: "scale" });
    };
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await source.getOrganization("org-1");
    expect(delays).toEqual([125]);
  });

  it("interprets obsolete asctime Retry-After as GMT", async () => {
    const now = Date.UTC(2026, 7, 8, 12, 0, 0);
    let calls = 0;
    const delays: number[] = [];
    const source = createNeonApiSource({
      apiKey: "secret",
      now: () => now,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", {
              status: 503,
              headers: { "retry-after": "Sat Aug  8 12:00:02 2026" },
            })
          : Response.json({ id: "org-1", plan: "scale" });
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await source.getOrganization("org-1");
    expect(delays).toEqual([2000]);
  });

  it("does not send a request when already cancelled", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort("cancelled");
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return Response.json({ id: "org-1", plan: "scale" });
      },
    });

    await expect(
      source.getOrganization("org-1", { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "NeonTransportError",
      kind: "cancelled",
      attempts: 0,
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it("cancels one operation without cancelling another on the shared source", async () => {
    const first = new AbortController();
    const requests: string[] = [];
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async (input, init) => {
        const id = String(input).split("/").at(-1) ?? "";
        requests.push(id);
        if (id === "org-1") {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return Response.json({ id, plan: "scale" });
      },
    });

    const cancelled = source.getOrganization("org-1", { signal: first.signal });
    const successful = source.getOrganization("org-2");
    first.abort("cancelled");

    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    await expect(successful).resolves.toMatchObject({ id: "org-2" });
    // The cancelled operation may never dispatch its request; the invariant
    // is that the other operation on the shared source is unaffected.
    expect(requests).toContain("org-2");
  });

  it("uses a source shutdown signal to cancel all operations", async () => {
    const shutdown = new AbortController();
    const source = createNeonApiSource({
      apiKey: "secret",
      shutdownSignal: shutdown.signal,
      fetch: async (_input, init) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
        return Response.json({ id: "org-1", plan: "scale" });
      },
    });

    const one = source.getOrganization("org-1");
    const two = source.getOrganization("org-2");
    shutdown.abort("shutdown");

    await expect(one).rejects.toMatchObject({ kind: "cancelled" });
    await expect(two).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("keeps the first cancellation classification when fetch settles after the deadline", async () => {
    const controller = new AbortController();
    const source = createNeonApiSource({
      apiKey: "secret",
      requestTimeoutMs: 5,
      maxRetries: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("late fetch failure");
      },
    });

    const request = source.getOrganization("org-1", { signal: controller.signal });
    controller.abort("cancelled first");

    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("does not let a late typed response error mask an earlier cancellation", async () => {
    const controller = new AbortController();
    const source = createNeonApiSource({
      apiKey: "secret",
      requestTimeoutMs: 50,
      maxRetries: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response("{");
      },
    });

    const request = source.getOrganization("org-1", { signal: controller.signal });
    controller.abort("cancelled first");

    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("classifies invalid JSON and invalid response schemas as response errors", async () => {
    const invalidJson = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => new Response("{", { headers: { "x-request-id": "invalid-json" } }),
    });
    const invalidSchema = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => Response.json({ id: "org-1" }),
    });

    await expect(invalidJson.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonResponseError",
      status: 200,
      requestId: "invalid-json",
      attempts: 1,
      retryable: false,
    });
    await expect(invalidSchema.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonResponseError",
      status: 200,
      attempts: 1,
      retryable: false,
    });
  });

  it("writes hash-only source evidence before interpreting a response", async () => {
    const evidence: unknown[] = [];
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        new Response('{"id":"org-1","plan":"scale"}', {
          headers: { "x-request-id": "request-3" },
        }),
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async (record) => {
          evidence.push(record);
        },
      },
      evidenceClock: () => new Date("2026-08-08T12:00:00.000Z"),
    });

    await source.getOrganization("org-1");

    expect(evidence).toEqual([
      expect.objectContaining({
        evidenceId: expect.stringMatching(/^evidence:sha256:/),
        sourceAccount: "account-1",
        sourceContract: "organization-details",
        requestedAt: "2026-08-08T12:00:00.000Z",
        completedAt: "2026-08-08T12:00:00.000Z",
        request: {
          method: "GET",
          path: "/organizations/org-1",
          query: "",
          cursorIn: null,
          fingerprint: expect.stringMatching(/^sha256:/),
        },
        response: {
          status: 200,
          requestId: "request-3",
          cursorOut: null,
          payloadHash: "sha256:38e69c197c77a1380d80029f583eb9bb834defe148fe37e7274fef052efa090a",
        },
        attempt: 1,
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret");
  });

  it("links project pages to retained response bytes", async () => {
    const evidence: Array<{
      evidenceId: string;
      response: { payloadHash: string; bodyBase64?: string };
    }> = [];
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => new Response('{"projects":[],"pagination":{}}'),
      evidence: {
        sourceAccount: "account-1",
        retention: "body",
        write: async (record) => {
          evidence.push(record);
        },
      },
    });

    const page = await source.getProjectPage(
      {
        organizationId: "org-1",
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
      null,
    );

    expect(page.evidence).toEqual({
      evidenceId: evidence[0]?.evidenceId,
      payloadHash: evidence[0]?.response.payloadHash,
    });
    expect(evidence[0]?.response.bodyBase64).toBe("eyJwcm9qZWN0cyI6W10sInBhZ2luYXRpb24iOnt9fQ==");
  });

  it("attaches exact source paths to history metrics", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        Response.json({
          projects: [
            {
              project_id: "project-1",
              periods: [
                {
                  period_id: "period-1",
                  period_plan: "launch",
                  period_start: "2026-08-01T00:00:00Z",
                  consumption: [
                    {
                      timeframe_start: "2026-08-07T00:00:00Z",
                      timeframe_end: "2026-08-08T00:00:00Z",
                      metrics: [{ metric_name: "compute_unit_seconds", value: "3600" }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async () => {},
      },
    });

    const page = await source.getProjectPage(
      {
        organizationId: "org-1",
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
      null,
    );

    expect(page.projects[0]?.periods[0]?.buckets[0]?.metrics[0]?.evidence).toEqual({
      evidenceId: page.evidence?.evidenceId,
      payloadHash: page.evidence?.payloadHash,
      sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
    });
  });

  it("retains metric payload provenance without a configured evidence sink", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () =>
        Response.json({
          projects: [
            {
              project_id: "project-1",
              periods: [
                {
                  period_id: "period-1",
                  period_plan: "launch",
                  period_start: "2026-08-01T00:00:00Z",
                  consumption: [
                    {
                      timeframe_start: "2026-08-07T00:00:00Z",
                      timeframe_end: "2026-08-08T00:00:00Z",
                      metrics: [{ metric_name: "compute_unit_seconds", value: "1" }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
    });

    const page = await source.getProjectPage(
      {
        organizationId: "org-1",
        from: "2026-08-07T00:00:00Z",
        to: "2026-08-08T00:00:00Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
      null,
    );

    expect(page.projects[0]?.periods[0]?.buckets[0]?.metrics[0]?.evidence).toEqual({
      payloadHash: expect.stringMatching(/^sha256:/),
      sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
    });
  });

  it("retains evidence references for current snapshots", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/projects?")) {
          return Response.json({ projects: [{ id: "project-1", name: "One" }] });
        }
        if (url.endsWith("/projects/project-1")) {
          return Response.json({
            project: {
              id: "project-1",
              consumption_period_start: "2026-08-01T00:00:00Z",
              consumption_period_end: "2026-09-01T00:00:00Z",
              active_time_seconds: "0",
              compute_time_seconds: "0",
              written_data_bytes: "0",
              data_transfer_bytes: "0",
              data_storage_bytes_hour: "0",
            },
          });
        }
        return Response.json({ branches: [{ id: "branch-1", logical_size: "10" }] });
      },
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async () => {},
      },
    });

    const inventory = await source.listProjects("org-1");
    const project = await source.getProjectSnapshot("project-1");
    const branches = await source.listBranchSizes("project-1");

    expect(inventory.evidence).toHaveLength(1);
    expect(project.evidence).toMatchObject({ evidenceId: expect.stringMatching(/^evidence:/) });
    expect(project.metricEvidence?.computeTimeSeconds).toMatchObject({
      sourcePath: "/project/compute_time_seconds",
    });
    expect(branches.branches[0]?.evidence).toMatchObject({
      evidenceId: expect.stringMatching(/^evidence:/),
      sourcePath: "/branches/0/logical_size",
    });
  });

  it("uses stable account-scoped evidence identities", async () => {
    const evidenceIds: string[] = [];
    let clock = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => new Response('{"id":"org-1","plan":"scale"}'),
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async (record) => {
          evidenceIds.push(record.evidenceId);
        },
      },
      evidenceClock: () => new Date(`2026-08-08T12:00:0${clock++}.000Z`),
    });
    const otherAccountIds: string[] = [];
    const otherAccount = createNeonApiSource({
      apiKey: "other-secret",
      fetch: async () => new Response('{"id":"org-1","plan":"scale"}'),
      evidence: {
        sourceAccount: "account-2",
        retention: "hash_only",
        write: async (record) => {
          otherAccountIds.push(record.evidenceId);
        },
      },
    });

    await source.getOrganization("org-1");
    await source.getOrganization("org-1");
    await otherAccount.getOrganization("org-1");

    expect(evidenceIds[0]).toBe(evidenceIds[1]);
    expect(otherAccountIds[0]).not.toBe(evidenceIds[0]);
  });

  it("treats evidence sink failures as integrity failures", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => new Response('{"id":"org-1","plan":"scale"}'),
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async () => {
          throw new Error("evidence storage unavailable");
        },
      },
    });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonEvidenceError",
      integrityFailure: true,
    });
  });

  it("preserves timeout classification while an evidence write is pending", async () => {
    let sinkSignal: AbortSignal | undefined;
    const source = createNeonApiSource({
      apiKey: "secret",
      requestTimeoutMs: 5,
      fetch: async () => new Response('{"id":"org-1","plan":"scale"}'),
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async (_record, signal) => {
          sinkSignal = signal;
          await new Promise(() => {});
        },
      },
    });

    await expect(source.getOrganization("org-1")).rejects.toMatchObject({
      name: "NeonTransportError",
      kind: "timeout",
      retryable: true,
    });
    expect(sinkSignal?.aborted).toBe(true);
  });

  it("propagates evidence integrity failures from capability probes", async () => {
    let writes = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async (input) => {
        if (String(input).includes("/organizations/")) {
          return new Response('{"id":"org-1","plan":"scale"}');
        }
        return new Response('{"projects":[],"pagination":{}}');
      },
      evidence: {
        sourceAccount: "account-1",
        retention: "hash_only",
        write: async () => {
          writes += 1;
          if (writes === 2) throw new Error("evidence storage unavailable");
        },
      },
    });

    await source.getOrganization("org-1");
    await expect(source.probeProjectHistory("org-1")).rejects.toMatchObject({
      name: "NeonEvidenceError",
      integrityFailure: true,
    });
  });

  it("classifies scoped-key 404 history denial as forbidden (live-validated)", async () => {
    const source = createNeonApiSource({
      apiKey: "project-scoped",
      maxRetries: 0,
      fetch: async () =>
        Response.json(
          {
            message: "not allowed to perform actions outside the project this key is scoped to",
          },
          { status: 404 },
        ),
    });
    await expect(source.probeProjectHistory("org-1")).resolves.toBe("forbidden");
  });
});

describe("Neon API source hardening", () => {
  it.each(["cooperative", "rejecting", "pending"] as const)(
    "cancels an oversized header body promptly when cancellation is %s",
    async (cancellation) => {
      const pull = vi.fn();
      let rejectCancellation: (reason: Error) => void = () => {};
      const cancel = vi.fn(() => {
        if (cancellation === "rejecting") return Promise.reject(new Error("cancel failed"));
        if (cancellation === "pending")
          return new Promise<void>((_resolve, reject) => {
            rejectCancellation = reject;
          });
      });
      const oversized = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
        headers: { "content-length": "1000" },
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(oversized)
        .mockResolvedValue(Response.json({ id: "org-1", plan: "free" }));
      const acquire = vi.fn(async () => {});
      const write = vi.fn(async () => {});
      const source = createNeonApiSource({
        apiKey: "secret",
        maxResponseBytes: 100,
        requestCoordinator: { acquire },
        evidence: { sourceAccount: "test", retention: "hash_only", write },
        fetch,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          source
            .getOrganization("org-1", { maxResponseBytes: 10 })
            .catch((error: unknown) => error),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("stalled"), 100);
          }),
        ]);
        expect(result).toMatchObject({ name: "OperationByteLimitError", kind: "byte_limit" });
        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledOnce();
        expect(acquire).toHaveBeenCalledOnce();
        expect(write).not.toHaveBeenCalled();
        await expect(source.getOrganization("org-1")).resolves.toMatchObject({ id: "org-1" });
        rejectCancellation(new Error("late cancellation rejection"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(acquire).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenCalledOnce();
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it.each(["exhausted", "remaining", "sufficient"] as const)(
    "charges partial failed response reads when the retry budget is %s",
    async (budget) => {
      const failedChunk = new TextEncoder().encode("partial failed body");
      const completeBody = JSON.stringify({ projects: [] });
      let calls = 0;
      const source = createNeonApiSource({
        apiKey: "secret",
        maxRetries: 1,
        sleep: async () => {},
        random: () => 0,
        fetch: async () => {
          calls += 1;
          if (calls > 1) return new Response(completeBody);
          let reads = 0;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (reads++ === 0) controller.enqueue(failedChunk);
                else controller.error(new Error("stream failed after delivering bytes"));
              },
            }),
          );
        },
      });
      const operation = source.getProjectPage(
        {
          organizationId: "org-1",
          from: "2026-08-07T00:00:00Z",
          to: "2026-08-08T00:00:00Z",
          granularity: "daily",
          metrics: ["compute_unit_seconds"],
        },
        null,
        {
          maxResponseBytes:
            failedChunk.byteLength +
            (budget === "exhausted" ? 0 : budget === "remaining" ? 1 : 100),
        },
      );

      if (budget === "sufficient") {
        await expect(operation).resolves.toMatchObject({
          responseBytes: failedChunk.byteLength + Buffer.byteLength(completeBody),
        });
      } else {
        await expect(operation).rejects.toMatchObject({ kind: "byte_limit" });
      }
      expect(calls).toBe(budget === "exhausted" ? 1 : 2);
    },
  );

  it.each(["organizations", "projects", "branches"] as const)(
    "rejects %s completion after synchronous work exhausts the monotonic deadline",
    async (inventory) => {
      let now = 0;
      const monotonicClock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const source = createNeonApiSource({
        apiKey: "secret",
        fetch: async () => {
          // The event loop has not yielded to the real deadline timer.
          now = 1001;
          return Response.json({ organizations: [], projects: [], branches: [] });
        },
      });
      try {
        const context = { maxDurationMs: 1000 };
        await expect(
          inventory === "organizations"
            ? source.listOrganizations(context)
            : inventory === "projects"
              ? source.listProjectDirectory("org-1", context)
              : source.listBranchSizes("project-1", context),
        ).rejects.toMatchObject({ kind: "time_limit" });
      } finally {
        monotonicClock.mockRestore();
      }
    },
  );

  it.each(["organizations", "projects", "branches"] as const)(
    "rejects %s inventories exceeding the operation item budget",
    async (inventory) => {
      const source = createNeonApiSource({
        apiKey: "secret",
        fetch: async () =>
          Response.json({
            organizations: [
              { id: "org-1", name: "One", handle: "one", plan: "free" },
              { id: "org-2", name: "Two", handle: "two", plan: "free" },
            ],
            projects: [
              { id: "project-1", name: "One" },
              { id: "project-2", name: "Two" },
            ],
            branches: [{ id: "branch-1" }, { id: "branch-2" }],
          }),
      });
      const context = { maxItems: 1 };
      const operation =
        inventory === "organizations"
          ? source.listOrganizations(context)
          : inventory === "projects"
            ? source.listProjectDirectory("org-1", context)
            : source.listBranchSizes("project-1", context);

      await expect(operation).rejects.toMatchObject({ kind: "item_limit" });
    },
  );

  it("charges a shared project/branch item budget before retaining whole inventory pages", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      return Response.json(
        pathname.endsWith("/projects")
          ? { projects: [{ id: "project-1", name: "One" }], unavailable_project_ids: ["project-2"] }
          : {
              branches: pathname.includes("project-1")
                ? [{ id: "branch-1" }, { id: "branch-2" }]
                : [{ id: "branch-3" }],
            },
      );
    });
    const source = createNeonApiSource({ apiKey: "secret", fetch });
    const context = { maxItems: 3, retainedItemBudget: { remaining: 3 } };
    await source.listProjectDirectory("org-1", context);
    expect(context.retainedItemBudget.remaining).toBe(1);
    await expect(source.listBranchSizes("project-1", context)).rejects.toMatchObject({
      kind: "item_limit",
    });
    expect(context.retainedItemBudget.remaining).toBe(1);
    await expect(source.listBranchSizes("project-2", context)).resolves.toMatchObject({
      branches: [{ branchId: "branch-3" }],
    });
    expect(context.retainedItemBudget.remaining).toBe(0);
    await expect(source.listBranchSizes("project-3", context)).rejects.toMatchObject({
      kind: "item_limit",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["organizations", "projects", "branches"] as const)(
    "accounts for pages and cumulative bytes in %s inventories",
    async (inventory) => {
      const payload = JSON.stringify({
        organizations: [{ id: "org-1", name: "One", handle: "one", plan: "free" }],
        projects: [{ id: "project-1", name: "One" }],
        branches: [{ id: "branch-1" }],
        pagination: { cursor: "next", next: "next" },
      });
      for (const [context, expectedCalls] of [
        [{ maxPages: 1 }, 1],
        [{ maxResponseBytes: Buffer.byteLength(payload) }, 1],
        [{ maxResponseBytes: Buffer.byteLength(payload) + 1 }, 2],
      ] as const) {
        let calls = 0;
        const source = createNeonApiSource({
          apiKey: "secret",
          fetch: async () => {
            calls += 1;
            return new Response(payload);
          },
        });
        const operation =
          inventory === "organizations"
            ? source.listOrganizations(context)
            : inventory === "projects"
              ? source.listProjectDirectory("org-1", context)
              : source.listBranchSizes("project-1", context);

        await expect(operation).rejects.toMatchObject({
          kind: "maxPages" in context ? "page_limit" : "byte_limit",
        });
        expect(calls).toBe(expectedCalls);
      }
    },
  );

  it.each(["probe", "spending notification"] as const)(
    "does not turn a %s byte limit into provider unavailability",
    async (operation) => {
      const source = createNeonApiSource({
        apiKey: "secret",
        fetch: async () => Response.json({ projects: [], spending_limit_cents: null }),
      });
      const context = { maxResponseBytes: 1 };
      await expect(
        operation === "probe"
          ? source.probeProjectHistory("org-1", context)
          : source.getSpendingNotification("org-1", context),
      ).rejects.toMatchObject({ kind: "byte_limit" });
    },
  );

  it("rejects an empty project page pointing back to an earlier cursor", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return Response.json({
          projects: calls === 3 ? [] : [{ id: `project-${calls}`, name: "One" }],
          pagination: { cursor: calls === 2 ? "cursor-2" : "cursor-1" },
        });
      },
    });

    await expect(source.listProjectDirectory("org-1")).rejects.toMatchObject({
      integrityFailure: true,
      message: "Neon project list returned an empty page with a continuation cursor",
    });
    expect(calls).toBe(3);
  });

  it("accepts a terminal empty branch page echoing the requested cursor", async () => {
    let calls = 0;
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => {
        calls += 1;
        return Response.json({
          branches: calls === 1 ? [{ id: "branch-1" }] : [],
          pagination: { next: "terminal" },
        });
      },
    });

    await expect(source.listBranchSizes("project-1")).resolves.toMatchObject({
      branches: [{ branchId: "branch-1" }],
    });
    expect(calls).toBe(2);
  });

  it.each(["coordinator", "fetch", "reader", "sleep", "evidence"] as const)(
    "cancels promptly when the injected %s never settles",
    async (phase) => {
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const stall = async () => {
        entered();
        return new Promise<never>(() => {});
      };
      let readerCancelled = false;
      const source = createNeonApiSource({
        apiKey: "secret",
        requestTimeoutMs: 1000,
        ...(phase === "coordinator" ? { requestCoordinator: { acquire: stall } } : {}),
        fetch: async () => {
          if (phase === "fetch") return stall();
          if (phase === "reader") {
            return new Response(
              new ReadableStream({
                pull: stall,
                cancel: () => {
                  readerCancelled = true;
                  return new Promise(() => {});
                },
              }),
            );
          }
          return phase === "sleep"
            ? Response.json({}, { status: 503 })
            : Response.json({ id: "org-1", plan: "free" });
        },
        ...(phase === "sleep" ? { sleep: stall, random: () => 0 } : {}),
        ...(phase === "evidence"
          ? { evidence: { sourceAccount: "test", retention: "hash_only" as const, write: stall } }
          : {}),
      });
      const controller = new AbortController();
      const result = source
        .getOrganization("org-1", { signal: controller.signal })
        .catch((error: unknown) => error);
      await started;
      controller.abort("caller cancelled");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          result,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ kind: "stalled" }), 100);
          }),
        ]);
        expect(settled).toMatchObject({ name: "NeonTransportError", kind: "cancelled" });
        if (phase === "reader") expect(readerCancelled).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it("enforces an inventory deadline even when fetch ignores cancellation", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => new Promise(() => {}),
    });

    await expect(source.listProjectDirectory("org-1", { maxDurationMs: 5 })).rejects.toMatchObject({
      kind: "time_limit",
    });
  });

  it("rejects a project response whose id does not match the request", async () => {
    const source = createNeonApiSource({
      apiKey: "secret",
      fetch: async () => Response.json({ project: { id: "other-project" } }),
    });
    await expect(source.getProjectQuota("wanted-project-1")).rejects.toThrow(
      /returned project other-project for requested project wanted-project-1/,
    );
  });

  it("rejects an empty or control-character API key at construction", () => {
    expect(() => createNeonApiSource({ apiKey: "" })).toThrow(/apiKey/);
    expect(() => createNeonApiSource({ apiKey: "abc\ndef" })).toThrow(/control characters/);
  });
});
