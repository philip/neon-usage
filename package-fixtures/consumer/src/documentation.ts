// README example: history
import { createNeonUsageClient, NeonUsageError } from "neon-usage";

export async function collectHistory(accessToken: string, organizationId: string) {
  const client = createNeonUsageClient({ accessToken });
  try {
    return await client.collectMeasuredUsage({
      organizationId,
      source: "history",
      query: {
        from: "2026-10-23T00:00:00.000Z",
        to: "2026-10-24T00:00:00.000Z",
        granularity: "daily",
        metrics: ["compute_unit_seconds"],
      },
    });
  } catch (error) {
    if (error instanceof NeonUsageError && error.code === "AUTHENTICATION_FAILED") {
      console.error("Refresh the server-held Neon credential before retrying.");
    }
    throw error;
  } finally {
    client.close();
  }
}

// README example: current
import { createNeonUsageClient as createCurrentClient } from "neon-usage";

export async function collectCurrent(accessToken: string, organizationId: string) {
  const client = createCurrentClient({ accessToken });
  try {
    return await client.collectMeasuredUsage({
      organizationId,
      source: "current",
      projectIds: ["project-fixture"],
    });
  } finally {
    client.close();
  }
}

// README example: coordinator
import {
  createNeonUsageClient as createCoordinatedClient,
  type RequestCoordinator,
} from "neon-usage";

export async function listWithSharedCoordinator(
  accessToken: string,
  requestCoordinator: RequestCoordinator,
) {
  const first = createCoordinatedClient({ accessToken, requestCoordinator });
  const second = createCoordinatedClient({ accessToken, requestCoordinator });
  try {
    return await Promise.all([first.listOrganizations(), second.listOrganizations()]);
  } finally {
    first.close();
    second.close();
  }
}

// README example: contracts
import { parseMeasuredBillingUsage } from "neon-usage/contracts";

export function parseCliExport(jsonText: string) {
  const input: unknown = JSON.parse(jsonText);
  return parseMeasuredBillingUsage(input);
}
