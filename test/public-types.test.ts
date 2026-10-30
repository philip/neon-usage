import { describe, expect, expectTypeOf, it } from "vitest";
import type { ReportDependencies } from "../src/adapter-support.js";
import { type CapabilityService, createCapabilityService } from "../src/capability-service.js";
import {
  type CollectMeasuredUsageInput,
  createNeonUsageClient,
  type MeasuredUsageHistoryQuery,
  type NeonUsageClient,
  type NeonUsageClientConfig,
} from "../src/client.js";
import type { NeonUsageError, NeonUsageErrorCode } from "../src/client-errors.js";
import {
  type CurrentSnapshotService,
  createCurrentSnapshotService,
} from "../src/current-snapshot-service.js";
import {
  type BranchConsumptionService,
  type ConsumptionService,
  createBranchConsumptionService,
  createConsumptionService,
} from "../src/history-report.js";
import {
  createSlidingWindowRequestCoordinator,
  type RequestCoordinator,
  type SlidingWindowCoordinatorOptions,
} from "../src/index.js";
import {
  createUsageOverviewService,
  type UsageOverviewService,
} from "../src/usage-overview-service.js";

describe("application interfaces", () => {
  it("exports a coordinator that satisfies the public request contract", () => {
    const options: SlidingWindowCoordinatorOptions = { limit: 1, intervalMs: 60_000 };
    const coordinator: RequestCoordinator = createSlidingWindowRequestCoordinator(options);
    expectTypeOf(coordinator).toEqualTypeOf<RequestCoordinator>();
    expectTypeOf(coordinator.acquire).toEqualTypeOf<RequestCoordinator["acquire"]>();
  });

  it("exposes a discriminated client contract without internal ownership controls", () => {
    expectTypeOf(createNeonUsageClient).returns.toEqualTypeOf<NeonUsageClient>();
    expectTypeOf<
      Extract<CollectMeasuredUsageInput, { source: "history" }>["query"]
    >().toEqualTypeOf<MeasuredUsageHistoryQuery | undefined>();
    expectTypeOf<
      "sourceAccount" extends keyof NeonUsageClientConfig ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "producerVersion" extends keyof NeonUsageClientConfig ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<NeonUsageError["cause"]>().toEqualTypeOf<undefined>();
    expectTypeOf<NeonUsageErrorCode>().toEqualTypeOf<
      | "INVALID_INPUT"
      | "AUTHENTICATION_FAILED"
      | "AUTHORIZATION_FAILED"
      | "UNSUPPORTED_CAPABILITY"
      | "PROVIDER_UNAVAILABLE"
      | "COLLECTION_LIMIT_REACHED"
      | "CANCELLED"
      | "CLIENT_BUSY"
      | "CLIENT_CLOSED"
      | "INTEGRITY_FAILURE"
    >();
    const query: MeasuredUsageHistoryQuery = { from: "", to: "", granularity: "daily" };
    const invalid: CollectMeasuredUsageInput[] = [
      // @ts-expect-error history queries require explicit history selection
      { organizationId: "org-1", query: { from: "", to: "", granularity: "daily" } },
      // @ts-expect-error history remains organization-aligned
      { organizationId: "org-1", source: "history", projectIds: ["project-1"] },
      // @ts-expect-error snapshot options cannot contain a history query
      { organizationId: "org-1", source: "current", query },
    ];
    expect(invalid).toHaveLength(3);
  });

  it("keeps factory results assignable to named service contracts", () => {
    expectTypeOf(createConsumptionService).returns.toMatchTypeOf<ConsumptionService>();
    expectTypeOf(createBranchConsumptionService).returns.toMatchTypeOf<BranchConsumptionService>();
    expectTypeOf(createCurrentSnapshotService).returns.toMatchTypeOf<CurrentSnapshotService>();
    expectTypeOf(createCapabilityService).returns.toMatchTypeOf<CapabilityService>();
    expectTypeOf(createUsageOverviewService).returns.toMatchTypeOf<UsageOverviewService>();
  });

  it("keeps history orchestration outside service and adapter contracts", () => {
    expectTypeOf<
      "organizationHistory" extends keyof ConsumptionService ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "organizationHistory" extends keyof ReportDependencies ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      "createOrganizationHistoryService" extends keyof typeof import("../src/index.js")
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<ReturnType<typeof createConsumptionService>>().toEqualTypeOf<ConsumptionService>();
    const service = createConsumptionService({
      getProjectPage: async () => ({ projects: [], nextCursor: null }),
    });
    expectTypeOf(service).toEqualTypeOf<ConsumptionService>();
    expect(Object.keys(service).sort()).toEqual(["organizationSummary", "projectReport"]);
  });
});
