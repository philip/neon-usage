import { deepFreeze, type KnownMetricName } from "./metric-catalog.js";

export type AllowanceScope = "per_project" | "per_organization";

export type RateCardAllowance = {
  /** Raw v2 metric the allowance nets against. */
  metric: KnownMetricName;
  scope: AllowanceScope;
  /** Raw units (for transfer metrics: bytes) included per billing period. */
  rawQuantityPerBillingPeriod: string;
  /** Metrics with the same pool ID draw from one allowance quantity. */
  sharedPool?: string;
  sourceUrl: string;
};

export type RateCardPlan = {
  /** Matches a lowercased v2 `period_plan` value. */
  planFamily: string;
  /** Rates/allowances are assumed defaults (documented as matching another
   * plan), not directly published for this plan; estimates carry
   * PLAN_RATES_ASSUMED. */
  ratesAssumed?: true;
  /**
   * "metered" plans multiply billable quantities by rates; "not_billed"
   * plans (Free) accrue no charges — their limits suspend service instead.
   */
  billing: "metered" | "not_billed";
  /**
   * USD per derived billing unit (cu_hour, gb_month, gb,
   * branch_month_before_allowance, capacity_hour, million_invocations), keyed
   * by raw metric name. A metric with no entry has no published rate and must
   * produce an unavailable estimate, never a guessed one.
   */
  ratesPerDerivedUnit: Partial<Record<KnownMetricName, string>>;
  allowances: RateCardAllowance[];
  /**
   * Documented included child branches per project (included branches minus
   * the root). Used to net extra_branches_month; hourly evaluation is the
   * documented rule, so coarser granularities carry an approximation flag.
   */
  includedChildBranchesPerProject?: number;
};

export type RateCard = {
  /** Immutable identity of this card's contents. */
  revision: string;
  currency: "USD";
  /** Where the numbers came from and when they were read. */
  provenance: "documentation" | "contract_override";
  retrievedAt: string;
  sourceUrls: string[];
  /** Inclusive date coverage; estimates outside it are unavailable. */
  effectiveFrom: string;
  effectiveTo?: string;
  plans: RateCardPlan[];
};

const usageCalculations = "https://neon.com/docs/introduction/usage-calculations";
const plansDoc = "https://neon.com/docs/introduction/plans";
const networkTransfer = "https://neon.com/docs/introduction/network-transfer";
const agentPlan = "https://neon.com/docs/introduction/agent-plan";

const publicTransferAllowances = (
  rawQuantityPerBillingPeriod: string,
  sourceUrl: string,
): RateCardAllowance[] =>
  (["public_network_transfer_bytes", "functions_egress_bytes"] as const).map((metric) => ({
    metric,
    scope: "per_project",
    rawQuantityPerBillingPeriod,
    sharedPool: "public_network_transfer",
    sourceUrl,
  }));

const paidPublicTransferAllowances = publicTransferAllowances(
  "500000000000",
  `${plansDoc}#public-network-transfer`,
);

// The Agent plan includes 100 GB per project (not the 500 GB Scale allowance),
// then $0.10/GB. See https://neon.com/docs/introduction/agent-plan#pricing.
const agentPublicTransferAllowances = publicTransferAllowances(
  "100000000000",
  `${agentPlan}#pricing`,
);

const freeFunctionsAllowances: RateCardAllowance[] = [
  {
    metric: "functions_active_capacity_microseconds",
    scope: "per_project",
    rawQuantityPerBillingPeriod: "36000000000",
    sourceUrl: `${plansDoc}#functions`,
  },
  {
    metric: "functions_waiting_capacity_microseconds",
    scope: "per_project",
    rawQuantityPerBillingPeriod: "1440000000000",
    sourceUrl: `${plansDoc}#functions`,
  },
  {
    metric: "functions_invocations",
    scope: "per_project",
    rawQuantityPerBillingPeriod: "1000000",
    sourceUrl: `${plansDoc}#functions`,
  },
];

