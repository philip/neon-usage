export interface RequestCoordinator {
  acquire(signal?: AbortSignal): Promise<void>;
}

export type SlidingWindowCoordinatorOptions = {
  limit: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
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
        if (admittedAt.length >= options.limit) {
          try {
            await cancellableSleep(
              (admittedAt[0] ?? now()) + options.intervalMs - now(),
              pending.signal,
              options.sleep,
            );
          } catch (error) {
            if (queue[0] === pending) {
              queue.shift();
              if (pending.cancel) pending.signal?.removeEventListener("abort", pending.cancel);
              pending.reject(error);
            }
          }
          continue;
        }
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
  customSleep: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<void> {
  if (!customSleep) {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      }, milliseconds);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    return;
  }
  let cancel: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    await Promise.race([customSleep(milliseconds), cancelled]);
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}
