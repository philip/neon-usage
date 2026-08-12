import { Decimal } from "decimal.js";
import type { EffectiveRange, ProjectReportQuery } from "./consumption-query.js";
import type { EvidenceRef } from "./consumption-source.js";
import type { ProjectConsumptionReport } from "./history-report.js";
import { type KnownMetricName, metricCatalog } from "./metric-catalog.js";
import type { RateCard, RateCardPlan } from "./rate-card.js";

const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type MoneyAmount = {
  currency: "USD";
  exact: { numerator: string; denominator: string };
  decimalApproximation: string;
};

export type PricingApproximation =
  /** Branch and allowance rules are defined hourly; coarser buckets differ. */
  | "GRANULARITY_APPROXIMATION"
  /** A full billing-period allowance was applied to a partial-period window. */
  | "ALLOWANCE_WINDOW_APPROXIMATION"
  /** The window predates or postdates the rate card's effective dates; the
   * card's rates were applied anyway, so historical prices may have differed. */
  | "RATE_CARD_DATE_EXTRAPOLATION"
  /** The plan's rates/allowances are documented defaults assumed from another
   * plan (Agent, Enterprise); negotiated or custom terms may differ. */
  | "PLAN_RATES_ASSUMED";

export type PricingLineStatus = "estimated" | "not_billed" | "unavailable";

export type PricingEstimateLine = {
  projectId: string;
  billingPeriod: { sourcePeriodId: string; plan: string; start: string; end?: string };
  allowanceWindow: { start: string; end: string };
  metric: string;
  status: PricingLineStatus;
  raw: { value: string; unit: string };
  /** Raw units subtracted by an allowance before conversion, when one applied. */
  allowanceApplied?: {
    rawQuantity: string;
    exact: { numerator: string; denominator: string };
    scope: "per_project" | "per_organization";
  };
  billable?: {
    value: string;
    exact: { numerator: string; denominator: string };
    unit: string;
  };
  ratePerUnit?: string;
  amount?: MoneyAmount;
  approximations: PricingApproximation[];
  unavailableReason?: "UNKNOWN_PLAN" | "RATE_NOT_PUBLISHED";
};

export type PricingEstimate = {
  schemaVersion: 1;
  kind: "pricing_estimate";
  /** Always an estimate; never an invoice or amount due. */
  disposition: "estimate";
  generatedAt: string;
  asOf: string;
  rateCard: {
    revision: string;
    currency: "USD";
    provenance: RateCard["provenance"];
    retrievedAt: string;
    sourceUrls: string[];
  };
  query: ProjectReportQuery;
  effectiveRange: EffectiveRange;
  /** Evidence identities of the source pages the estimated usage came from. */
  evidence?: EvidenceRef[];
  /** Provider request IDs of the collected pages, for support escalation. */
  requestIds?: string[];
  status:
    | "estimated"
    | "unavailable_partial_coverage"
    | "unavailable_rate_card_dates"
    | "unavailable_unpriced_lines";
  /** Amounts a real invoice includes that this estimate deliberately excludes. */
  exclusions: readonly string[];
  lines: PricingEstimateLine[];
  /** Null when any line the totals depend on is unavailable. */
  totalsByMetric: Array<{ metric: string; amount: MoneyAmount }> | null;
  totalAmount: MoneyAmount | null;
};

export type PricingEstimateOptions = {
  now?: () => Date;
  /**
   * Estimate windows outside the rate card's effective dates by applying
   * the card's rates anyway. Every line then carries
   * RATE_CARD_DATE_EXTRAPOLATION — "at these rates, this usage would cost
   * X" — instead of the default refusal (unavailable_rate_card_dates).
   * The default stays a refusal: the card does not claim to know
   * historical prices.
   */
  extrapolateRateCardDates?: boolean;
};

const EXCLUSIONS = Object.freeze([
  "credits",
  "taxes",
  "minimum_invoice_collection",
  "custom_contract_terms",
  "billing_snapshot_timing",
  "rounding_differences",
]);

