import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BranchConsumptionSource,
  createBranchConsumptionService,
  createConsumptionService,
  type ProjectConsumptionSource,
  type SourceProjectConsumption,
} from "../src/index.js";
import { serializeMachineJson } from "../src/machine-json.js";

describe("history properties", () => {
  it.each(["period", "bucket", "metric"] as const)(
    "rejects every generated duplicate %s",
    async (duplicateKind) => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            projectIndex: fc.integer({ min: 1, max: 1000 }),
            value: fc.bigInt({ min: 0n, max: 10n ** 30n }),
          }),
          async ({ projectIndex, value }) => {
            const project = projectFixture(`project-${projectIndex}`, value.toString());
            if (duplicateKind === "period") {
              const period = project.periods[0];
              if (!period) throw new Error("fixture period missing");
              project.periods.push({ ...period, buckets: [] });
            } else if (duplicateKind === "bucket") {
              const bucket = project.periods[0]?.buckets[0];
              if (!bucket) throw new Error("fixture bucket missing");
              project.periods[0]?.buckets.push({
                ...bucket,
                metrics: bucket.metrics.map((metric) => ({ ...metric })),
              });
            } else {
              const metric = project.periods[0]?.buckets[0]?.metrics[0];
              if (!metric) throw new Error("fixture metric missing");
              project.periods[0]?.buckets[0]?.metrics.push({ ...metric });
            }

            await expect(reportFor([project])).rejects.toMatchObject({
              name: "ConsumptionSourceIntegrityError",
            });
          },
        ),
        { numRuns: 25 },
      );
    },
  );

  it("serializes equivalent source permutations identically", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (reverseProjects, reversePeriods, reverseBuckets) => {
          const projects = [projectFixture("project-b", "2"), projectFixture("project-a", "1")];
          for (const project of projects) {
            const secondPeriod = structuredClone(project.periods[0]);
            if (!secondPeriod) throw new Error("fixture period missing");
            secondPeriod.id = `${project.projectId}-period-2`;
            secondPeriod.start = "2026-08-02T00:00:00Z";
            secondPeriod.buckets = [
              {
                start: "2026-08-08T12:00:00Z",
                end: "2026-08-09T00:00:00Z",
                metrics: secondPeriod.buckets[0]?.metrics ?? [],
              },
              {
                start: "2026-08-08T00:00:00Z",
                end: "2026-08-08T12:00:00Z",
                metrics: secondPeriod.buckets[0]?.metrics ?? [],
              },
            ];
            if (reverseBuckets) secondPeriod.buckets.reverse();
            project.periods.push(secondPeriod);
            if (reversePeriods) project.periods.reverse();
          }
          if (reverseProjects) projects.reverse();

          const report = await reportFor(projects);
          const canonical = await reportFor([
            projectFixtureWithTwoPeriods("project-a", "1"),
            projectFixtureWithTwoPeriods("project-b", "2"),
          ]);
          expect(serializeMachineJson(report)).toBe(serializeMachineJson(canonical));
        },
      ),
    );
  });

  it("canonically orders branch history independently of source order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (reverse) => {
        const branches = [
          { projectId: "project-b", branchId: "branch-b", periods: [] },
          { projectId: "project-a", branchId: "branch-z", periods: [] },
          { projectId: "project-a", branchId: "branch-a", periods: [] },
        ];
        if (reverse) branches.reverse();
        const source: BranchConsumptionSource = {
          getBranchPage: async () => ({ branches, nextCursor: null }),
        };
        const report = await createBranchConsumptionService(source, {
          now: () => new Date("2026-08-09T12:30:00Z"),
        }).branchReport({
          ...query,
          projectIds: ["project-a", "project-b"],
        });

        expect(report.branches.map((branch) => `${branch.projectId}/${branch.branchId}`)).toEqual([
          "project-a/branch-a",
          "project-a/branch-z",
          "project-b/branch-b",
        ]);
      }),
    );
  });

  it("rejects one evidence identity with conflicting payload hashes", async () => {
    await fc.assert(
      fc.asyncProperty(hexDigest, hexDigest, async (firstHash, secondHash) => {
        fc.pre(firstHash !== secondHash);
        let calls = 0;
        const source: ProjectConsumptionSource = {
          getProjectPage: async () => {
            calls += 1;
            const payloadHash = `sha256:${calls === 1 ? firstHash : secondHash}`;
            const project = projectFixture(`project-${calls}`, calls.toString());
            const metric = project.periods[0]?.buckets[0]?.metrics[0];
            if (!metric) throw new Error("fixture metric missing");
            metric.evidence = {
              evidenceId: "evidence:same",
              payloadHash,
              sourcePath: `/${project.projectId}/compute_unit_seconds`,
            } as typeof metric.evidence;
            return {
              projects: [project],
              nextCursor: calls === 1 ? "next" : null,
              evidence: {
                evidenceId: "evidence:same",
                payloadHash,
              },
            };
          },
        };

        await expect(
          createConsumptionService(source, {
            now: () => new Date("2026-08-09T12:30:00Z"),
          }).projectReport(query),
        ).rejects.toThrow("conflicting payload hashes");
      }),
      { numRuns: 25 },
    );
  });
});

const hexDigest = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((characters) => characters.join(""));

const query = {
  organizationId: "org-1",
  from: "2026-08-07T00:00:00Z",
  to: "2026-08-09T00:00:00Z",
  granularity: "daily" as const,
  metrics: ["compute_unit_seconds"],
};

async function reportFor(projects: SourceProjectConsumption[]) {
  const source: ProjectConsumptionSource = {
    getProjectPage: async () => ({ projects, nextCursor: null }),
  };
  return createConsumptionService(source, {
    now: () => new Date("2026-08-09T12:30:00Z"),
  }).projectReport(query);
}

function projectFixture(projectId: string, value: string): SourceProjectConsumption {
  return {
    projectId,
    periods: [
      {
        id: `${projectId}-period-1`,
        plan: "launch",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          {
            start: "2026-08-07T00:00:00Z",
            end: "2026-08-08T00:00:00Z",
            metrics: [
              {
                name: "compute_unit_seconds",
                value,
                evidence: {
                  payloadHash: `sha256:${"a".repeat(64)}`,
                  sourcePath: `/${projectId}/compute_unit_seconds`,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function projectFixtureWithTwoPeriods(projectId: string, value: string): SourceProjectConsumption {
  const project = projectFixture(projectId, value);
  const secondPeriod = structuredClone(project.periods[0]);
  if (!secondPeriod) throw new Error("fixture period missing");
  secondPeriod.id = `${projectId}-period-2`;
  secondPeriod.start = "2026-08-02T00:00:00Z";
  secondPeriod.buckets = [
    {
      start: "2026-08-08T00:00:00Z",
      end: "2026-08-08T12:00:00Z",
      metrics: secondPeriod.buckets[0]?.metrics ?? [],
    },
    {
      start: "2026-08-08T12:00:00Z",
      end: "2026-08-09T00:00:00Z",
      metrics: secondPeriod.buckets[0]?.metrics ?? [],
    },
  ];
  project.periods.push(secondPeriod);
  return project;
}
