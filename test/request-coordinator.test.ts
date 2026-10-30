import { describe, expect, it, vi } from "vitest";
import { raceAbort } from "../src/operation-context.js";
import { createSlidingWindowRequestCoordinator } from "../src/request-coordinator.js";

describe("sliding-window request coordinator", () => {
  it.each(["fulfilled", "rejected"] as const)(
    "prioritizes an existing abort over an already %s dependency",
    async (state) => {
      const controller = new AbortController();
      controller.abort("already stopped");
      const dependency =
        state === "fulfilled" ? Promise.resolve("finished") : Promise.reject(new Error("failed"));

      await expect(raceAbort(dependency, controller.signal)).rejects.toMatchObject({
        kind: "cancelled",
        cause: "already stopped",
      });
      // A rejected dependency must remain observed even after cancellation wins.
      await new Promise((resolve) => setImmediate(resolve));
    },
  );

  it("shares one request budget and waits before exceeding the window", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 2,
      intervalMs: 1000,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await coordinator.acquire();
    await coordinator.acquire();
    await coordinator.acquire();

    expect(sleeps).toEqual([1000]);
  });

  it("holds queued local capacity until upstream admission, then starts its window", async () => {
    let now = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstreamCalls: number[] = [];
    const sleeps: number[] = [];
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 1,
      intervalMs: 1000,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      upstream: {
        async acquire() {
          upstreamCalls.push(now);
          if (upstreamCalls.length === 1) await waiting;
        },
      },
    });
    const first = coordinator.acquire();
    const second = coordinator.acquire();
    expect(upstreamCalls).toEqual([0]);
    now = 5000;
    release();
    await Promise.all([first, second]);
    expect(upstreamCalls).toEqual([0, 6000]);
    expect(sleeps).toEqual([1000]);
  });

  it("does not consume local capacity when upstream admission fails", async () => {
    let calls = 0;
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 1,
      intervalMs: 1000,
      now: () => 0,
      sleep: async () => {
        throw new Error("local capacity was consumed");
      },
      upstream: {
        async acquire() {
          calls += 1;
          if (calls === 1) throw new Error("upstream failed");
        },
      },
    });
    await expect(coordinator.acquire()).rejects.toThrow("upstream failed");
    await coordinator.acquire();
    expect(calls).toBe(2);
  });

  it("keeps the next waiter when cancellation follows upstream resolution", async () => {
    const controller = new AbortController();
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    const removal = vi
      .spyOn(controller.signal, "removeEventListener")
      .mockImplementation((type, listener, options) => {
        remove(type, listener, options);
        controller.abort(new Error("cancelled at resolution"));
      });
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 1,
      intervalMs: 1000,
      now: () => 0,
      sleep: async () => {
        throw new Error("cancelled admission consumed local capacity");
      },
      upstream: { acquire: async () => {} },
    });
    try {
      const first = coordinator.acquire(controller.signal);
      const rejected = expect(first).rejects.toThrow("cancelled at resolution");
      const second = coordinator.acquire();
      await rejected;
      await second;
    } finally {
      removal.mockRestore();
    }
  });

  it("cancels a waiting acquisition promptly", async () => {
    const controller = new AbortController();
    let now = 0;
    let sleepCalls = 0;
    const completedSleeps: number[] = [];
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 1,
      intervalMs: 1000,
      now: () => now,
      sleep: async (milliseconds) => {
        sleepCalls += 1;
        if (sleepCalls === 1) return new Promise(() => {});
        completedSleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    await coordinator.acquire();
    const waiting = coordinator.acquire(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancelled"));

    await expect(waiting).rejects.toThrow("cancelled");
    await coordinator.acquire();
    expect(completedSleeps).toEqual([1000]);
  });

  it("removes a cancelled acquisition while another caller is waiting", async () => {
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 1,
      intervalMs: 1000,
      sleep: async () => new Promise(() => {}),
    });
    await coordinator.acquire();
    const active = coordinator.acquire(activeController.signal);
    const queued = coordinator.acquire(queuedController.signal);
    queuedController.abort(new Error("queued cancelled"));

    await expect(queued).rejects.toThrow("queued cancelled");
    activeController.abort(new Error("active cancelled"));
    await expect(active).rejects.toThrow("active cancelled");
  });

  it("forwards cancellation to a cooperative injected sleep", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let cleanedUp = false;
    const coordinator = createSlidingWindowRequestCoordinator({
      limit: 1,
      intervalMs: 1000,
      sleep: async (_milliseconds: number, signal?: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              cleanedUp = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    await coordinator.acquire();
    const waiting = coordinator.acquire(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
    expect(cleanedUp).toBe(true);
  });
});
