export class SerializedOutputTooLargeError extends Error {
  override readonly name = "SerializedOutputTooLargeError";
  readonly code = "SERIALIZED_OUTPUT_TOO_LARGE";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Serialized output is ${actualBytes} bytes, exceeding the ${maxBytes}-byte limit`);
  }
}

export function serializeMachineJson(value: unknown, options: { maxBytes?: number } = {}): string {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  if (options.maxBytes !== undefined) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    const actualBytes = Buffer.byteLength(output);
    if (actualBytes > options.maxBytes) {
      throw new SerializedOutputTooLargeError(actualBytes, options.maxBytes);
    }
  }
  return output;
}
