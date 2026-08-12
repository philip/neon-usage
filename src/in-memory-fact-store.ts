import { isDeepStrictEqual } from "node:util";
import { compareCanonicalText } from "./canonical-order.js";
import { ConsumptionSourceIntegrityError } from "./errors.js";
import type {
  CanonicalConsumptionFact,
  CollectionPageWrite,
  CollectionRunCompletion,
  CollectionRunRecord,
  EvidenceFactStore,
  ResourceNameObservation,
} from "./evidence-fact-store.js";
import {
  evidenceWriteAction,
  finalRunRecord,
  parseUtcTimestamp,
  validateFact,
  validateResourceName,
  validateRunId,
  withEvidenceBody,
} from "./fact-store-support.js";
import type { CollectionRunId } from "./history-collection.js";
import type { NeonSourceEvidence } from "./neon-api-source.js";

export interface InMemoryEvidenceFactStore extends EvidenceFactStore {}

export function createInMemoryEvidenceFactStore(): InMemoryEvidenceFactStore {
  const evidence = new Map<string, NeonSourceEvidence>();
  const facts = new Map<string, CanonicalConsumptionFact>();
  const revisions = new Map<string, string[]>();
  const occurrences = new Map<
    string,
    Array<{
      observationId: string;
      runId: CollectionRunId;
      pageNumber: number;
    }>
  >();
  const pages = new Map<string, CollectionPageWrite>();
  const runs = new Map<CollectionRunId, CollectionRunRecord>();
  const resourceNames: ResourceNameObservation[] = [];

  return {
    async writeEvidence(record, signal) {
      if (signal.aborted) throw signal.reason;
      const existing = evidence.get(record.evidenceId);
      const action = evidenceWriteAction(existing, record);
      if (action === "insert") {
        evidence.set(record.evidenceId, structuredClone(record));
      } else if (action === "upgrade_body" && existing && record.response.bodyBase64) {
        evidence.set(record.evidenceId, withEvidenceBody(existing, record.response.bodyBase64));
      }
    },

    async beginCollectionRun(input) {
      validateRunId(input.runId);
      if (!input.intent.sourceAccount || !input.intent.sourceContract) {
        throw new TypeError("collection intent requires source account and source contract");
      }
      const existing = runs.get(input.runId);
      if (existing && !isDeepStrictEqual(existing.intent, input.intent)) {
        throw new ConsumptionSourceIntegrityError(
          `Collection run ${input.runId} intent does not match`,
        );
      }
      if (!existing) {
        runs.set(input.runId, {
          runId: input.runId,
          intent: structuredClone(input.intent),
          status: "running",
          pageCount: 0,
          qualityFlags: [],
        });
      }
    },

    async appendCollectionPage(write) {
      validatePage(write, evidence);
      const key = `${write.runId}:${write.pageNumber}`;
      const storedWrite = pages.get(key);
      if (storedWrite) {
        if (!isDeepStrictEqual(storedWrite, write)) {
          throw new ConsumptionSourceIntegrityError(`Collection page ${key} conflicts`);
        }
        return { appendedFacts: 0, existingFacts: write.facts.length };
      }
      const run = runs.get(write.runId);
      if (!run) {
        throw new ConsumptionSourceIntegrityError(`Collection run ${write.runId} was not begun`);
      }
      if (run.status !== "running") {
        throw new ConsumptionSourceIntegrityError(`Collection run ${write.runId} is already final`);
      }
      if (write.pageNumber !== run.pageCount + 1) {
        throw new ConsumptionSourceIntegrityError(
          `Collection page ${key} is not the next page for its run`,
        );
      }

      const storedPage = structuredClone(write);
      let appendedFacts = 0;
      let existingFacts = 0;
      const batchFacts = new Map<string, CanonicalConsumptionFact>();
      for (const fact of write.facts) {
        const inBatch = batchFacts.get(fact.observationId);
        if (inBatch && !isDeepStrictEqual(inBatch, fact)) {
          throw new ConsumptionSourceIntegrityError(
            `Observation ${fact.observationId} conflicts within the collection page`,
          );
        }
        if (inBatch) continue;
        batchFacts.set(fact.observationId, fact);
        const existing = facts.get(fact.observationId);
        if (existing && !isDeepStrictEqual(existing, fact)) {
          throw new ConsumptionSourceIntegrityError(
            `Observation ${fact.observationId} conflicts with an existing revision`,
          );
        }
        if (existing) existingFacts += 1;
        else appendedFacts += 1;
      }

      for (const fact of batchFacts.values()) {
        if (!facts.has(fact.observationId)) {
          facts.set(fact.observationId, structuredClone(fact));
          const effectiveRevisions = revisions.get(fact.effectiveFactId) ?? [];
          effectiveRevisions.push(fact.observationId);
          revisions.set(fact.effectiveFactId, effectiveRevisions);
        }
        const effectiveOccurrences = occurrences.get(fact.effectiveFactId) ?? [];
        effectiveOccurrences.push({
          observationId: fact.observationId,
          runId: write.runId,
          pageNumber: write.pageNumber,
        });
        occurrences.set(fact.effectiveFactId, effectiveOccurrences);
      }
      pages.set(key, storedPage);
      runs.set(write.runId, { ...run, pageCount: write.pageNumber });
      return { appendedFacts, existingFacts };
    },

    async recordCollectionRun(record: CollectionRunCompletion) {
      const completedAt = parseUtcTimestamp(record.completedAt, "collection completion timestamp");
      const existing = runs.get(record.runId);
      if (!existing) {
        throw new ConsumptionSourceIntegrityError(
          `Collection run ${record.runId} does not match its committed pages`,
        );
      }
      const finalRecord = finalRunRecord(existing, structuredClone(record));
      if (existing.status !== "running") {
        if (!isDeepStrictEqual(existing, finalRecord)) {
          throw new ConsumptionSourceIntegrityError(`Collection run ${record.runId} conflicts`);
        }
        return;
      }
      const runPages = [...pages.values()].filter((page) => page.runId === record.runId);
      const runEvidence = runPages.flatMap((page) =>
        page.evidence.flatMap((reference) => {
          const item = evidence.get(reference.evidenceId);
          return item ? [item] : [];
        }),
      );
      if (
        record.sourceContract !== existing.intent.sourceContract ||
        (record.status !== "failed" &&
          (runPages.length !== record.pageCount ||
            runPages.some((page) => page.pageNumber < 1 || page.pageNumber > record.pageCount))) ||
        runPages.some((page) =>
          page.facts.some((fact) => fact.sourceContract !== record.sourceContract),
        ) ||
        runEvidence.some(
          (item) =>
            item.sourceContract !== record.sourceContract ||
            parseUtcTimestamp(item.completedAt, "evidence completion timestamp") > completedAt,
        )
      ) {
        throw new ConsumptionSourceIntegrityError(
          `Collection run ${record.runId} does not match its committed pages`,
        );
      }
      runs.set(record.runId, finalRecord);
    },

    async listCollectionRuns(filter) {
      return [...runs.values()]
        .filter(
          (run) =>
            run.intent.sourceAccount === filter.sourceAccount &&
            run.intent.sourceContract === filter.sourceContract,
        )
        .map((run) => structuredClone(run));
    },

    async getEvidence(evidenceId) {
      const record = evidence.get(evidenceId);
      return record ? structuredClone(record) : undefined;
    },
    async getFactRevision(observationId) {
      const fact = facts.get(observationId);
      return fact ? structuredClone(fact) : undefined;
    },
    async getFactRevisions(effectiveFactId) {
      return (revisions.get(effectiveFactId) ?? []).flatMap((id) => {
        const fact = facts.get(id);
        return fact ? [structuredClone(fact)] : [];
      });
    },
    async getEffectiveFactRevision(effectiveFactId, query = {}) {
      const cutoff =
        query.asCollectedAt === undefined
          ? undefined
          : parseUtcTimestamp(query.asCollectedAt, "asCollectedAt");
      const selected = (occurrences.get(effectiveFactId) ?? [])
        .filter((occurrence) => {
          const run = runs.get(occurrence.runId);
          return (
            run?.status === "complete" &&
            (cutoff === undefined ||
              parseUtcTimestamp(run.completedAt as string, "collection completion timestamp") <=
                cutoff)
          );
        })
        .sort((left, right) => {
          const leftRun = runs.get(left.runId);
          const rightRun = runs.get(right.runId);
          if (!leftRun || !rightRun) return 0;
          const leftCompletedAt = parseUtcTimestamp(
            leftRun.completedAt as string,
            "collection completion timestamp",
          );
          const rightCompletedAt = parseUtcTimestamp(
            rightRun.completedAt as string,
            "collection completion timestamp",
          );
          return (
            (leftCompletedAt > rightCompletedAt
              ? -1
              : leftCompletedAt < rightCompletedAt
                ? 1
                : 0) ||
            compareCanonicalText(right.runId, left.runId) ||
            right.pageNumber - left.pageNumber ||
            compareCanonicalText(right.observationId, left.observationId)
          );
        })[0];
      const fact = selected ? facts.get(selected.observationId) : undefined;
      return fact ? structuredClone(fact) : undefined;
    },
    async recordResourceNames(observations) {
      for (const observation of observations) {
        validateResourceName(observation);
        resourceNames.push(structuredClone(observation));
      }
    },
    async getResourceNames(resourceIds) {
      const wanted = new Set(resourceIds);
      const latest = new Map<string, { name: string; observedAt: string }>();
      for (const observation of resourceNames) {
        if (!wanted.has(observation.resourceId)) continue;
        const previous = latest.get(observation.resourceId);
        // Compare chronologically, not lexicographically: a mix of
        // fractional- and whole-second ISO strings would order wrong under a
        // plain string compare and let a stale name win.
        if (!previous || Date.parse(observation.observedAt) >= Date.parse(previous.observedAt)) {
          latest.set(observation.resourceId, observation);
        }
      }
      return new Map([...latest].map(([id, value]) => [id, value.name]));
    },
    async getRunPage(runId, pageNumber) {
      const write = pages.get(`${runId}:${pageNumber}`);
      return write ? structuredClone(write) : undefined;
    },
    async getCollectionRun(runId) {
      const run = runs.get(runId);
      return run ? structuredClone(run) : undefined;
    },
    close() {},
  };
}

