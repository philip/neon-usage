#!/usr/bin/env bash

set -euo pipefail

for command_name in curl jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

spec_url="${NEON_OPENAPI_URL:-https://neon.com/api_spec/release/v2.json}"
tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

curl --fail --silent --show-error --location "$spec_url" >"$tmp_file"

jq '{
  source: $source,
  openapi: .openapi,
  api_version: .info.version,
  relevant_paths: (
    .paths
    | to_entries
    | map(select(
        (.key | contains("consumption_history"))
        or (.key | contains("spending_limit"))
      ))
    | map({path: .key, methods: (.value | keys | map(select(. != "parameters")))})
  ),
  project_quota_properties: (
    .components.schemas
    | to_entries
    | map(select(.key | test("Project.*Quota|Quota.*Project"; "i")))
    | map({schema: .key, properties: (.value.properties // {} | keys)})
  )
}' --arg source "$spec_url" "$tmp_file"
