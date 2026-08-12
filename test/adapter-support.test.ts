import { describe, expect, it } from "vitest";
import {
  historyQueryFromOptions,
  memoizeReports,
  serializeCollections,
  withPlanHint,
} from "../src/index.js";

describe("historyQueryFromOptions --month", () => {
  const now = new Date("2026-08-11T09:00:00Z");

  it("expands a past month to its full [from, to) range", () => {
    const query = historyQueryFromOptions({ granularity: "monthly", month: "2026-07" }, now);
    expect(query.from).toBe("2026-07-01T00:00:00.000Z");
    expect(query.to).toBe("2026-08-01T00:00:00.000Z");
  });

  it("clamps the current month to the last complete day (to date)", () => {
    const query = historyQueryFromOptions({ granularity: "daily", month: "2026-08" }, now);
    expect(query.from).toBe("2026-08-01T00:00:00.000Z");
    expect(query.to).toBe("2026-08-11T00:00:00.000Z");
  });

  it("resolves the current and previous keywords", () => {
    const current = historyQueryFromOptions({ granularity: "daily", month: "current" }, now);
    expect(current.from).toBe("2026-08-01T00:00:00.000Z");
    expect(current.to).toBe("2026-08-11T00:00:00.000Z");

    const previous = historyQueryFromOptions({ granularity: "monthly", month: "previous" }, now);
    expect(previous.from).toBe("2026-07-01T00:00:00.000Z");
    expect(previous.to).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects a malformed month and conflicts with other range options", () => {
    expect(() => historyQueryFromOptions({ granularity: "daily", month: "July" }, now)).toThrow(
      "calendar month",
    );
    expect(() =>
      historyQueryFromOptions({ granularity: "daily", month: "2026-07", last: "7d" }, now),
    ).toThrow("--month cannot be combined");
  });
});

describe("withPlanHint", () => {
  it("appends Free-plan guidance to the Launch-and-above history refusal", () => {
    const message =
      "Neon API request failed with HTTP 403: This endpoint is not available. " +
      "It is included with Launch plans and above.";
    const hinted = withPlanHint(message, 403);
    expect(hinted.startsWith(message)).toBe(true);
    expect(hinted).toContain("current-report");
    expect(hinted).toContain("capabilities");
  });

  it("leaves other errors untouched, including 403s that are not the plan gate", () => {
    expect(withPlanHint("some other 403", 403)).toBe("some other 403");
    expect(withPlanHint("Launch plans and above", 401)).toBe("Launch plans and above");
    expect(withPlanHint("network failure", undefined)).toBe("network failure");
  });
});

describe("memoizeReports store-tail identity", () => {
  const query = {
    organizationId: "org-1",
    from: "2026-08-01T00:00:00Z",
    to: "2026-08-02T00:00:00Z",
    granularity: "daily" as const,
    metrics: ["compute_unit_seconds"],
  };
  const baseDeps = (onProjectReport: () => void) =>
    ({
      projectReport: async () => {
        onProjectReport();
        return { schemaVersion: 1, coverage: { status: "complete" } };
      },
      branchReport: async () => ({}),
      organizationSummary: async () => ({}),
      currentReport: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial stub for the memo test
    }) as any;

  it("caches identical requests but not different store-tail values", async () => {
    let calls = 0;
    const memo = memoizeReports(
      baseDeps(() => calls++),
      { now: () => 0 },
    );

    await memo.projectReport(query, { storeServing: { serve: true, tailBuckets: 0 } });
    await memo.projectReport(query, { storeServing: { serve: true, tailBuckets: 0 } });
    expect(calls).toBe(1); // same tail -> cached

    await memo.projectReport(query, { storeServing: { serve: true, tailBuckets: 2 } });
    expect(calls).toBe(2); // different tail -> recollected, not a stale hit
  });
});

