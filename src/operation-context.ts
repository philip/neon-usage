export type OperationContext = {
  signal?: AbortSignal;
  /** Operation-wide time budget, distinct from caller cancellation for safe history partials. */
  deadlineSignal?: AbortSignal;
  maxResponseBytes?: number;
  maxPages?: number;
  maxItems?: number;
  maxDurationMs?: number;
  /** Shared across snapshot requests and inventory pages before retaining body chunks. */
  retainedByteBudget?: { remaining: number };
  /** Shared across project and branch inventory pages before retaining their items. */
  retainedItemBudget?: { remaining: number };
};

export class OperationCancelledError extends Error {
  override readonly name = "OperationCancelledError";
  readonly kind = "cancelled";

  constructor(reason: unknown) {
    super("The operation was cancelled", { cause: reason });
  }
}

export class OperationByteLimitError extends Error {
  override readonly name = "OperationByteLimitError";
  readonly kind = "byte_limit";

  constructor() {
    super("The operation response-byte budget was exhausted");
  }
}

export class OperationLimitError extends Error {
  override readonly name = "OperationLimitError";

  constructor(readonly kind: "page_limit" | "item_limit" | "time_limit") {
    super(`The operation ${kind.replace("_limit", "")} budget was exhausted`);
  }
}

/** Detach cancellation even when an injected dependency never settles. */
export async function raceAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    throw new OperationCancelledError(signal.reason);
  }
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new OperationCancelledError(signal.reason));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}

export function isCancellationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("kind" in error && error.kind === "cancelled") ||
      ("name" in error && error.name === "AbortError"))
  );
}

export function throwIfAborted(context?: OperationContext): void {
  if (context?.signal?.aborted) {
    throw new OperationCancelledError(context.signal.reason);
  }
}
