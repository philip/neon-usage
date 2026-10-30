import { NeonUsageError } from "./client-errors.js";
import type { CurrentSnapshotError } from "./current-snapshot-service.js";

const inventoryMessages: Readonly<Record<string, string>> = {
  PROJECT_NOT_IN_INVENTORY: "Requested project is not in the organization inventory",
  PROJECT_INVENTORY_UNAVAILABLE: "Project details were unavailable during project inventory",
  PROJECT_INVENTORY_TRUNCATED:
    "Project inventory pagination repeated a cursor; the inventory may be incomplete",
};

export function measuredSnapshotErrors(
  errors: readonly CurrentSnapshotError[],
  includeRequestId: (requestId: string) => boolean = () => true,
): CurrentSnapshotError[] {
  return errors.map((error) => {
    const status = error.detail?.status;
    const requestId = error.detail?.requestId;
    const code = error.detail?.code;
    const message =
      code && Object.hasOwn(inventoryMessages, code) ? inventoryMessages[code] : undefined;
    if (error.source === "project_list" && status === undefined && code && message) {
      return {
        projectId: error.projectId,
        source: error.source,
        message,
        detail: { code, message },
      };
    }
    const sanitized = new NeonUsageError(
      status === undefined && code === "COLLECTION_LIMIT_REACHED" && error.source !== "project_list"
        ? "COLLECTION_LIMIT_REACHED"
        : status === 401
          ? "AUTHENTICATION_FAILED"
          : status === 403
            ? "AUTHORIZATION_FAILED"
            : "PROVIDER_UNAVAILABLE",
      {
        ...(status !== undefined ? { providerStatus: status } : {}),
        ...(requestId && includeRequestId(requestId) ? { requestId } : {}),
      },
    );
    return {
      projectId: error.projectId,
      source: error.source,
      message: sanitized.message,
      detail: {
        code: sanitized.code,
        message: sanitized.message,
        ...(sanitized.providerStatus !== undefined ? { status: sanitized.providerStatus } : {}),
        ...(sanitized.requestId ? { requestId: sanitized.requestId } : {}),
      },
    };
  });
}