type Fraction = { numerator: bigint; denominator: bigint };

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function reduce(fraction: Fraction): Fraction {
  if (fraction.numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = greatestCommonDivisor(fraction.numerator, fraction.denominator);
  return { numerator: fraction.numerator / divisor, denominator: fraction.denominator / divisor };
}

function addFractions(left: Fraction, right: Fraction): Fraction {
  return reduce({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function subtractFractions(left: Fraction, right: Fraction): Fraction {
  return reduce({
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function compareFractions(left: Fraction, right: Fraction): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function decimalFraction(fraction: Fraction): string {
  const reduced = reduce(fraction);
  return new MoneyDecimal(reduced.numerator.toString())
    .div(reduced.denominator.toString())
    .toString();
}

function billingMonth(timestamp: string): { start: string; end: string } {
  const date = new Date(timestamp);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Parses a non-negative decimal string like "0.106" into an exact fraction. */
function decimalRateFraction(rate: string): Fraction {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!match?.[1]) throw new TypeError(`rate must be a non-negative decimal: ${rate}`);
  const fractionDigits = match[2] ?? "";
  return reduce({
    numerator: BigInt(match[1] + fractionDigits),
    denominator: 10n ** BigInt(fractionDigits.length),
  });
}

function moneyAmount(fraction: Fraction): MoneyAmount {
  const reduced = reduce(fraction);
  return {
    currency: "USD",
    exact: {
      numerator: reduced.numerator.toString(),
      denominator: reduced.denominator.toString(),
    },
    decimalApproximation: new MoneyDecimal(reduced.numerator.toString())
      .div(reduced.denominator.toString())
      .toString(),
  };
}

function isKnownMetric(name: string): name is KnownMetricName {
  return Object.hasOwn(metricCatalog, name);
}

function planEntry(rateCard: RateCard, periodPlan: string): RateCardPlan | undefined {
  const normalized = periodPlan.toLowerCase();
  return rateCard.plans.find((plan) => plan.planFamily === normalized);
}

/**
 * Projects a complete project-consumption report into a labeled monetary
 * estimate using an immutable rate card. The raw report stays intact beside
 * the estimate: every line carries its raw quantity, the allowance netted
 * against it, the billable quantity, the rate, and the exact amount as a
 * fraction. Unknown plans and unpublished rates become unavailable lines,
 * never guesses; the Free plan is not billed and estimates to zero.
 */
export function estimateProjectCosts(
  report: ProjectConsumptionReport,
  rateCard: RateCard,
  options: PricingEstimateOptions = {},
): PricingEstimate {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const base = {
    schemaVersion: 1 as const,
    kind: "pricing_estimate" as const,
    disposition: "estimate" as const,
    generatedAt,
    asOf: report.asOf,
    rateCard: {
      revision: rateCard.revision,
      currency: rateCard.currency,
      provenance: rateCard.provenance,
      retrievedAt: rateCard.retrievedAt,
      sourceUrls: rateCard.sourceUrls,
    },
    query: report.query,
    effectiveRange: report.effectiveRange,
    ...(report.evidence ? { evidence: report.evidence } : {}),
    ...(report.coverage.requestIds ? { requestIds: report.coverage.requestIds } : {}),
    exclusions: EXCLUSIONS,
  };
  if (report.coverage.status !== "complete") {
    return {
      ...base,
      status: "unavailable_partial_coverage",
      lines: [],
      totalsByMetric: null,
      totalAmount: null,
    };
  }
  const rangeFrom = new Date(report.effectiveRange.from).getTime();
  const rangeTo = new Date(report.effectiveRange.to).getTime();
  const cardFrom = new Date(rateCard.effectiveFrom).getTime();
  const cardTo = rateCard.effectiveTo
    ? new Date(rateCard.effectiveTo).getTime()
    : Number.POSITIVE_INFINITY;
  // Any part of the window outside the card's effective dates needs
  // extrapolation — including a window that straddles the card's start (e.g.
  // "this month to date" when the card took effect mid-month), whose earlier
  // days would otherwise be priced at the card's rates with no honesty label.
  const outsideCardDates = rangeFrom < cardFrom || rangeTo > cardTo;
  if (outsideCardDates && !options.extrapolateRateCardDates) {
    return {
      ...base,
      status: "unavailable_rate_card_dates",
      lines: [],
      totalsByMetric: null,
      totalAmount: null,
    };
  }

  // Raw usage summed per (project, source period, canonical billing month,
  // metric). Source periods can split one allowance window (plan changes or
  // corrections), so they are provenance, not allowance-reset identities.
  type PeriodUsage = {
    projectId: string;
    period: { sourcePeriodId: string; plan: string; start: string; end?: string };
    allowanceWindow: { start: string; end: string };
    totals: Map<string, bigint>;
    /** Extra-branch usage after netting the included-branch allowance PER
     * BUCKET (Neon's documented rule), in MILLI-branch-hours so a partial
     * bucket (a plan-change cell split) nets its exact fractional allowance —
     * flooring to whole hours would bill a half-hour bucket's usage in full.
     * Undefined when the plan publishes no allowance. */
    extraBranchesBillable?: Fraction;
  };
  const usages: PeriodUsage[] = [];
  for (const project of report.projects) {
    for (const period of project.periods) {
      const periodPlan = planEntry(rateCard, period.plan);
      const includedBranches =
        periodPlan?.includedChildBranchesPerProject !== undefined
          ? BigInt(periodPlan.includedChildBranchesPerProject)
          : undefined;
      const byMonth = new Map<
        string,
        {
          allowanceWindow: { start: string; end: string };
          totals: Map<string, bigint>;
          extraBranchesBillable: Fraction;
        }
      >();
      for (const bucket of period.buckets) {
        const allowanceWindow = billingMonth(bucket.start);
        const monthly = byMonth.get(allowanceWindow.start) ?? {
          allowanceWindow,
          totals: new Map<string, bigint>(),
          extraBranchesBillable: { numerator: 0n, denominator: 1n },
        };
        byMonth.set(allowanceWindow.start, monthly);
        for (const metric of bucket.metrics) {
          if (metric.value === null || !report.query.metrics.includes(metric.name)) continue;
          const value = BigInt(metric.value);
          monthly.totals.set(metric.name, (monthly.totals.get(metric.name) ?? 0n) + value);
          if (metric.name === "extra_branches_month" && includedBranches !== undefined) {
            const durationMs = BigInt(
              new Date(bucket.end).getTime() - new Date(bucket.start).getTime(),
            );
            const allowance = reduce({
              numerator: includedBranches * durationMs,
              denominator: 3_600_000n,
            });
            const reported = { numerator: value, denominator: 1n };
            monthly.extraBranchesBillable = addFractions(
              monthly.extraBranchesBillable,
              compareFractions(reported, allowance) > 0
                ? subtractFractions(reported, allowance)
                : { numerator: 0n, denominator: 1n },
            );
          }
        }
      }
      for (const monthly of byMonth.values()) {
        usages.push({
          projectId: project.projectId,
          period: {
            sourcePeriodId: period.id,
            plan: period.plan,
            start: period.start,
            ...(period.end ? { end: period.end } : {}),
          },
          allowanceWindow: monthly.allowanceWindow,
          totals: monthly.totals,
          ...(includedBranches !== undefined
            ? { extraBranchesBillable: monthly.extraBranchesBillable }
            : {}),
        });
      }
    }
  }

  const allowanceRemaining = new Map<string, bigint>();

  const lines: PricingEstimateLine[] = [];
  for (const usage of usages) {
    const plan = planEntry(rateCard, usage.period.plan);
    for (const metric of report.query.metrics) {
      const raw = usage.totals.get(metric) ?? 0n;
      const rawUnit = isKnownMetric(metric) ? metricCatalog[metric].rawUnit : "unknown";
      const line: PricingEstimateLine = {
        projectId: usage.projectId,
        billingPeriod: usage.period,
        allowanceWindow: usage.allowanceWindow,
        metric,
        status: "estimated",
        raw: { value: raw.toString(), unit: rawUnit },
        approximations: outsideCardDates ? ["RATE_CARD_DATE_EXTRAPOLATION"] : [],
      };
      if (!plan) {
        lines.push({ ...line, status: "unavailable", unavailableReason: "UNKNOWN_PLAN" });
        continue;
      }
      if (plan.ratesAssumed) line.approximations.push("PLAN_RATES_ASSUMED");
      if (!isKnownMetric(metric)) {
        if (plan.billing === "not_billed") {
          lines.push({
            ...line,
            status: "not_billed",
            amount: moneyAmount({ numerator: 0n, denominator: 1n }),
          });
        } else {
          lines.push({ ...line, status: "unavailable", unavailableReason: "RATE_NOT_PUBLISHED" });
        }
        continue;
      }

      // Net allowances in raw units before conversion.
      let billableRaw: Fraction = { numerator: raw, denominator: 1n };
      const allowance = plan.allowances.find((candidate) => candidate.metric === metric);
      if (allowance) {
        const quantity = BigInt(allowance.rawQuantityPerBillingPeriod);
        const owner =
          allowance.scope === "per_project" ? usage.projectId : report.query.organizationId;
        const key = `${usage.allowanceWindow.start}:${metric}:${allowance.scope}:${owner}:${quantity}:${allowance.sourceUrl}`;
        const remaining = allowanceRemaining.get(key) ?? quantity;
        const applied = raw < remaining ? raw : remaining;
        allowanceRemaining.set(key, remaining - applied);
        billableRaw = { numerator: raw - applied, denominator: 1n };
        line.allowanceApplied = {
          rawQuantity: applied.toString(),
          exact: { numerator: applied.toString(), denominator: "1" },
          scope: allowance.scope,
        };
        // The documented allowance is per billing period; this window may not
        // span the whole period, so netting the full allowance approximates.
        line.approximations.push("ALLOWANCE_WINDOW_APPROXIMATION");
      }
      if (metric === "extra_branches_month" && usage.extraBranchesBillable !== undefined) {
        // Per Neon's documented rule the included-branch allowance applies to
        // each bucket independently (computed during aggregation above), so a
        // quiet bucket's unused allowance never offsets a busier bucket.
        billableRaw = usage.extraBranchesBillable;
        const reported = { numerator: raw, denominator: 1n };
        if (compareFractions(billableRaw, reported) > 0) billableRaw = reported;
        const applied = subtractFractions(reported, billableRaw);
        line.allowanceApplied = {
          rawQuantity: decimalFraction(applied),
          exact: {
            numerator: applied.numerator.toString(),
            denominator: applied.denominator.toString(),
          },
          scope: "per_project",
        };
        // The underlying metering is hourly; any coarser bucket lets the
        // allowance smooth intra-bucket spikes (a day's 216 allowance hours can
        // absorb 18 branch-hours concentrated in one hour that hourly billing
        // would charge), so only hourly output is exact.
        if (report.effectiveRange.granularity !== "hourly") {
          line.approximations.push("GRANULARITY_APPROXIMATION");
        }
      }

      if (plan.billing === "not_billed") {
        // Free usage is never billed, but the netted allowance is still
        // informative: proximity to a Free allowance predicts suspension.
        lines.push({
          ...line,
          status: "not_billed",
          amount: moneyAmount({ numerator: 0n, denominator: 1n }),
        });
        continue;
      }
      const rate = plan.ratesPerDerivedUnit[metric];
      if (rate === undefined) {
        if (billableRaw.numerator === 0n) {
          // Zero usage costs zero under any rate; no guess involved.
          lines.push({
            ...line,
            status: "estimated",
            amount: moneyAmount({ numerator: 0n, denominator: 1n }),
          });
        } else {
          lines.push({ ...line, status: "unavailable", unavailableReason: "RATE_NOT_PUBLISHED" });
        }
        continue;
      }
      const definition = metricCatalog[metric];
      const billable = reduce({
        numerator: billableRaw.numerator,
        denominator: billableRaw.denominator * definition.denominator,
      });
      const rateFraction = decimalRateFraction(rate);
      const amount = reduce({
        numerator: billable.numerator * rateFraction.numerator,
        denominator: billable.denominator * rateFraction.denominator,
      });
      lines.push({
        ...line,
        billable: {
          value: decimalFraction(billable),
          exact: {
            numerator: billable.numerator.toString(),
            denominator: billable.denominator.toString(),
          },
          unit: definition.derivedUnit,
        },
        ratePerUnit: rate,
        amount: moneyAmount(amount),
      });
    }
  }

  const anyUnavailable = lines.some((line) => line.status === "unavailable");
  let totalsByMetric: PricingEstimate["totalsByMetric"] = null;
  let totalAmount: MoneyAmount | null = null;
  if (!anyUnavailable) {
    const byMetric = new Map<string, Fraction>();
    let overall: Fraction = { numerator: 0n, denominator: 1n };
    for (const line of lines) {
      if (!line.amount) continue;
      const fraction: Fraction = {
        numerator: BigInt(line.amount.exact.numerator),
        denominator: BigInt(line.amount.exact.denominator),
      };
      byMetric.set(
        line.metric,
        addFractions(byMetric.get(line.metric) ?? { numerator: 0n, denominator: 1n }, fraction),
      );
      overall = addFractions(overall, fraction);
    }
    totalsByMetric = report.query.metrics.map((metric) => ({
      metric,
      amount: moneyAmount(byMetric.get(metric) ?? { numerator: 0n, denominator: 1n }),
    }));
    totalAmount = moneyAmount(overall);
  }

  // An unavailable line (unknown plan or unpublished rate) means no honest
  // total; report that as its own status rather than "estimated" with null
  // totals, so the CLI exits non-zero and the dashboard shows "unavailable"
  // instead of rendering the unpriced lines as $0.
  return {
    ...base,
    status: anyUnavailable ? "unavailable_unpriced_lines" : "estimated",
    lines,
    totalsByMetric,
    totalAmount,
  };
}
