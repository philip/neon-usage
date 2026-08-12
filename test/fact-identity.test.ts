import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  effectiveFactIdentity,
  type ObservationIdentityInput,
  observationRevisionIdentity,
} from "../src/fact-identity.js";

describe("consumption fact identities", () => {
  it("keeps the effective identity stable while corrected payloads create new revisions", () => {
    fc.assert(
      fc.property(hexDigest, hexDigest, (firstHash, secondHash) => {
        fc.pre(firstHash !== secondHash);
        const fact = identityInput(`sha256:${firstHash}`);
        const corrected = identityInput(`sha256:${secondHash}`);

        expect(effectiveFactIdentity(fact)).toBe(effectiveFactIdentity(corrected));
        expect(observationRevisionIdentity(fact)).not.toBe(observationRevisionIdentity(corrected));
      }),
    );
  });

  it("derives byte-stable identities for identical inputs", () => {
    fc.assert(
      fc.property(hexDigest, (hash) => {
        const input = identityInput(`sha256:${hash}`);
        expect(observationRevisionIdentity({ ...input, scope: { ...input.scope } })).toBe(
          observationRevisionIdentity(input),
        );
      }),
    );
  });

  it("distinguishes organization, project, and branch scopes", () => {
    const common = identityInput(`sha256:${"a".repeat(64)}`);
    const identities = [
      effectiveFactIdentity({
        ...common,
        scope: { kind: "organization", organizationId: "org-1" },
      }),
      effectiveFactIdentity(common),
      effectiveFactIdentity({
        ...common,
        scope: {
          kind: "branch",
          organizationId: "org-1",
          projectId: "project-1",
          branchId: "branch-1",
        },
      }),
    ];

    expect(new Set(identities).size).toBe(3);
  });

  it("rejects ambiguous empty identities and malformed payload hashes", () => {
    expect(() =>
      effectiveFactIdentity({
        ...identityInput(`sha256:${"a".repeat(64)}`),
        scope: { kind: "project", organizationId: "org-1", projectId: "" },
      }),
    ).toThrow("project ID must contain");
    expect(() => observationRevisionIdentity(identityInput("sha256:not-a-digest"))).toThrow(
      "payload hash must be a lowercase SHA-256 identity",
    );
  });
});

const hexDigest = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((characters) => characters.join(""));

function identityInput(payloadHash: string): ObservationIdentityInput {
  return {
    sourceContract: "consumption-history-v2-projects",
    scope: { kind: "project", organizationId: "org-1", projectId: "project-1" },
    periodId: "period-1",
    bucket: { start: "2026-08-07T00:00:00Z", end: "2026-08-08T00:00:00Z" },
    metricName: "compute_unit_seconds",
    payloadHash,
  };
}
