import { deepFreeze, type KnownMetricName } from "./metric-catalog.js";

export type AllowanceScope = "per_project" | "per_organization";

export type RateCardAllowance = {
  /** Raw v2 metric the allowance nets against. */
  metric: KnownMetricName;
  scope: AllowanceScope;
  /** Raw units (for transfer metrics: bytes) included per billing period. */
  rawQuantityPerBillingPeriod: string;
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
   * USD per derived billing unit (cu_hour, gb_month, gb, branch-month),
   * keyed by raw metric name. A metric with no entry has no published rate
   * and must produce an unavailable estimate, never a guessed one.
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

const paidPublicTransferAllowance: RateCardAllowance = {
  metric: "public_network_transfer_bytes",
  scope: "per_project",
  rawQuantityPerBillingPeriod: "500000000000",
  sourceUrl: `${usageCalculations}#public-transfer-allowance`,
};

/**
 * Neon's published self-service rates as read from public documentation on
 * 2026-08-08. Documentation
 * rates carry no official effective dates and can change; a durable deployment
 * should snapshot its own revision or supply a contract override. Metrics
 * without a published rate for a plan are deliberately absent.
 */
const documentationRateCard: RateCard = {
  revision: "neon-docs-2026-08-08",
  currency: "USD",
  provenance: "documentation",
  retrievedAt: "2026-08-08",
  sourceUrls: [
    `${usageCalculations}#calculating-your-cost`,
    `${plansDoc}#price`,
    `${networkTransfer}#what-is-network-transfer`,
    `${agentPlan}#pricing`,
  ],
  effectiveFrom: "2026-08-08",
  plans: [
    {
      planFamily: "free",
      billing: "not_billed",
      ratesPerDerivedUnit: {},
      // The Free allowance is organization-wide and exhausting it suspends
      // compute rather than billing overage.
      allowances: [
        {
          metric: "public_network_transfer_bytes",
          scope: "per_organization",
          rawQuantityPerBillingPeriod: "5000000000",
          sourceUrl: `${networkTransfer}#what-is-network-transfer`,
        },
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
      },
      allowances: [paidPublicTransferAllowance],
      includedChildBranchesPerProject: 9,
    },
    {
      planFamily: "scale",
      billing: "metered",
      ratesPerDerivedUnit: {
        compute_unit_seconds: "0.222",
        root_branch_bytes_month: "0.35",
        child_branch_bytes_month: "0.35",
        instant_restore_bytes_month: "0.20",
        snapshot_storage_bytes_month: "0.09",
        public_network_transfer_bytes: "0.10",
        private_network_transfer_bytes: "0.01",
        extra_branches_month: "1.50",
      },
      allowances: [paidPublicTransferAllowance],
      includedChildBranchesPerProject: 24,
    },
    {
      planFamily: "agent",
      billing: "metered",
      ratesAssumed: true,
      // Best-effort per Neon's usage docs: Agent matches Scale except compute,
      // which is billed at the Launch rate. Snapshot/transfer/extra-branch rates
      // are assumed equal to Scale; a customer's terms may differ. See
      // https://neon.com/docs/introduction/usage-calculations
      ratesPerDerivedUnit: {
        compute_unit_seconds: "0.106",
        root_branch_bytes_month: "0.35",
        child_branch_bytes_month: "0.35",
        instant_restore_bytes_month: "0.20",
        snapshot_storage_bytes_month: "0.09",
        public_network_transfer_bytes: "0.10",
        private_network_transfer_bytes: "0.01",
        extra_branches_month: "1.50",
      },
      allowances: [paidPublicTransferAllowance],
      includedChildBranchesPerProject: 24,
    },
    {
      planFamily: "enterprise",
      billing: "metered",
      ratesAssumed: true,
      // Best-effort: Enterprise defaults match Scale. Enterprise pricing is
      // commonly custom-negotiated, so a real invoice may differ — this produces
      // a labeled estimate rather than an "unknown plan" refusal.
      ratesPerDerivedUnit: {
        compute_unit_seconds: "0.222",
        root_branch_bytes_month: "0.35",
        child_branch_bytes_month: "0.35",
        instant_restore_bytes_month: "0.20",
        snapshot_storage_bytes_month: "0.09",
        public_network_transfer_bytes: "0.10",
        private_network_transfer_bytes: "0.01",
        extra_branches_month: "1.50",
      },
      allowances: [paidPublicTransferAllowance],
      includedChildBranchesPerProject: 24,
    },
  ],
};

export const neonDocumentationRateCard: RateCard = deepFreeze(documentationRateCard);
