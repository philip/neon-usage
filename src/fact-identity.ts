import { createHash } from "node:crypto";

export type ObservationScopeIdentity =
  | { kind: "organization"; organizationId: string }
  | { kind: "project"; organizationId: string; projectId: string }
  | { kind: "branch"; organizationId: string; projectId: string; branchId: string };

export type EffectiveFactIdentityInput = {
  sourceContract: string;
  scope: ObservationScopeIdentity;
  periodId: string;
  bucket: { start: string; end: string };
  metricName: string;
};

export type ObservationIdentityInput = EffectiveFactIdentityInput & {
  payloadHash: string;
};

export function effectiveFactIdentity(input: EffectiveFactIdentityInput): string {
  return identity("fact", canonicalIdentity(input));
}

export function observationRevisionIdentity(input: ObservationIdentityInput): string {
  assertPayloadHash(input.payloadHash);
  return identity("observation", [...canonicalIdentity(input), input.payloadHash]);
}

function canonicalIdentity(input: EffectiveFactIdentityInput): string[] {
  const scope = scopeIdentity(input.scope);
  return [
    nonEmpty(input.sourceContract, "source contract"),
    ...scope,
    nonEmpty(input.periodId, "period ID"),
    nonEmpty(input.bucket.start, "bucket start"),
    nonEmpty(input.bucket.end, "bucket end"),
    nonEmpty(input.metricName, "metric name"),
  ];
}

function scopeIdentity(scope: ObservationScopeIdentity): string[] {
  const organizationId = nonEmpty(scope.organizationId, "organization ID");
  if (scope.kind === "organization") return [scope.kind, organizationId];
  const projectId = nonEmpty(scope.projectId, "project ID");
  if (scope.kind === "project") return [scope.kind, organizationId, projectId];
  return [scope.kind, organizationId, projectId, nonEmpty(scope.branchId, "branch ID")];
}

function nonEmpty(value: string, label: string): string {
  if (value.length === 0 || value.length > 500) {
    throw new TypeError(`${label} must contain between 1 and 500 characters`);
  }
  return value;
}

function assertPayloadHash(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("payload hash must be a lowercase SHA-256 identity");
  }
}

function identity(kind: "fact" | "observation", parts: string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${kind}:sha256:${digest}`;
}
