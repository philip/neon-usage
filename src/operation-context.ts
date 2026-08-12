export type OperationContext = {
  signal?: AbortSignal;
  maxResponseBytes?: number;
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
