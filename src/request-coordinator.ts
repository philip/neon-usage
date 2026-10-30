import { raceAbort } from "./operation-context.js";

export interface RequestCoordinator {
  acquire(signal?: AbortSignal): Promise<void>;
}

export type SlidingWindowCoordinatorOptions = {
  limit: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  upstream?: RequestCoordinator;
};

type Pending = {
  signal?: AbortSignal;
  resolve(): void;
  reject(reason: unknown): void;
  cancel?: () => void;
};

export function createSlidingWindowRequestCoordinator(
  options: SlidingWindowCoordinatorOptions,
): RequestCoordinator {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError("intervalMs must be positive");
  }
  const now = options.now ?? (() => performance.now());
  const admittedAt: number[] = [];
  const queue: Pending[] = [];
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue[0]) {
        const pending = queue[0];
        if (pending.signal?.aborted) {
          queue.shift();
          pending.reject(pending.signal.reason);
          continue;
        }
        const cutoff = now() - options.intervalMs;
        while (admittedAt[0] !== undefined && admittedAt[0] <= cutoff) admittedAt.shift();
        try {
          if (admittedAt.length >= options.limit) {
            await cancellableSleep(
              (admittedAt[0] ?? now()) + options.intervalMs - now(),
              pending.signal,
              options.sleep,
            );
            continue;
          }
          // Hold local capacity until upstream admits, so neither permit ages during another wait.
          if (options.upstream) {
            await raceAbort(options.upstream.acquire(pending.signal), pending.signal);
          }
        } catch (error) {
          if (queue[0] === pending) {
            queue.shift();
            if (pending.cancel) pending.signal?.removeEventListener("abort", pending.cancel);
            pending.reject(error);
          }
          continue;
        }
        if (queue[0] !== pending) continue;
        queue.shift();
        if (pending.cancel) pending.signal?.removeEventListener("abort", pending.cancel);
        admittedAt.push(now());
        pending.resolve();
      }
    } finally {
      running = false;
      if (queue.length > 0) void pump();
    }
  }

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise<void>((resolve, reject) => {
        const pending: Pending = { ...(signal ? { signal } : {}), resolve, reject };
        pending.cancel = () => {
          const index = queue.indexOf(pending);
          if (index >= 0) queue.splice(index, 1);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", pending.cancel, { once: true });
        queue.push(pending);
        void pump();
      });
    },
  };
}

async function cancellableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
  customSleep: SlidingWindowCoordinatorOptions["sleep"],
): Promise<void> {
  if (customSleep) return raceAbort(customSleep(milliseconds, signal), signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceAbort(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
