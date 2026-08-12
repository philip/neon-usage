// Minimal client-side views of the report JSON the local server returns.
// The server (src/dashboard-server.ts) is the contract owner; these types
// name only the fields the page reads.

export type Coverage = {
  status: "complete" | "partial";
  pageCount?: number;
  entityCount?: number;
  qualityFlags?: string[];
  errors?: string[];
};

export type DerivedTotal = {
  name: string;
  raw: { value: string; unit: string };
  derived: { decimalApproximation: string; unit: string } | null;
};

export type UsageOverview = {
  generatedAt: string;
  asOf: string;
  organization: { id: string; name: string | null; plan: string | null };
  effectiveRange: { from: string; to: string; granularity: string };
  coverage: Coverage;
  servedFromStore?: { from: string; to: string; collectedAt: string };
  /** Null under partial coverage: authoritative totals are suppressed. */
  totals: DerivedTotal[] | null;
  activeProjects: Array<{
    projectId: string;
    name: string | null;
    metrics: Array<{
      name: string;
      rawValue: string;
      rawUnit: string;
      displayValue: string;
      displayUnit: string;
    }>;
  }>;
  observedProjectCount: number;
  unavailableProjectIds: string[];
  enrichmentWarnings: string[];
};

export type ProjectReport = {
  generatedAt: string;
  asOf: string;
  coverage: Coverage;
  effectiveRange: { from: string; to: string; granularity: string };
  servedFromStore?: { from: string; to: string; collectedAt: string };
  projects: Array<{
    projectId: string;
    periods: Array<{
      id: string;
      plan: string;
      buckets: Array<{
        start: string;
        end: string;
        metrics: Array<{
          name: string;
          value: string | null;
          rawUnit: string;
          presence: "reported" | "projected_zero" | "unknown";
        }>;
      }>;
    }>;
  }>;
};

export type EstimateLine = {
  projectId: string;
  billingPeriod: { plan: string; start: string; end?: string };
  allowanceWindow: { start: string; end: string };
  metric: string;
  status: "estimated" | "not_billed" | "unavailable";
  raw: { value: string; unit: string };
  allowanceApplied?: { rawQuantity: string; scope: string };
  billable?: { value: string; unit: string };
  ratePerUnit?: string;
  amount?: { decimalApproximation: string };
  approximations?: string[];
  unavailableReason?: string;
};

export type PricingEstimate = {
  disposition: "estimate";
  generatedAt: string;
  asOf: string;
  effectiveRange: { from: string; to: string; granularity: string };
  status:
    | "estimated"
    | "unavailable_partial_coverage"
    | "unavailable_rate_card_dates"
    | "unavailable_unpriced_lines";
  exclusions: string[];
  lines: EstimateLine[];
  totalsByMetric: Array<{ metric: string; amount: { decimalApproximation: string } }> | null;
  totalAmount: { decimalApproximation: string } | null;
  rateCard: { revision: string; retrievedAt: string; sourceUrls: string[] };
};

export type SnapshotReport = {
  generatedAt: string;
  organizationId: string;
  coverage: {
    status: "complete" | "partial";
    projectsRequested: number;
    projectsReturned: number;
    errors: Array<{ projectId: string | null; source: string; message: string }>;
  };
  projects: Array<{
    projectId: string;
    period: { start: string; end: string };
    metrics: {
      activeTimeSeconds: string;
      computeTimeSeconds: string;
      writtenDataBytes: string;
      dataTransferBytes: string;
      dataStorageByteHours: string;
    };
    branchStorage: {
      status: "available" | "unavailable";
      totalLogicalSizeBytes: string | null;
      branches: Array<{
        branchId: string;
        name?: string | null;
        logicalSizeBytes: string | null;
      }>;
    };
  }>;
};

export type UtilizationMetric = {
  used: string;
  limit: string | null;
  percentUsed: string | null;
  /** True when `used` is only a lower bound (an unknown branch size could push
   * the real usage higher). */
  usedIsLowerBound?: boolean;
};

export type UtilizationReport = {
  generatedAt: string;
  organizationId: string;
  spendingNotification:
    | { status: "configured"; spendingLimitCents: string; semantics: "alert_only" }
    | { status: "not_configured"; semantics: "alert_only" }
    | { status: "unavailable"; detail: { code: string; message: string; status?: number } };
  coverage: {
    status: "complete" | "partial";
    projectsRequested: number;
    projectsReturned: number;
    errors: Array<{ projectId: string; message: string }>;
  };
  projects: Array<{
    projectId: string;
    periodEnd: string | null;
    metrics: {
      activeTimeSeconds: UtilizationMetric;
      computeTimeSeconds: UtilizationMetric;
      writtenDataBytes: UtilizationMetric;
      dataTransferBytes: UtilizationMetric;
      largestBranchLogicalSizeBytes: UtilizationMetric;
    };
  }>;
};

export type Organization = { id: string; name: string | null; plan?: string };

export type ProjectDirectory = {
  projects: Array<{ id: string; name: string }>;
  unavailableProjectIds: string[];
};

export type ContextReport = {
  organizationId: string | null;
  projectId: string | null;
  branch: string | null;
  credential: string;
};