describe("serializeCollections queue bounds", () => {
  const deps = (impl: () => Promise<unknown>) =>
    ({
      projectReport: impl,
      branchReport: async () => ({}),
      organizationSummary: async () => ({}),
      currentReport: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial stub
    }) as any;

  it("releases the queue slot even when the operation throws synchronously", async () => {
    const boom = () => {
      throw new Error("store rejected");
    };
    const serialized = serializeCollections(deps(boom), { maxQueued: 3 });
    for (let index = 0; index < 5; index += 1) {
      await expect(serialized.projectReport({} as never)).rejects.toThrow("store rejected");
    }
    // A healthy call still gets a slot — the counter must not have leaked.
    const healthy = serializeCollections(deps(boom), { maxQueued: 3 });
    // biome-ignore lint/suspicious/noExplicitAny: partial stub
    (healthy as any).projectReport = healthy.projectReport;
    const ok = serializeCollections(
      deps(async () => ({ fine: true })),
      { maxQueued: 3 },
    );
    await expect(ok.projectReport({} as never)).resolves.toEqual({ fine: true });
    // And on the SAME instance: after the failures settle, capacity is back.
    await expect(serialized.projectReport({} as never)).rejects.toThrow("store rejected");
  });

  it("reports queue transitions through onQueueChange", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const states: Array<{ running: number; queued: number }> = [];
    const slow = serializeCollections(
      deps(() => gate.then(() => ({}))),
      { onQueueChange: (state) => states.push(state) },
    );
    const first = slow.projectReport({} as never);
    const second = slow.projectReport({} as never);
    expect(states).toEqual([
      { running: 1, queued: 0 },
      { running: 1, queued: 1 },
    ]);
    release();
    await Promise.all([first, second]);
    expect(states.at(-1)).toEqual({ running: 0, queued: 0 });
    expect(states).toHaveLength(4);
  });

  it("refuses beyond maxQueued with a typed capacity error", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = serializeCollections(
      deps(() => gate.then(() => ({}))),
      { maxQueued: 2 },
    );
    const first = slow.projectReport({} as never);
    const second = slow.projectReport({} as never);
    const third = slow.projectReport({} as never);
    await expect(slow.projectReport({} as never)).rejects.toThrow(/too many collections/);
    await expect(slow.projectReport({} as never)).rejects.toMatchObject({
      name: "CollectionQueueFullError",
    });
    release();
    await Promise.all([first, second, third]);
  });

  it("removes a cancelled waiter before it can execute", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const states: Array<{ running: number; queued: number }> = [];
    const serialized = serializeCollections(
      deps(async () => {
        calls.push(calls.length === 0 ? "first" : "second");
        if (calls.length === 1) await gate;
        return {};
      }),
      { onQueueChange: (state) => states.push(state) },
    );
    const first = serialized.projectReport({ id: "first" } as never);
    const controller = new AbortController();
    const second = serialized.projectReport({ id: "second" } as never, undefined, {
      signal: controller.signal,
    });
    controller.abort("left page");
    await expect(second).rejects.toMatchObject({ kind: "cancelled" });
    expect(states.at(-1)).toEqual({ running: 1, queued: 0 });
    release();
    await first;
    expect(calls).toEqual(["first"]);
  });
});

