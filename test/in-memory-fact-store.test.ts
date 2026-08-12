import { describe, expect, it } from "vitest";
import type { CanonicalConsumptionFact } from "../src/evidence-fact-store.js";
import { effectiveFactIdentity, observationRevisionIdentity } from "../src/fact-identity.js";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import type { NeonSourceEvidence } from "../src/neon-api-source.js";

describe("in-memory evidence and fact store", () => {
  it("writes evidence idempotently and rejects conflicting identities", async () => {
    const store = createInMemoryEvidenceFactStore();
    const record = evidenceRecord("a".repeat(64));
    await store.writeEvidence(record, new AbortController().signal);
    await store.writeEvidence(
      { ...structuredClone(record), requestedAt: "2026-08-09T00:00:00Z", attempt: 2 },
      new AbortController().signal,
    );

    await expect(
      store.writeEvidence(
        { ...record, response: { ...record.response, payloadHash: `sha256:${"b".repeat(64)}` } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("conflicts with an existing record");
    expect(await store.getEvidence(record.evidenceId)).toEqual(record);
  });

  it("retains corrected revisions append-only under one effective fact", async () => {
    const store = createInMemoryEvidenceFactStore();
    const first = fact("a".repeat(64), "1");
    const corrected = fact("b".repeat(64), "2");

    await appendPage(store, "run_one", 1, [first]);
    await appendPage(store, "run_two", 1, [corrected]);
    const replay = await appendPage(store, "run_three", 1, [first]);

    expect(replay).toEqual({ appendedFacts: 0, existingFacts: 1 });
    expect(
      (await store.getFactRevisions(first.effectiveFactId)).map(
        (item) => item.value.decimalInteger,
      ),
    ).toEqual(["1", "2"]);
  });

  it("selects the latest successful revision and replays it as collected at a cutoff", async () => {
    const store = createInMemoryEvidenceFactStore();
    const first = fact("a".repeat(64), "1");
    const corrected = fact("b".repeat(64), "2");
    const partialCorrection = fact("c".repeat(64), "3");
    const failedCorrection = fact("d".repeat(64), "4");

    await appendPage(store, "run_one", 1, [first], "2026-08-08T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_one", "complete", "2026-08-08T00:01:00Z"));
    await appendPage(store, "run_two", 1, [corrected], "2026-08-09T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_two", "complete", "2026-08-09T00:01:00Z"));
    await appendPage(store, "run_three", 1, [partialCorrection], "2026-08-10T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_three", "partial", "2026-08-10T00:01:00Z"));
    await appendPage(store, "run_four", 1, [failedCorrection], "2026-08-11T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_four", "failed", "2026-08-11T00:01:00Z"));

    expect(
      (await store.getEffectiveFactRevision(first.effectiveFactId))?.value.decimalInteger,
    ).toBe("2");
    expect(
      (
        await store.getEffectiveFactRevision(first.effectiveFactId, {
          asCollectedAt: "2026-08-08T12:00:00Z",
        })
      )?.value.decimalInteger,
    ).toBe("1");
    expect(
      await store.getEffectiveFactRevision(first.effectiveFactId, {
        asCollectedAt: "2026-08-07T23:59:59Z",
      }),
    ).toBeUndefined();
    expect(
      await store.getEffectiveFactRevision(first.effectiveFactId, {
        asCollectedAt: "2026-08-08T00:00:30Z",
      }),
    ).toBeUndefined();
    expect(
      (await store.getFactRevisions(first.effectiveFactId)).map(
        (item) => item.value.decimalInteger,
      ),
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("uses each successful run time when an earlier payload is recollected", async () => {
    const store = createInMemoryEvidenceFactStore();
    const first = fact("a".repeat(64), "1");
    const corrected = fact("b".repeat(64), "2");

    await appendPage(store, "run_one", 1, [first], "2026-08-08T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_one", "complete", "2026-08-08T00:01:00Z"));
    await appendPage(store, "run_two", 1, [corrected], "2026-08-09T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_two", "complete", "2026-08-09T00:01:00Z"));
    await appendPage(store, "run_three", 1, [first], "2026-08-10T00:00:00Z");
    await store.recordCollectionRun(collectionRun("run_three", "complete", "2026-08-10T00:01:00Z"));

    expect(
      (await store.getEffectiveFactRevision(first.effectiveFactId))?.value.decimalInteger,
    ).toBe("1");
    expect(
      (
        await store.getEffectiveFactRevision(first.effectiveFactId, {
          asCollectedAt: "2026-08-09T12:00:00Z",
        })
      )?.value.decimalInteger,
    ).toBe("2");
  });

  it("orders sub-millisecond run completion timestamps before deterministic tie-breakers", async () => {
    const store = createInMemoryEvidenceFactStore();
    const first = fact("a".repeat(64), "1");
    const corrected = fact("b".repeat(64), "2");

    await appendPage(store, "run_z", 1, [first], "2026-08-08T00:00:00.000000001Z");
    await store.recordCollectionRun(
      collectionRun("run_z", "complete", "2026-08-08T00:00:00.000000001Z"),
    );
    await appendPage(store, "run_a", 1, [corrected], "2026-08-08T00:00:00.000000002Z");
    await store.recordCollectionRun(
      collectionRun("run_a", "complete", "2026-08-08T00:00:00.000000002Z"),
    );

    expect(
      (await store.getEffectiveFactRevision(first.effectiveFactId))?.value.decimalInteger,
    ).toBe("2");
  });

  it.each(["", "2026-08-08", "2026-02-30T00:00:00Z"])(
    "rejects a non-RFC-3339-UTC replay cutoff: %s",
    async (asCollectedAt) => {
      const store = createInMemoryEvidenceFactStore();
      await expect(
        store.getEffectiveFactRevision("fact:unknown", { asCollectedAt }),
      ).rejects.toThrow("asCollectedAt must be an RFC 3339 UTC timestamp");
    },
  );

  it("requires coherent run finalization and rejects pages after finalization", async () => {
    const store = createInMemoryEvidenceFactStore();
    const value = fact("a".repeat(64), "1");

    await expect(
      store.recordCollectionRun(collectionRun("run_one", "complete", "2026-08-08T00:01:00Z")),
    ).rejects.toThrow("does not match its committed pages");
    await appendPage(store, "run_one", 1, [value]);
    await store.recordCollectionRun(collectionRun("run_one", "complete", "2026-08-08T00:01:00Z"));
    await expect(appendPage(store, "run_one", 1, [value])).resolves.toEqual({
      appendedFacts: 0,
      existingFacts: 1,
    });
    await expect(appendPage(store, "run_one", 2, [value])).rejects.toThrow("is already final");
  });

  it("does not finalize a run before its evidence or under another source contract", async () => {
    const store = createInMemoryEvidenceFactStore();
    const value = fact("a".repeat(64), "1");
    await appendPage(store, "run_one", 1, [value], "2026-08-08T00:01:00Z");

    await expect(
      store.recordCollectionRun(collectionRun("run_one", "complete", "2026-08-08T00:00:59Z")),
    ).rejects.toThrow("does not match its committed pages");
    await expect(
      store.recordCollectionRun({
        ...collectionRun("run_one", "complete", "2026-08-08T00:01:01Z"),
        sourceContract: "consumption-history-v2-branches",
      }),
    ).rejects.toThrow("does not match its committed pages");
  });

  it("commits pages atomically and rejects conflicting page reuse", async () => {
    const store = createInMemoryEvidenceFactStore();
    const first = fact("a".repeat(64), "1");
    const write = await pageWrite(store, "run_one", 1, [first]);
    await expect(store.appendCollectionPage(write)).resolves.toEqual({
      appendedFacts: 1,
      existingFacts: 0,
    });
    await expect(store.appendCollectionPage(structuredClone(write))).resolves.toEqual({
      appendedFacts: 0,
      existingFacts: 1,
    });
    await expect(appendPage(store, "run_one", 1, [fact("b".repeat(64), "2")])).rejects.toThrow(
      "Collection page run_one:1 conflicts",
    );
    expect(await store.getRunPage("run_one", 1)).toEqual(write);
  });

  it("does not mutate facts when a page cannot be archived", async () => {
    const store = createInMemoryEvidenceFactStore();
    const value = fact("a".repeat(64), "1");
    const write = await pageWrite(store, "run_one", 1, [value]);
    Object.assign(write, { uncloneable: () => undefined });

    await expect(store.appendCollectionPage(write)).rejects.toThrow();
    expect(await store.getFactRevision(value.observationId)).toBeUndefined();
    expect(await store.getRunPage("run_one", 1)).toBeUndefined();
  });

  it("rejects unverifiable and caller-mismatched facts without mutation", async () => {
    const store = createInMemoryEvidenceFactStore();
    const valid = fact("a".repeat(64), "1");
    const invalid = { ...fact("b".repeat(64), "2"), observationId: "observation:invalid" };

    await expect(appendPage(store, "run_one", 1, [valid, invalid])).rejects.toThrow(
      "observation identity is invalid",
    );
    expect(await store.getFactRevision(valid.observationId)).toBeUndefined();
    expect(await store.getRunPage("run_one", 1)).toBeUndefined();
  });

  it("rejects conflicting duplicate revisions within one page", async () => {
    const store = createInMemoryEvidenceFactStore();
    const first = fact("a".repeat(64), "1");
    const conflicting = {
      ...structuredClone(first),
      value: { ...first.value, decimalInteger: "2" },
    };

    await expect(appendPage(store, "run_one", 1, [first, conflicting])).rejects.toThrow(
      "conflicts within the collection page",
    );
    expect(await store.getFactRevision(first.observationId)).toBeUndefined();
  });

  it("returns defensive copies", async () => {
    const store = createInMemoryEvidenceFactStore();
    const value = fact("a".repeat(64), "1");
    await appendPage(store, "run_one", 1, [value]);
    const returned = await store.getFactRevision(value.observationId);
    if (!returned) throw new Error("stored fact missing");
    returned.value.decimalInteger = "999";
    expect((await store.getFactRevision(value.observationId))?.value.decimalInteger).toBe("1");
  });
});

