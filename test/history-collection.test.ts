import { describe, expect, it, vi } from "vitest";
import { collectHistoryPages } from "../src/history-collection.js";
import { createInMemoryEvidenceFactStore } from "../src/in-memory-fact-store.js";
import { NeonResponseTooLargeError } from "../src/neon-api-source.js";

type Page = { items: readonly string[]; nextCursor: string | null };

describe("collectHistoryPages", () => {
  it("retains accepted pages with a fixed byte-limit flag for an oversized later response", async () => {
    const result = await collectHistoryPages<Page>({
      maxPages: 10,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async (cursor) => {
        if (cursor !== null)
          throw new NeonResponseTooLargeError("secret provider response", {
            status: 200,
            requestId: "secret-request",
            attempts: 1,
          });
        return { items: ["accepted"], nextCursor: "next" };
      },
    });
    expect(result.pages).toEqual([{ items: ["accepted"], nextCursor: "next" }]);
    expect(result.qualityFlags).toEqual(["BYTE_LIMIT_REACHED"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    "beginCollectionRun",
    "appendCollectionPage",
    "recordCollectionRun",
    "onPage",
    "onRunFinished",
  ] as const)("bounds a non-cooperative %s with the collection deadline", async (phase) => {
    const store = createInMemoryEvidenceFactStore();
    const deadline = new AbortController();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const stallWrite = async (_input: unknown, signal?: AbortSignal) => {
      receivedSignal = signal;
      entered();
      return new Promise<never>(() => {});
    };
    const stallCallback = async () => {
      entered();
      return new Promise<never>(() => {});
    };
    if (phase === "beginCollectionRun") store.beginCollectionRun = stallWrite;
    if (phase === "appendCollectionPage") store.appendCollectionPage = stallWrite;
    if (phase === "recordCollectionRun") store.recordCollectionRun = stallWrite;
    const result = collectHistoryPages<Page>({
      maxPages: 10,
      context: { deadlineSignal: deadline.signal },
      store,
      intent: { sourceAccount: "test", sourceContract: "test", request: {} },
      pageWrite: () => ({ facts: [], evidence: [] }),
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => ({ items: [], nextCursor: null }),
      ...(phase === "onPage" ? { onPage: stallCallback } : {}),
      ...(phase === "onRunFinished" ? { onRunFinished: stallCallback } : {}),
    }).catch((error: unknown) => error);
    await started;
    deadline.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        result,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: "stalled" }), 100);
        }),
      ]);
      expect(settled).toMatchObject({ kind: "time_limit" });
      if (phase.endsWith("Run") || phase === "appendCollectionPage") {
        expect(receivedSignal?.aborted).toBe(true);
      }
    } finally {
      clearTimeout(timer);
      store.close();
    }
  });

  it.each([
    "beginCollectionRun",
    "appendCollectionPage",
    "recordCollectionRun",
    "getPage",
    "onPage",
  ] as const)("cancels a non-cooperative %s promptly", async (phase) => {
    const controller = new AbortController();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stall = async () => {
      entered();
      return new Promise<never>(() => {});
    };
    const store = createInMemoryEvidenceFactStore();
    if (phase === "beginCollectionRun") store.beginCollectionRun = stall;
    if (phase === "appendCollectionPage") store.appendCollectionPage = stall;
    if (phase === "recordCollectionRun") store.recordCollectionRun = stall;
    const result = collectHistoryPages<Page>({
      maxPages: 10,
      context: { signal: controller.signal },
      store,
      intent: { sourceAccount: "test", sourceContract: "test", request: {} },
      pageWrite: () => ({ facts: [], evidence: [] }),
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: phase === "getPage" ? stall : async () => ({ items: [], nextCursor: null }),
      ...(phase === "onPage" ? { onPage: stall } : {}),
    }).catch((error: unknown) => error);
    await started;
    controller.abort("stop");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        result,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: "stalled" }), 100);
        }),
      ]);
      expect(settled).toMatchObject({ name: "OperationCancelledError", kind: "cancelled" });
    } finally {
      clearTimeout(timer);
      store.close();
    }
  });

  it("commits each accepted page before requesting its continuation", async () => {
    const events: string[] = [];
    const result = await collectHistoryPages<Page, string>({
      maxPages: 10,
      createRunId: () => "run_test",
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async (cursor) => {
        events.push(`request:${cursor ?? "first"}`);
        return cursor === null
          ? { items: ["one"], nextCursor: "next" }
          : { items: ["two"], nextCursor: null };
      },
      onPage: async (_page, checkpoint) => {
        events.push(`commit:${checkpoint.nextCursor ?? "complete"}`);
      },
    });

    expect(events).toEqual(["request:first", "commit:next", "request:next", "commit:complete"]);
    expect(result).toEqual({
      runId: "run_test",
      pages: [
        { items: ["one"], nextCursor: "next" },
        { items: ["two"], nextCursor: null },
      ],
      items: ["one", "two"],
      status: "complete",
      qualityFlags: [],
      errors: [],
      errorDetails: [],
    });
  });

  it("deduplicates entities in the collection result", async () => {
    let calls = 0;
    const result = await collectHistoryPages<Page, string>({
      maxPages: 10,
      getItems: (page) => page.items,
      getItemKey: (item) => item,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        calls += 1;
        return { items: ["one"], nextCursor: calls === 1 ? "next" : null };
      },
    });

    expect(result.items).toEqual(["one"]);
    expect(result.qualityFlags).toEqual(["ENTITY_DUPLICATED"]);
    expect(result.status).toBe("partial");
  });

  it("does not persist an invalid continuation as a checkpoint", async () => {
    const checkpoints: Array<{
      runId: string;
      pageNumber: number;
      nextCursor: string | null;
      complete: boolean;
    }> = [];
    await collectHistoryPages<Page>({
      maxPages: 10,
      createRunId: () => "run_test",
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => ({ items: [], nextCursor: "invalid" }),
      onPage: async (_page, checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(checkpoints).toEqual([
      {
        runId: "run_test",
        pageNumber: 1,
        cursorIn: null,
        cursorOut: "invalid",
        nextCursor: null,
        complete: false,
        terminalState: "empty_page_with_cursor",
      },
    ]);
  });

  it("creates one opaque run ID per invocation", async () => {
    const collect = () =>
      collectHistoryPages<Page>({
        maxPages: 1,
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => ({ items: [], nextCursor: null }),
      });

    const [first, second] = await Promise.all([collect(), collect()]);
    expect(first.runId).toMatch(/^run_[A-Za-z0-9-]+$/);
    expect(second.runId).not.toBe(first.runId);
  });

  it("never downgrades an operation aborted with a primitive reason", async () => {
    const controller = new AbortController();
    await expect(
      collectHistoryPages<Page>({
        maxPages: 10,
        context: { signal: controller.signal },
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => {
          controller.abort("stop");
          return { items: ["one"], nextCursor: "next" };
        },
      }),
    ).rejects.toMatchObject({ name: "OperationCancelledError", kind: "cancelled" });
  });

  it.each([
    [
      "repeated cursors",
      [
        { items: ["one"], nextCursor: "same" },
        { items: ["two"], nextCursor: "same" },
      ],
      10,
      "CURSOR_REPEATED",
    ],
    ["empty continuation pages", [{ items: [], nextCursor: "next" }], 10, "EMPTY_PAGE_WITH_CURSOR"],
    ["page budgets", [{ items: ["one"], nextCursor: "next" }], 1, "PAGE_LIMIT_REACHED"],
  ] as const)("marks %s partial", async (_label, pages, maxPages, expectedFlag) => {
    let index = 0;
    const result = await collectHistoryPages<Page>({
      maxPages,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => pages[index++] as Page,
    });

    expect(result.status).toBe("partial");
    expect(result.qualityFlags).toEqual([expectedFlag]);
  });

  it("refuses an over-budget page atomically and bounds cumulative facts", async () => {
    let calls = 0;
    const committed: Page[] = [];
    const result = await collectHistoryPages<Page, string>({
      maxPages: 10,
      maxItems: 2,
      maxFacts: 2,
      getItems: (page) => page.items,
      getFactCount: () => 1,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        calls += 1;
        return calls === 1
          ? { items: ["one"], nextCursor: "next" }
          : { items: ["two", "three"], nextCursor: null };
      },
      onPage: async (page) => {
        committed.push(page);
      },
    });

    expect(result.status).toBe("partial");
    expect(result.qualityFlags).toEqual(["ITEM_LIMIT_REACHED"]);
    expect(result.items).toEqual(["one"]);
    expect(committed).toHaveLength(1);
  });

  it("bounds cumulative response bytes across accepted pages", async () => {
    let calls = 0;
    const result = await collectHistoryPages<Page & { responseBytes: number }, string>({
      maxPages: 10,
      maxBytes: 10,
      getItems: (page) => page.items,
      getByteCount: (page) => page.responseBytes,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        calls += 1;
        return {
          items: [String(calls)],
          responseBytes: 6,
          nextCursor: calls === 1 ? "next" : null,
        };
      },
    });
    expect(result).toMatchObject({ status: "partial", qualityFlags: ["BYTE_LIMIT_REACHED"] });
    expect(result.items).toEqual(["1"]);
  });

  it("preflights a shared page budget before another collection starts", async () => {
    let calls = 0;
    const budget = {
      maxPages: 1,
      startedAt: performance.now(),
      items: 0,
      facts: 0,
      bytes: 0,
      pages: 1,
    };
    const result = await collectHistoryPages<Page>({
      maxPages: 1,
      budget,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        calls += 1;
        return { items: ["unexpected"], nextCursor: null };
      },
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: "partial", qualityFlags: ["PAGE_LIMIT_REACHED"] });
  });

  it.each(["store", "callback", "store_and_callback"] as const)(
    "preserves deadline partials and skips unstarted %s finalization",
    async (configured) => {
      const store = createInMemoryEvidenceFactStore();
      const recordCollectionRun = store.recordCollectionRun;
      const intent = { sourceAccount: "test", sourceContract: "test", request: {} };
      let storeFinalizations = 0;
      let callbackFinalizations = 0;
      store.recordCollectionRun = async () => {
        storeFinalizations += 1;
        return new Promise(() => {});
      };
      const callbacks = {
        onRunFinished: async () => {
          callbackFinalizations += 1;
          return new Promise<void>(() => {});
        },
      };
      const persistence = {
        store,
        intent,
        pageWrite: () => ({ facts: [], evidence: [] }),
      };
      try {
        const result = await collectHistoryPages<Page, string>({
          maxPages: 10,
          maxDurationMs: 20,
          createRunId: () => "run_deadline-partial",
          ...(configured === "callback" ? {} : persistence),
          ...(configured === "store" ? {} : callbacks),
          getItems: (page) => page.items,
          getNextCursor: (page) => page.nextCursor,
          getPage: async (cursor) =>
            cursor === null ? { items: ["one"], nextCursor: "next" } : new Promise(() => {}),
        });

        expect(result).toMatchObject({
          status: "partial",
          qualityFlags: ["TIME_LIMIT_REACHED"],
          items: ["one"],
        });
        expect(storeFinalizations).toBe(0);
        expect(callbackFinalizations).toBe(0);
        if (configured !== "callback") {
          expect(await store.getCollectionRun(result.runId)).toMatchObject({
            status: "running",
            pageCount: 1,
          });
          expect(await store.getRunPage(result.runId, 1)).toMatchObject({
            nextCursor: "next",
            terminalState: "continue",
          });

          store.recordCollectionRun = recordCollectionRun;
          const resumed = await collectHistoryPages<Page, string>({
            ...persistence,
            maxPages: 10,
            maxDurationMs: 100,
            resumeRunId: result.runId,
            getItems: (page) => page.items,
            getNextCursor: (page) => page.nextCursor,
            getPage: async (cursor) => {
              expect(cursor).toBe("next");
              return { items: ["two"], nextCursor: null };
            },
          });
          expect(resumed).toMatchObject({ status: "complete", items: ["one", "two"] });
          expect(await store.getCollectionRun(result.runId)).toMatchObject({ status: "complete" });
        }
      } finally {
        store.close();
      }
    },
  );

  it("marks an in-flight collection partial when its duration budget expires", async () => {
    const result = await collectHistoryPages<Page>({
      maxPages: 10,
      maxDurationMs: 10,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async (_cursor, context) =>
        new Promise((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
            once: true,
          });
        }),
    });
    expect(result).toMatchObject({ status: "partial", qualityFlags: ["TIME_LIMIT_REACHED"] });
  });

  it("skips finalization when monotonic time expires before the deadline signal fires", async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const store = createInMemoryEvidenceFactStore();
    const finalization = vi.spyOn(store, "recordCollectionRun");
    const callback = vi.fn(async () => {});
    try {
      const result = await collectHistoryPages<Page>({
        maxPages: 10,
        maxDurationMs: 20,
        store,
        intent: { sourceAccount: "test", sourceContract: "test", request: {} },
        pageWrite: () => ({ facts: [], evidence: [] }),
        getItems: (page) => page.items,
        getNextCursor: (page) => {
          elapsed = 21;
          return page.nextCursor;
        },
        getPage: async () => ({ items: ["one"], nextCursor: "next" }),
        onRunFinished: callback,
      });
      expect(result).toMatchObject({ status: "partial", qualityFlags: ["TIME_LIMIT_REACHED"] });
      expect(finalization).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(await store.getCollectionRun(result.runId)).toMatchObject({
        status: "running",
        pageCount: 1,
      });
      expect(await store.getRunPage(result.runId, 1)).toMatchObject({ nextCursor: "next" });
    } finally {
      clock.mockRestore();
      store.close();
    }
  });

  it("retains accepted pages after a later ordinary source failure", async () => {
    let calls = 0;
    const result = await collectHistoryPages<Page>({
      maxPages: 10,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        calls += 1;
        if (calls === 2) throw new Error("unavailable");
        return { items: ["one"], nextCursor: "next" };
      },
    });

    expect(result.pages).toHaveLength(1);
    expect(result.qualityFlags).toEqual(["SOURCE_REQUEST_FAILED"]);
    expect(result.errors).toEqual(["Source request failed"]);
    expect(result.errorDetails).toEqual([
      { code: "SOURCE_REQUEST_FAILED", message: "Source request failed" },
    ]);
  });

  it("does not downgrade cancellation or page commit failures", async () => {
    const cancellation = Object.assign(new Error("cancelled"), { kind: "cancelled" });
    await expect(
      collectHistoryPages<Page>({
        maxPages: 10,
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => {
          throw cancellation;
        },
      }),
    ).rejects.toBe(cancellation);

    const commitFailure = new Error("commit failed");
    await expect(
      collectHistoryPages<Page>({
        maxPages: 10,
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => ({ items: ["one"], nextCursor: null }),
        onPage: async () => {
          throw commitFailure;
        },
      }),
    ).rejects.toBe(commitFailure);
  });

  it("resumes committed pages and finalizes a committed terminal page without a request", async () => {
    const store = createInMemoryEvidenceFactStore();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "test-pages",
      request: { scope: "one" },
    } as const;
    await store.beginCollectionRun({ runId: "run_resume", intent });
    await store.appendCollectionPage({
      runId: "run_resume",
      pageNumber: 1,
      cursorIn: null,
      cursorOut: null,
      nextCursor: null,
      terminalState: "complete",
      page: { items: ["one"], nextCursor: null },
      evidence: [],
      facts: [],
    });

    const result = await collectHistoryPages<Page, string>({
      maxPages: 10,
      resumeRunId: "run_resume",
      intent,
      store,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        throw new Error("terminal resume must not request another page");
      },
      pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
    });

    expect(result.items).toEqual(["one"]);
    expect(result.status).toBe("complete");
    expect((await store.getCollectionRun("run_resume"))?.status).toBe("complete");
  });

  it("validates committed pages again before restoring a resumed run", async () => {
    const store = createInMemoryEvidenceFactStore();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "test-pages",
      request: { scope: "one" },
    } as const;
    await store.beginCollectionRun({ runId: "run_resume-invalid", intent });
    await store.appendCollectionPage({
      runId: "run_resume-invalid",
      pageNumber: 1,
      cursorIn: null,
      cursorOut: null,
      nextCursor: null,
      terminalState: "complete",
      page: { items: ["invalid"], nextCursor: null },
      evidence: [],
      facts: [],
    });

    await expect(
      collectHistoryPages<Page, string>({
        maxPages: 10,
        resumeRunId: "run_resume-invalid",
        intent,
        store,
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => {
          throw new Error("must not request another page");
        },
        validatePage: () => {
          throw new Error("stored page failed validation");
        },
        pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
      }),
    ).rejects.toThrow("stored page failed validation");
  });

  it("marks restored complete runs partial when a smaller page budget truncates replay", async () => {
    const store = createInMemoryEvidenceFactStore();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "test-pages",
      request: { scope: "one" },
    } as const;
    await store.beginCollectionRun({ runId: "run_page-budget", intent });
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
      await store.appendCollectionPage({
        runId: "run_page-budget",
        pageNumber,
        cursorIn: pageNumber === 1 ? null : "next",
        cursorOut: pageNumber === 1 ? "next" : null,
        nextCursor: pageNumber === 1 ? "next" : null,
        terminalState: pageNumber === 1 ? "continue" : "complete",
        page: { items: [String(pageNumber)], nextCursor: pageNumber === 1 ? "next" : null },
        evidence: [],
        facts: [],
      });
    }
    await store.recordCollectionRun({
      runId: "run_page-budget",
      sourceContract: "test-pages",
      status: "complete",
      completedAt: "2026-08-12T00:00:00Z",
      pageCount: 2,
      qualityFlags: [],
    });

    const result = await collectHistoryPages<Page, string>({
      maxPages: 1,
      resumeRunId: "run_page-budget",
      intent,
      store,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        throw new Error("complete run must not request a page");
      },
      pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
    });
    expect(result).toMatchObject({ status: "partial", qualityFlags: ["PAGE_LIMIT_REACHED"] });
    expect(result.pages).toHaveLength(1);
  });

  it("preserves committed page-count integrity when a smaller budget truncates a running run", async () => {
    const store = createInMemoryEvidenceFactStore();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "test-pages",
      request: { scope: "one" },
    } as const;
    await store.beginCollectionRun({ runId: "run_running-page-budget", intent });
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
      await store.appendCollectionPage({
        runId: "run_running-page-budget",
        pageNumber,
        cursorIn: pageNumber === 1 ? null : "next-1",
        cursorOut: `next-${pageNumber}`,
        nextCursor: `next-${pageNumber}`,
        terminalState: "continue",
        page: { items: [String(pageNumber)], nextCursor: `next-${pageNumber}` },
        evidence: [],
        facts: [],
      });
    }

    const result = await collectHistoryPages<Page, string>({
      maxPages: 1,
      resumeRunId: "run_running-page-budget",
      intent,
      store,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        throw new Error("truncated resume must not request another page");
      },
      pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
    });

    expect(result).toMatchObject({ status: "partial", qualityFlags: ["PAGE_LIMIT_REACHED"] });
    expect(result.pages).toHaveLength(1);
    expect(await store.getCollectionRun("run_running-page-budget")).toMatchObject({
      status: "partial",
      pageCount: 2,
      qualityFlags: ["PAGE_LIMIT_REACHED"],
    });
  });

  it("rejects an explicit run ID that already exists instead of replaying it", async () => {
    const store = createInMemoryEvidenceFactStore();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "test-pages",
      request: { scope: "one" },
    } as const;
    const collect = (calls: string[]) =>
      collectHistoryPages<Page, string>({
        maxPages: 10,
        createRunId: () => "run_reused",
        intent,
        store,
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => {
          calls.push("call");
          return { items: [`item-${calls.length}`], nextCursor: null };
        },
        pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
      });

    const firstCalls: string[] = [];
    const first = await collect(firstCalls);
    expect(first.items).toEqual(["item-1"]);
    expect(firstCalls).toHaveLength(1);

    const secondCalls: string[] = [];
    await expect(collect(secondCalls)).rejects.toThrow(
      "Collection run run_reused already exists; resume it or choose a new run ID",
    );
    expect(secondCalls).toHaveLength(0);
  });

  it("rejects resume when immutable collection intent differs", async () => {
    const store = createInMemoryEvidenceFactStore();
    await store.beginCollectionRun({
      runId: "run_resume",
      intent: {
        sourceAccount: "account-1",
        sourceContract: "test-pages",
        request: { scope: "one" },
      },
    });

    await expect(
      collectHistoryPages<Page>({
        maxPages: 10,
        resumeRunId: "run_resume",
        intent: {
          sourceAccount: "account-1",
          sourceContract: "test-pages",
          request: { scope: "different" },
        },
        store,
        getItems: (page) => page.items,
        getNextCursor: (page) => page.nextCursor,
        getPage: async () => ({ items: [], nextCursor: null }),
        pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
      }),
    ).rejects.toThrow("intent does not match");
    expect((await store.getCollectionRun("run_resume"))?.status).toBe("running");
  });

  it("restores the exact terminal continuation quality from a committed checkpoint", async () => {
    const store = createInMemoryEvidenceFactStore();
    const intent = {
      sourceAccount: "account-1",
      sourceContract: "test-pages",
      request: { scope: "one" },
    } as const;
    await store.beginCollectionRun({ runId: "run_invalid-resume", intent });
    await store.appendCollectionPage({
      runId: "run_invalid-resume",
      pageNumber: 1,
      cursorIn: null,
      cursorOut: "invalid",
      nextCursor: null,
      terminalState: "empty_page_with_cursor",
      page: { items: [], nextCursor: "invalid" },
      evidence: [],
      facts: [],
    });

    const result = await collectHistoryPages<Page>({
      maxPages: 10,
      resumeRunId: "run_invalid-resume",
      intent,
      store,
      getItems: (page) => page.items,
      getNextCursor: (page) => page.nextCursor,
      getPage: async () => {
        throw new Error("terminal checkpoint must not request a page");
      },
      pageWrite: (page, checkpoint) => ({ ...checkpoint, page, evidence: [], facts: [] }),
    });

    expect(result.status).toBe("partial");
    expect(result.qualityFlags).toEqual(["EMPTY_PAGE_WITH_CURSOR"]);
  });
});