function validatePage(
  write: CollectionPageWrite,
  storedEvidence: ReadonlyMap<string, NeonSourceEvidence>,
): void {
  validateRunId(write.runId);
  if (!Number.isInteger(write.pageNumber) || write.pageNumber < 1) {
    throw new TypeError("page number must be a positive integer");
  }
  for (const reference of write.evidence) {
    const record = storedEvidence.get(reference.evidenceId);
    if (!record || record.response.payloadHash !== reference.payloadHash) {
      throw new ConsumptionSourceIntegrityError(
        `Evidence ${reference.evidenceId} is missing or has a conflicting payload hash`,
      );
    }
    parseUtcTimestamp(record.completedAt, "evidence completion timestamp");
  }
  for (const fact of write.facts) validateFact(fact);
  for (const fact of write.facts) {
    const reference = write.evidence.find(
      (candidate) => candidate.evidenceId === fact.provenance.evidenceId,
    );
    const evidence = reference ? storedEvidence.get(reference.evidenceId) : undefined;
    if (
      !reference ||
      !evidence ||
      reference.payloadHash !== fact.provenance.payloadHash ||
      evidence.sourceContract !== fact.sourceContract
    ) {
      throw new ConsumptionSourceIntegrityError(
        `Observation ${fact.observationId} is not linked to page evidence`,
      );
    }
  }
}
