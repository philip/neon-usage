import type { HistoryProbeResult, OrganizationSource } from "./consumption-source.js";
import type { OperationContext } from "./operation-context.js";

export type CapabilityState = "supported" | "unsupported_by_plan" | "unknown";

export type CapabilityReport = {
  organizationId: string;
  declaredPlan: {
    raw: string;
    family: "free" | "launch" | "scale" | "agent" | "business" | "enterprise" | "unknown";
  };
  capabilities: {
    projectHistory: CapabilityState;
    branchHistory: CapabilityState;
    currentProjectSnapshots: CapabilityState;
    currentBranchSizes: CapabilityState;
    spendingNotifications: CapabilityState;
    projectQuotas: CapabilityState;
    metricsExport: CapabilityState;
  };
  observedAvailability: { projectHistory: HistoryProbeResult | "not_probed" };
};

export interface CapabilityService {
  inspect(organizationId: string, context?: OperationContext): Promise<CapabilityReport>;
}

type PlanFamily = CapabilityReport["declaredPlan"]["family"];
type DeclaredCapabilities = CapabilityReport["capabilities"];

// Current-period snapshots are Free-compatible; everything else defaults to
// unknown until documentation or live validation says otherwise.
const unknownPlanCapabilities: DeclaredCapabilities = {
  projectHistory: "unknown",
  branchHistory: "unknown",
  currentProjectSnapshots: "supported",
  currentBranchSizes: "supported",
  spendingNotifications: "unknown",
  projectQuotas: "unknown",
  metricsExport: "unknown",
};

// Declared plan capability from public Neon documentation. This table states
// what each plan is documented to include; observedAvailability reports what
// the credential actually reached. projectQuotas stays unknown everywhere
// until quota semantics are live-validated.
const declaredPlanCapabilities: Record<
  Exclude<PlanFamily, "unknown">,
  { probeProjectHistory: boolean; capabilities: DeclaredCapabilities }
> = {
  free: {
    probeProjectHistory: false,
    capabilities: {
      ...unknownPlanCapabilities,
      projectHistory: "unsupported_by_plan",
      branchHistory: "unsupported_by_plan",
      spendingNotifications: "unsupported_by_plan",
      metricsExport: "unsupported_by_plan",
    },
  },
  launch: {
    probeProjectHistory: true,
    capabilities: {
      ...unknownPlanCapabilities,
      projectHistory: "supported",
      branchHistory: "supported",
      spendingNotifications: "supported",
      metricsExport: "unsupported_by_plan",
    },
  },
  scale: {
    probeProjectHistory: true,
    capabilities: {
      ...unknownPlanCapabilities,
      projectHistory: "supported",
      branchHistory: "supported",
      spendingNotifications: "supported",
      metricsExport: "supported",
    },
  },
  agent: {
    probeProjectHistory: true,
    capabilities: {
      ...unknownPlanCapabilities,
      projectHistory: "supported",
      branchHistory: "supported",
    },
  },
  business: {
    probeProjectHistory: true,
    capabilities: {
      ...unknownPlanCapabilities,
      projectHistory: "supported",
    },
  },
  enterprise: {
    probeProjectHistory: true,
    capabilities: {
      ...unknownPlanCapabilities,
      projectHistory: "supported",
      branchHistory: "supported",
    },
  },
};

function planFamily(rawPlan: string): PlanFamily {
  const normalized = rawPlan.toLowerCase();
  return Object.hasOwn(declaredPlanCapabilities, normalized)
    ? (normalized as PlanFamily)
    : "unknown";
}

export function createCapabilityService(source: OrganizationSource): CapabilityService {
  return {
    async inspect(organizationId: string, context?: OperationContext) {
      const organization = await source.getOrganization(organizationId, context);
      const family = planFamily(organization.plan);
      const declared = family === "unknown" ? undefined : declaredPlanCapabilities[family];
      const projectHistory = declared?.probeProjectHistory
        ? await source.probeProjectHistory(organizationId, context)
        : ("not_probed" as const);
      return {
        organizationId,
        declaredPlan: { raw: organization.plan, family },
        capabilities: { ...(declared?.capabilities ?? unknownPlanCapabilities) },
        observedAvailability: { projectHistory },
      };
    },
  };
}
