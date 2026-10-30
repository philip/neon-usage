export type NeonUsageErrorCode =
  | "INVALID_INPUT"
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "UNSUPPORTED_CAPABILITY"
  | "PROVIDER_UNAVAILABLE"
  | "COLLECTION_LIMIT_REACHED"
  | "CANCELLED"
  | "CLIENT_BUSY"
  | "CLIENT_CLOSED"
  | "INTEGRITY_FAILURE";

const messages: Record<NeonUsageErrorCode, string> = {
  INVALID_INPUT: "The client configuration or operation input is invalid.",
  AUTHENTICATION_FAILED: "Neon did not accept the access token.",
  AUTHORIZATION_FAILED: "This credential cannot access the requested Neon resource.",
  UNSUPPORTED_CAPABILITY: "Project consumption history is unsupported by this plan.",
  PROVIDER_UNAVAILABLE: "Neon usage is temporarily unavailable. Try again later.",
  COLLECTION_LIMIT_REACHED: "The operation reached a collection limit.",
  CANCELLED: "The operation was cancelled.",
  CLIENT_BUSY: "This client already has an active operation.",
  CLIENT_CLOSED: "This client is closed.",
  INTEGRITY_FAILURE: "The usage data could not be verified.",
};

export class NeonUsageError extends Error {
  override readonly name = "NeonUsageError";
  readonly code: NeonUsageErrorCode;
  declare readonly providerStatus?: number;
  declare readonly requestId?: string;
  declare readonly cause?: never;

  constructor(
    code: NeonUsageErrorCode,
    metadata: { providerStatus?: number; requestId?: string } = {},
  ) {
    const validatedCode = Object.hasOwn(messages, code) ? code : "INVALID_INPUT";
    super(messages[validatedCode]);
    this.code = validatedCode;
    if (
      typeof metadata.providerStatus === "number" &&
      Number.isInteger(metadata.providerStatus) &&
      metadata.providerStatus >= 100 &&
      metadata.providerStatus <= 599
    ) {
      this.providerStatus = metadata.providerStatus;
    }
    if (typeof metadata.requestId === "string") {
      const requestId = [...metadata.requestId]
        .slice(0, 256)
        .join("")
        .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
        .trim();
      if (requestId) this.requestId = requestId;
    }
  }
}
