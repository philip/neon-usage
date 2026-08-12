import { describe, expect, it } from "vitest";
import type { SourcePeriod } from "../src/consumption-source.js";
import { assertValidPeriodFacts } from "../src/report-support.js";

const evidence = { payloadHash: `sha256:${"a".repeat(64)}`, sourcePath: "/project/compute" };

function periods(value: string): SourcePeriod[] {
  return [
    {
      id: "period-1",
      plan: "scale",
      start: "2026-08-01T00:00:00Z",
      buckets: [
        {
          start: "2026-08-01T00:00:00Z",
          end: "2026-08-02T00:00:00Z",
          metrics: [{ name: "compute_unit_seconds", value, evidence }],
        },
      ],
    },
  ];
}

describe("assertValidPeriodFacts value validation", () => {
  it("rejects a non-negative-integer metric value as a structured integrity failure", () => {
    // Downstream aggregation does BigInt(value); a decimal/empty/exponential
    // string would otherwise throw a raw SyntaxError, and a negative would
    // understate a total.
    for (const bad of ["1.5", "", "1e3", "abc", " 1", "0x1", "-5"]) {
      expect(() => assertValidPeriodFacts(periods(bad), "test")).toThrow(
        /non-negative-integer value/,
      );
    }
  });

  it("accepts well-formed non-negative integer strings", () => {
    for (const good of ["0", "100", "9999999999999999999999"]) {
      expect(() => assertValidPeriodFacts(periods(good), "test")).not.toThrow();
    }
  });
});

describe("assertValidPeriodFacts bucket validation", () => {
  const metric = (name = "compute_unit_seconds") => ({ name, value: "1", evidence });
  const period = (buckets: SourcePeriod["buckets"]): SourcePeriod[] => [
    { id: "p1", plan: "scale", start: "2026-08-01T00:00:00Z", buckets },
  ];

  it("rejects a non-UTC or unparseable bucket timestamp", () => {
    expect(() =>
      assertValidPeriodFacts(
        period([
          { start: "2026-08-01 00:00:00", end: "2026-08-02T00:00:00Z", metrics: [metric()] },
        ]),
        "test",
      ),
    ).toThrow(/non-UTC bucket start/);
  });

  it("rejects a bucket whose end is not after its start", () => {
    expect(() =>
      assertValidPeriodFacts(
        period([
          { start: "2026-08-02T00:00:00Z", end: "2026-08-02T00:00:00Z", metrics: [metric()] },
        ]),
        "test",
      ),
    ).toThrow(/is not after its start/);
  });

  it("rejects overlapping buckets within a period", () => {
    expect(() =>
      assertValidPeriodFacts(
        period([
          { start: "2026-08-01T00:00:00Z", end: "2026-08-03T00:00:00Z", metrics: [metric()] },
          { start: "2026-08-02T00:00:00Z", end: "2026-08-04T00:00:00Z", metrics: [metric()] },
        ]),
        "test",
      ),
    ).toThrow(/overlapping buckets/);
  });

  it("accepts adjacent, ordered, non-overlapping buckets", () => {
    expect(() =>
      assertValidPeriodFacts(
        period([
          { start: "2026-08-02T00:00:00Z", end: "2026-08-03T00:00:00Z", metrics: [metric()] },
          { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z", metrics: [metric()] },
        ]),
        "test",
      ),
    ).not.toThrow();
  });
});

describe("assertValidPeriodFacts window containment", () => {
  const metric = { name: "compute_unit_seconds", value: "1", evidence };
  const single = (start: string, end: string): SourcePeriod[] => [
    { id: "p1", plan: "scale", start, buckets: [{ start, end, metrics: [metric] }] },
  ];
  const range = { from: "2026-08-01T00:00:00Z", to: "2026-08-10T00:00:00Z" };

  it("rejects a bucket wholly outside the requested window", () => {
    expect(() =>
      assertValidPeriodFacts(single("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"), "test", range),
    ).toThrow(/outside the requested window/);
  });

  it("requires strict containment: a straddling edge bucket is rejected too", () => {
    // Callers pass the bucket-aligned effectiveRange, so a legitimate bucket
    // lies wholly inside it; a bucket even partially outside would smuggle
    // out-of-window usage into totals at full value.
    expect(() =>
      assertValidPeriodFacts(single("2026-07-31T00:00:00Z", "2026-08-01T12:00:00Z"), "test", range),
    ).toThrow(/outside the requested window/);
    expect(() =>
      assertValidPeriodFacts(single("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"), "test", range),
    ).not.toThrow();
    // Without a range the containment check is skipped entirely.
    expect(() =>
      assertValidPeriodFacts(single("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"), "test"),
    ).not.toThrow();
  });

  it("rejects malformed or reversed billing-period bounds", () => {
    const withPeriod = (start: string, end?: string): SourcePeriod[] => [
      {
        id: "p1",
        plan: "scale",
        start,
        ...(end ? { end } : {}),
        buckets: [
          { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z", metrics: [metric] },
        ],
      },
    ];
    expect(() => assertValidPeriodFacts(withPeriod("not-a-timestamp"), "test")).toThrow(
      /non-UTC period start/,
    );
    expect(() =>
      assertValidPeriodFacts(withPeriod("2026-08-05T00:00:00Z", "2026-08-01T00:00:00Z"), "test"),
    ).toThrow(/whose end is not after its start/);
  });
});

describe("assertValidPeriodFacts cross-period overlap", () => {
  const metric = { name: "compute_unit_seconds", value: "1", evidence };
  it("rejects the same bucket interval reported in two periods", () => {
    const periods: SourcePeriod[] = [
      {
        id: "p1",
        plan: "launch",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          { start: "2026-08-02T00:00:00Z", end: "2026-08-03T00:00:00Z", metrics: [metric] },
        ],
      },
      {
        id: "p2",
        plan: "scale",
        start: "2026-08-02T12:00:00Z",
        buckets: [
          { start: "2026-08-02T00:00:00Z", end: "2026-08-03T00:00:00Z", metrics: [metric] },
        ],
      },
    ];
    expect(() => assertValidPeriodFacts(periods, "test")).toThrow(/overlapping buckets across/);
  });

  it("allows a plan-change cell split into disjoint partial buckets", () => {
    const periods: SourcePeriod[] = [
      {
        id: "p1",
        plan: "launch",
        start: "2026-08-01T00:00:00Z",
        buckets: [
          { start: "2026-08-02T00:00:00Z", end: "2026-08-02T12:00:00Z", metrics: [metric] },
        ],
      },
      {
        id: "p2",
        plan: "scale",
        start: "2026-08-02T12:00:00Z",
        buckets: [
          { start: "2026-08-02T12:00:00Z", end: "2026-08-03T00:00:00Z", metrics: [metric] },
        ],
      },
    ];
    expect(() => assertValidPeriodFacts(periods, "test")).not.toThrow();
  });
});