describe("memoizeReports size bound", () => {
  it("never evicts an in-flight single-flight entry", async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memo = memoizeReports(
      {
        projectReport: async (query: unknown) => {
          calls += 1;
          if ((query as { slow?: boolean }).slow) await gate;
          return {};
        },
        branchReport: async () => ({}),
        organizationSummary: async () => ({}),
        currentReport: async () => ({}),
        // biome-ignore lint/suspicious/noExplicitAny: partial stub
      } as any,
      { now: () => 0, maxEntries: 2 },
    );
    const pending = memo.projectReport({ slow: true } as never);
    await memo.projectReport({ a: 1 } as never);
    await memo.projectReport({ a: 2 } as never); // evicts the settled entry, never the pending one
    const again = memo.projectReport({ slow: true } as never);
    release();
    await Promise.all([pending, again]);
    // The slow query ran exactly once: the pending entry survived eviction.
    expect(calls).toBe(3);
  });

  it("keeps shared work alive until every subscriber cancels", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: unknown) => void> = [];
    const memo = memoizeReports({
      projectReport: async (
        _query: unknown,
        _control: unknown,
        context: { signal?: AbortSignal },
      ) => {
        if (context.signal) signals.push(context.signal);
        return new Promise((resolve) => resolvers.push(resolve));
      },
      branchReport: async () => ({}),
      organizationSummary: async () => ({}),
      currentReport: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial stub
    } as any);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = memo.projectReport({ id: "same" } as never, undefined, {
      signal: firstController.signal,
    });
    const second = memo.projectReport({ id: "same" } as never, undefined, {
      signal: secondController.signal,
    });
    await Promise.resolve();
    firstController.abort("first left");
    await expect(first).rejects.toMatchObject({ kind: "cancelled" });
    expect(signals[0]?.aborted).toBe(false);
    resolvers[0]?.({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });

    const thirdController = new AbortController();
    const fourthController = new AbortController();
    const third = memo.projectReport({ id: "other" } as never, undefined, {
      signal: thirdController.signal,
    });
    const fourth = memo.projectReport({ id: "other" } as never, undefined, {
      signal: fourthController.signal,
    });
    await Promise.resolve();
    thirdController.abort();
    fourthController.abort();
    await expect(third).rejects.toMatchObject({ kind: "cancelled" });
    await expect(fourth).rejects.toMatchObject({ kind: "cancelled" });
    expect(signals[1]?.aborted).toBe(true);
  });

  it("starts fresh work when the previous entry lost every subscriber", async () => {
    let calls = 0;
    const memo = memoizeReports({
      projectReport: async (
        _query: unknown,
        _control: unknown,
        context: { signal?: AbortSignal },
      ) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
              once: true,
            });
          });
        }
        return { call: calls };
      },
      branchReport: async () => ({}),
      organizationSummary: async () => ({}),
      currentReport: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial stub
    } as any);
    const controller = new AbortController();
    const abandoned = memo.projectReport({ id: "same" } as never, undefined, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ kind: "cancelled" });
    await expect(memo.projectReport({ id: "same" } as never)).resolves.toEqual({ call: 2 });
  });
});

describe("memoizeReports default-equivalent controls", () => {
  it("shares one entry between a plain request and an explicit default control", async () => {
    let calls = 0;
    const memo = memoizeReports({
      projectReport: async () => {
        calls += 1;
        return { call: calls };
      },
      branchReport: async () => ({}),
      organizationSummary: async () => ({}),
      currentReport: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial stub
    } as any);
    await memo.projectReport({ q: 1 } as never);
    // {serve:true, tailBuckets:0} IS the built-in default: same identity.
    await memo.projectReport({ q: 1 } as never, {
      storeServing: { serve: true, tailBuckets: 0 },
    });
    expect(calls).toBe(1);
    // A nonzero tail is a different identity and must not share.
    await memo.projectReport({ q: 1 } as never, {
      storeServing: { serve: true, tailBuckets: 2 },
    });
    expect(calls).toBe(2);
  });
});

describe("memoizeReports fresh and TTL semantics", () => {
  const stub = (impl: (query: unknown, control?: unknown) => Promise<unknown>) =>
    ({
      projectReport: impl,
      branchReport: async () => ({}),
      organizationSummary: async () => ({}),
      currentReport: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: partial stub
    }) as any;

  it("a fresh request replaces the entry that plain requests read", async () => {
    let calls = 0;
    const memo = memoizeReports(
      stub(async () => ({ call: ++calls })),
      { now: () => 0 },
    );
    const query = { organizationId: "org-1" };
    await expect(memo.projectReport(query as never)).resolves.toEqual({ call: 1 });
    // fresh=1 bypasses the cache read AND replaces the shared entry...
    await expect(
      memo.projectReport(
        query as never,
        {
          storeServing: { serve: false, tailBuckets: 0 },
        } as never,
      ),
    ).resolves.toEqual({ call: 2 });
    // ...so a subsequent plain request serves the fresh result, not the stale one.
    await expect(memo.projectReport(query as never)).resolves.toEqual({ call: 2 });
    expect(calls).toBe(2);
  });

  it("TTL expiry never evicts a pending single-flight entry", async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let at = 0;
    const memo = memoizeReports(
      stub(async () => {
        calls += 1;
        await gate;
        return {};
      }),
      { now: () => at, ttlMs: 1000 },
    );
    const first = memo.projectReport({ a: 1 } as never);
    at = 5000; // far past the TTL while the collection is still running
    const second = memo.projectReport({ a: 1 } as never);
    release();
    await Promise.all([first, second]);
    // The pending entry survived expiry: no duplicate collection started.
    expect(calls).toBe(1);
  });
});
