#!/usr/bin/env bash

set -euo pipefail

for command_name in neon jq node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

context_file="${NEON_CONTEXT_FILE:-.neon}"
org_id="${ORG_ID:-}"
project_id="${PROJECT_ID:-}"

if [[ -z "$org_id" && -f "$context_file" ]]; then
  org_id="$(jq -r '.orgId // empty' "$context_file")"
fi

if [[ -z "$project_id" && -f "$context_file" ]]; then
  project_id="$(jq -r '.projectId // empty' "$context_file")"
fi

if [[ -z "$org_id" ]]; then
  printf 'Set ORG_ID or provide orgId in %s\n' "$context_file" >&2
  exit 1
fi

to="${TO:-$(node -e 'const d=new Date(); d.setUTCMinutes(0,0,0); process.stdout.write(d.toISOString())')}"
from="${FROM:-$(TO="$to" node -e 'const d=new Date(process.env.TO); d.setUTCDate(d.getUTCDate()-2); process.stdout.write(d.toISOString())')}"
granularity="${GRANULARITY:-daily}"
limit="${PAGE_SIZE:-2}"
metrics="compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,instant_restore_bytes_month,snapshot_storage_bytes_month,public_network_transfer_bytes,private_network_transfer_bytes,extra_branches_month"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

neon api /consumption_history/v2/projects -o json \
  -Q "org_id=$org_id" \
  -Q "from=$from" \
  -Q "to=$to" \
  -Q "granularity=$granularity" \
  -Q "metrics=$metrics" \
  -Q "limit=$limit" >"$tmp_dir/projects.json"

jq '{
  query_kind: "project_consumption",
  project_count: (.projects | length),
  period_count: ([.projects[].periods[]] | length),
  bucket_count: ([.projects[].periods[].consumption[]] | length),
  period_plans: ([.projects[].periods[].period_plan] | unique),
  returned_metrics: ([.projects[].periods[].consumption[].metrics[].metric_name] | unique),
  has_next_cursor: ((.pagination.cursor // "") != "")
}' "$tmp_dir/projects.json"

cursor="$(jq -r '.pagination.cursor // empty' "$tmp_dir/projects.json")"
if [[ -n "$cursor" ]]; then
  neon api /consumption_history/v2/projects -o json \
    -Q "org_id=$org_id" \
    -Q "from=$from" \
    -Q "to=$to" \
    -Q "granularity=$granularity" \
    -Q "metrics=$metrics" \
    -Q "limit=$limit" \
    -Q "cursor=$cursor" >"$tmp_dir/projects-next.json"

  jq --arg previous_cursor "$cursor" '{
    query_kind: "project_consumption_next_page",
    project_count: (.projects | length),
    has_next_cursor: ((.pagination.cursor // "") != ""),
    cursor_advanced: ((.pagination.cursor // "") != $previous_cursor)
  }' "$tmp_dir/projects-next.json"
fi

if [[ -n "$project_id" ]]; then
  branch_metrics="compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,instant_restore_bytes_month,public_network_transfer_bytes,private_network_transfer_bytes"
  neon api /consumption_history/v2/branches -o json \
    -Q "org_id=$org_id" \
    -Q "project_ids=$project_id" \
    -Q "from=$from" \
    -Q "to=$to" \
    -Q "granularity=$granularity" \
    -Q "metrics=$branch_metrics" \
    -Q "limit=$limit" >"$tmp_dir/branches.json"

  jq '{
    query_kind: "branch_consumption",
    branch_count: (.branches | length),
    period_count: ([.branches[].periods[]] | length),
    bucket_count: ([.branches[].periods[].consumption[]] | length),
    returned_metrics: ([.branches[].periods[].consumption[].metrics[].metric_name] | unique),
    has_next_cursor: ((.pagination.cursor // "") != "")
  }' "$tmp_dir/branches.json"
fi

neon api "/organizations/$org_id/billing/spending_limit" -o json \
  | jq '{query_kind: "spending_notification", configured: (.spending_limit_cents != null), spending_limit_cents}'
