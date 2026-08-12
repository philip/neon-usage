import { describe, expect, it } from "vitest";
import { SerializedOutputTooLargeError, serializeMachineJson } from "../src/machine-json.js";

describe("serializeMachineJson output budget", () => {
  it("remains unlimited unless a delivery adapter supplies a budget", () => {
    expect(() => serializeMachineJson({ value: "x".repeat(100) })).not.toThrow();
  });

  it("counts exact UTF-8 bytes including formatting and newline", () => {
    const output = serializeMachineJson({ value: "é" });
    const bytes = Buffer.byteLength(output);
    expect(serializeMachineJson({ value: "é" }, { maxBytes: bytes })).toBe(output);
    expect(() => serializeMachineJson({ value: "é" }, { maxBytes: bytes - 1 })).toThrowError(
      SerializedOutputTooLargeError,
    );
  });
});