function fact(payloadDigest: string, value: string): CanonicalConsumptionFact {
  const identity = {
    sourceContract: "consumption-history-v2-projects",
    scope: { kind: "project" as const, organizationId: "org-1", projectId: "project-1" },
    periodId: "period-1",
    bucket: { start: "2026-08-07T00:00:00Z", end: "2026-08-08T00:00:00Z" },
    metricName: "compute_unit_seconds",
  };
  const payloadHash = `sha256:${payloadDigest}`;
  return {
    observationId: observationRevisionIdentity({ ...identity, payloadHash }),
    effectiveFactId: effectiveFactIdentity(identity),
    sourceContract: identity.sourceContract,
    scope: identity.scope,
    billingPeriod: {
      sourcePeriodId: identity.periodId,
      plan: "launch",
      start: "2026-08-01T00:00:00Z",
    },
    bucket: identity.bucket,
    metric: { sourceName: identity.metricName },
    value: { decimalInteger: value },
    presence: "reported",
    provenance: {
      evidenceId: `evidence:${payloadDigest}`,
      payloadHash,
      sourcePath: "/projects/0/periods/0/consumption/0/metrics/0",
    },
  };
}

function evidenceRecord(
  payloadDigest: string,
  completedAt = "2026-08-08T00:00:01Z",
): NeonSourceEvidence {
  return {
    evidenceId: `evidence:${payloadDigest}`,
    sourceAccount: "account-1",
    sourceContract: "consumption-history-v2-projects",
    requestedAt: "2026-08-08T00:00:00Z",
    completedAt,
    request: {
      method: "GET",
      path: "/consumption_history/v2/projects",
      query: "",
      cursorIn: null,
      fingerprint: "sha256:fingerprint",
    },
    response: { status: 200, cursorOut: null, payloadHash: `sha256:${payloadDigest}` },
    attempt: 1,
  };
}

