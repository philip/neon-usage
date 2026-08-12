import { describe, expectTypeOf, it } from "vitest";
import {
  type BranchConsumptionService,
  type CapabilityService,
  type ConsumptionService,
  type CurrentSnapshotService,
  createBranchConsumptionService,
  createCapabilityService,
  createConsumptionService,
  createCurrentSnapshotService,
  createUsageOverviewService,
  type UsageOverviewService,
} from "../src/index.js";

describe("public application interfaces", () => {
  it("keeps factory results assignable to named service contracts", () => {
    expectTypeOf(createConsumptionService).returns.toMatchTypeOf<ConsumptionService>();
    expectTypeOf(createBranchConsumptionService).returns.toMatchTypeOf<BranchConsumptionService>();
    expectTypeOf(createCurrentSnapshotService).returns.toMatchTypeOf<CurrentSnapshotService>();
    expectTypeOf(createCapabilityService).returns.toMatchTypeOf<CapabilityService>();
    expectTypeOf(createUsageOverviewService).returns.toMatchTypeOf<UsageOverviewService>();
  });
});
