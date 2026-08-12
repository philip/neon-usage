import { describe, expect, it } from "vitest";
import { markStructuredSourceError, toSourceErrorDetail } from "../src/errors.js";

describe("toSourceErrorDetail", () => {
  it("does not expose messages from untrusted errors", () => {
    const detail = toSourceErrorDetail(new Error("token=provider-secret"));

    expect(detail).toEqual({
      code: "SOURCE_REQUEST_FAILED",
      message: "Source request failed",
    });
  });

  it("survives hostile property access", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter secret");
        },
      },
    );

    expect(toSourceErrorDetail(hostile)).toEqual({
      code: "SOURCE_REQUEST_FAILED",
      message: "Source request failed",
    });
  });

  it("omits invalid numeric metadata from trusted structured errors", () => {
    const detail = toSourceErrorDetail(
      markStructuredSourceError({
        code: "FAILED",
        message: "failed",
        status: 999,
        attempts: 1.5,
        retryAfterMs: Number.MAX_SAFE_INTEGER,
        retryable: true,
      }),
    );

    expect(detail).toEqual({
      code: "FAILED",
      message: "failed",
      retryable: true,
    });
  });
});
