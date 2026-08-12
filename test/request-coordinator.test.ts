import { describe, expect, it } from "vitest";
import { createSlidingWindowRequestCoordinator } from "../src/request-coordinator.js";

describe("sliding-window request coordinator", () => {
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
});
