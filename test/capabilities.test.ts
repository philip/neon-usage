import { describe, expect, it } from "vitest";
import { createCapabilityService } from "../src/capability-service.js";
import type { OrganizationSource } from "../src/consumption-source.js";

describe("CapabilityService.inspect", () => {
  it("detects Free from organization metadata without probing history", async () => {
    let historyWasProbed = false;
    const source: OrganizationSource = {
      getOrganization: async () => ({ id: "org-1", plan: "free" }),
      probeProjectHistory: async () => {
        historyWasProbed = true;
        return "available";
      },
    };

    const result = await createCapabilityService(source).inspect("org-1");

    expect(historyWasProbed).toBe(false);
    expect(result).toEqual({
      organizationId: "org-1",
      declaredPlan: { raw: "free", family: "free" },
      capabilities: {
        projectHistory: "unsupported_by_plan",
        branchHistory: "unsupported_by_plan",
        currentProjectSnapshots: "supported",
        currentBranchSizes: "supported",
        spendingNotifications: "unsupported_by_plan",
        projectQuotas: "unknown",
        metricsExport: "unsupported_by_plan",
      },
      observedAvailability: { projectHistory: "not_probed" },
    });
  });

  it("does not reclassify a declared Launch organization when history is unavailable", async () => {
    const source: OrganizationSource = {
      getOrganization: async () => ({ id: "org-1", plan: "launch" }),
      probeProjectHistory: async () => "temporarily_unavailable",
    };

    const result = await createCapabilityService(source).inspect("org-1");

    expect(result).toEqual({
      organizationId: "org-1",
      declaredPlan: { raw: "launch", family: "launch" },
      capabilities: {
        projectHistory: "supported",
        branchHistory: "supported",
        currentProjectSnapshots: "supported",
        currentBranchSizes: "supported",
        spendingNotifications: "supported",
        projectQuotas: "unknown",
        metricsExport: "unsupported_by_plan",
      },
      observedAvailability: { projectHistory: "temporarily_unavailable" },
    });
  });

  it("can report a paid plan without probing history", async () => {
    let historyWasProbed = false;
    const result = await createCapabilityService({
      getOrganization: async () => ({ id: "org-1", plan: "launch" }),
      probeProjectHistory: async () => {
        historyWasProbed = true;
        return "available";
      },
    }).inspect("org-1", undefined, { probeProjectHistory: false });

    expect(historyWasProbed).toBe(false);
    expect(result.declaredPlan.family).toBe("launch");
    expect(result.observedAvailability.projectHistory).toBe("not_probed");
  });

  it("detects Scale-only metrics export separately from shared paid capabilities", async () => {
    const source: OrganizationSource = {
      getOrganization: async () => ({ id: "org-1", plan: "scale" }),
      probeProjectHistory: async () => "available",
    };

    const result = await createCapabilityService(source).inspect("org-1");

    expect(result.declaredPlan).toEqual({ raw: "scale", family: "scale" });
    expect(result.capabilities).toEqual({
      projectHistory: "supported",
      branchHistory: "supported",
      currentProjectSnapshots: "supported",
      currentBranchSizes: "supported",
      spendingNotifications: "supported",
      projectQuotas: "unknown",
      metricsExport: "supported",
    });
    expect(result.observedAvailability).toEqual({ projectHistory: "available" });
  });

  it.each([
    ["agent", "supported"],
    ["business", "unknown"],
    ["enterprise", "supported"],
  ] as const)("preserves documented %s plan capabilities", async (plan, branchHistory) => {
    const source: OrganizationSource = {
      getOrganization: async () => ({ id: "org-1", plan }),
      probeProjectHistory: async () => "available",
    };

    const result = await createCapabilityService(source).inspect("org-1");

    expect(result.declaredPlan).toEqual({ raw: plan, family: plan });
    expect(result.capabilities).toMatchObject({
      projectHistory: "supported",
      branchHistory,
      spendingNotifications: "unknown",
    });
    expect(result.observedAvailability).toEqual({ projectHistory: "available" });
  });

  it("probes an unrecognized plan without guessing its declared capabilities", async () => {
    const source: OrganizationSource = {
      getOrganization: async () => ({ id: "org-1", plan: "future-plan" }),
      probeProjectHistory: async () => "available",
    };

    const result = await createCapabilityService(source).inspect("org-1");

    expect(result).toEqual({
      organizationId: "org-1",
      declaredPlan: { raw: "future-plan", family: "unknown" },
      capabilities: {
        projectHistory: "unknown",
        branchHistory: "unknown",
        currentProjectSnapshots: "supported",
        currentBranchSizes: "supported",
        spendingNotifications: "unknown",
        projectQuotas: "unknown",
        metricsExport: "unknown",
      },
      observedAvailability: { projectHistory: "available" },
    });
  });

  it.each(["forbidden", "temporarily_unavailable"] as const)(
    "preserves %s for custom plans without declaring them unsupported",
    async (availability) => {
      const result = await createCapabilityService({
        getOrganization: async () => ({ id: "org-1", plan: "custom" }),
        probeProjectHistory: async () => availability,
      }).inspect("org-1");

      expect(result.capabilities.projectHistory).toBe("unknown");
      expect(result.observedAvailability.projectHistory).toBe(availability);
    },
  );
});