const scaleRates: RateCardPlan["ratesPerDerivedUnit"] = {
  compute_unit_seconds: "0.222",
  root_branch_bytes_month: "0.35",
  child_branch_bytes_month: "0.35",
  instant_restore_bytes_month: "0.20",
  snapshot_storage_bytes_month: "0.09",
  public_network_transfer_bytes: "0.10",
  private_network_transfer_bytes: "0.01",
  extra_branches_month: "1.50",
  functions_active_capacity_microseconds: "0.12",
  functions_waiting_capacity_microseconds: "0.03",
  functions_invocations: "0.60",
  functions_egress_bytes: "0.10",
};

/**
 * Neon's published self-service rates as verified from public documentation on
 * 2026-10-30. Documentation rates carry no official effective dates and can
 * change; a durable deployment should snapshot its own revision or supply a
 * contract override. Metrics without a published rate for a plan are
 * deliberately absent. Enterprise is the explicit exception: it uses labeled
 * Scale defaults because its contract rates are not public.
 */
const documentationRateCard: RateCard = {
  revision: "neon-docs-2026-10-30",
  currency: "USD",
  provenance: "documentation",
  retrievedAt: "2026-10-30",
  sourceUrls: [
    `${usageCalculations}#calculating-your-cost`,
    `${plansDoc}#price`,
    `${plansDoc}#functions`,
    `${networkTransfer}#what-is-network-transfer`,
    `${agentPlan}#pricing`,
  ],
  effectiveFrom: "2026-10-30",
  plans: [
    {
      planFamily: "free",
      billing: "not_billed",
      ratesPerDerivedUnit: {},
      // Free allowances are per project; exhausting one suspends that project's
      // compute rather than billing overage.
      allowances: [
        ...publicTransferAllowances("5000000000", `${networkTransfer}#what-is-network-transfer`),
        ...freeFunctionsAllowances,
      ],
    },
    {
      planFamily: "launch",
      billing: "metered",
      ratesPerDerivedUnit: {
        compute_unit_seconds: "0.106",
        root_branch_bytes_month: "0.35",
        child_branch_bytes_month: "0.35",
        instant_restore_bytes_month: "0.20",
        snapshot_storage_bytes_month: "0.09",
        public_network_transfer_bytes: "0.10",
        // private_network_transfer_bytes: not available on Launch.
        extra_branches_month: "1.50",
        functions_active_capacity_microseconds: "0.10",
        functions_waiting_capacity_microseconds: "0.025",
        functions_invocations: "0.60",
        functions_egress_bytes: "0.10",
      },
      allowances: paidPublicTransferAllowances,
      includedChildBranchesPerProject: 9,
    },
    {
      planFamily: "scale",
      billing: "metered",
      ratesPerDerivedUnit: scaleRates,
      allowances: paidPublicTransferAllowances,
      includedChildBranchesPerProject: 24,
    },
    {
      planFamily: "agent",
      billing: "metered",
      // Agent publishes these rates directly. Unpublished private-transfer and
      // extra-branch rates stay absent rather than inheriting Scale defaults.
      ratesPerDerivedUnit: {
        compute_unit_seconds: "0.106",
        root_branch_bytes_month: "0.35",
        child_branch_bytes_month: "0.35",
        instant_restore_bytes_month: "0.20",
        snapshot_storage_bytes_month: "0.09",
        public_network_transfer_bytes: "0.10",
        functions_egress_bytes: "0.10",
      },
      allowances: agentPublicTransferAllowances,
    },
    {
      planFamily: "enterprise",
      billing: "metered",
      ratesAssumed: true,
      // Enterprise contracts are custom; use Scale defaults only as a clearly
      // labeled estimate until the caller can supply contract rates.
      ratesPerDerivedUnit: scaleRates,
      allowances: paidPublicTransferAllowances,
      includedChildBranchesPerProject: 24,
    },
  ],
};

export const neonDocumentationRateCard: RateCard = deepFreeze(documentationRateCard);
