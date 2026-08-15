export class ConsumptionSourceIntegrityError extends Error {
  override readonly name = "ConsumptionSourceIntegrityError";
  readonly integrityFailure = true;
}

/** The three parts of a presentable CLI error: a short headline, an optional
 *  detail line, and an optional actionable fix. See `formatCliError`. */
export type CliErrorParts = { headline: string; detail?: string; fix?: string };

/**
 * A user-facing error that carries its parts separately so the CLI can render
 * a headline plus an actionable "To fix" block instead of one long line. The
 * composed `.message` keeps a sensible single-string form for any consumer that
 * reads it plainly (logs, the HTTP adapter, tests that match on message text).
 */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly headline: string;
  readonly detail: string | undefined;
  readonly fix: string | undefined;
  constructor(parts: CliErrorParts) {
    // The parts render as separate blocks, but `.message` joins them into one
    // string for plain consumers (logs, tests). The headline carries no
    // trailing period so it reads as a heading when displayed; add one here so
    // the joined message reads as sentences rather than "expired The stored...".
    const asSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
    super(
      [parts.headline, parts.detail, parts.fix]
        .filter((part): part is string => Boolean(part))
        .map(asSentence)
        .join(" "),
    );
    this.headline = parts.headline;
    this.detail = parts.detail;
    this.fix = parts.fix;
  }
}

export type SourceErrorDetail = {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  attempts?: number;
  retryable?: boolean;
  retryAfterMs?: number;
};

const structuredSourceErrors = new WeakSet<object>();

export function markStructuredSourceError<T extends object>(error: T): T {
  structuredSourceErrors.add(error);
  return error;
}

const disallowedDisplayCharacter =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this filter exists to strip control characters
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function sanitizeErrorText(value: string, maxLength: number): string {
  let result = "";
  let length = 0;
  for (const character of value) {
    if (length >= maxLength) break;
    result += disallowedDisplayCharacter.test(character) ? " " : character;
    length += 1;
  }
  return result.trim();
}

export function toSourceErrorDetail(error: unknown): SourceErrorDetail {
  const record = typeof error === "object" && error !== null ? error : undefined;
  const read = (field: string): unknown => {
    if (!record) return undefined;
    try {
      return Reflect.get(record, field);
    } catch {
      return undefined;
    }
  };
  const readString = (field: string): string | undefined => {
    const value = read(field);
    return typeof value === "string" ? value : undefined;
  };
  const readInteger = (field: string, minimum: number, maximum: number): number | undefined => {
    const value = read(field);
    return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum
      ? value
      : undefined;
  };
  const readBoolean = (field: string): boolean | undefined => {
    const value = read(field);
    return typeof value === "boolean" ? value : undefined;
  };
  let trusted = false;
  if (record) {
    try {
      trusted = structuredSourceErrors.has(record);
    } catch {
      trusted = false;
    }
  }
  const kind = trusted ? readString("kind") : undefined;
  const providerCode = trusted ? readString("code") : undefined;
  const name = trusted ? readString("name") : undefined;
  const code = sanitizeErrorText(
    providerCode ??
      (kind ? `NEON_${kind.toUpperCase()}` : undefined) ??
      (name === "NeonApiError"
        ? "NEON_API_ERROR"
        : name === "NeonResponseTooLargeError"
          ? "NEON_RESPONSE_TOO_LARGE"
          : name === "NeonResponseError"
            ? "NEON_RESPONSE_INVALID"
            : name === "NeonEvidenceError"
              ? "NEON_EVIDENCE_FAILED"
              : "SOURCE_REQUEST_FAILED"),
    100,
  );
  const rawMessage = trusted ? readString("message") : undefined;
  const requestId = trusted ? readString("requestId") : undefined;
  const status = trusted ? readInteger("status", 100, 599) : undefined;
  const attempts = trusted ? readInteger("attempts", 0, 1000) : undefined;
  const retryable = trusted ? readBoolean("retryable") : undefined;
  const retryAfterMs = trusted ? readInteger("retryAfterMs", 0, 86_400_000) : undefined;
  return {
    code: trusted && code ? code : "SOURCE_REQUEST_FAILED",
    message: rawMessage
      ? sanitizeErrorText(rawMessage, 500) || "Source request failed"
      : "Source request failed",
    ...(status !== undefined ? { status } : {}),
    ...(requestId ? { requestId: sanitizeErrorText(requestId, 200) } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