async function pageWrite(
  store: ReturnType<typeof createInMemoryEvidenceFactStore>,
  runId: `run_${string}`,
  pageNumber: number,
  facts: CanonicalConsumptionFact[],
  completedAt?: string,
) {
  await store.beginCollectionRun({
    runId,
    intent: {
      sourceAccount: "account-1",
      sourceContract: "consumption-history-v2-projects",
      request: { fixture: true },
    },
  });
  const references = [];
  for (const item of facts) {
    const digest = item.provenance.payloadHash.slice(7);
    const record = evidenceRecord(digest, completedAt);
    await store.writeEvidence(record, new AbortController().signal);
    references.push({ evidenceId: record.evidenceId, payloadHash: record.response.payloadHash });
  }
  return {
    runId,
    pageNumber,
    cursorIn: pageNumber === 1 ? null : `cursor-${pageNumber - 1}`,
    cursorOut: null,
    nextCursor: null,
    terminalState: "complete" as const,
    page: { facts: facts.map((fact) => fact.observationId) },
    evidence: references,
    facts,
  };
}

async function appendPage(
  store: ReturnType<typeof createInMemoryEvidenceFactStore>,
  runId: `run_${string}`,
  pageNumber: number,
  facts: CanonicalConsumptionFact[],
  completedAt?: string,
) {
  return store.appendCollectionPage(await pageWrite(store, runId, pageNumber, facts, completedAt));
}

function collectionRun(
  runId: `run_${string}`,
  status: "complete" | "partial" | "failed",
  completedAt: string,
) {
  return {
    runId,
    sourceContract: "consumption-history-v2-projects",
    status,
    completedAt,
    pageCount: 1,
    qualityFlags: [],
  };
}
