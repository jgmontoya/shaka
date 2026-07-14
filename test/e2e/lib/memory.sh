#!/usr/bin/env bash
# Deterministic memory recall checks shared by every provider E2E suite.
# Uses on-disk fixtures so these assertions exercise installed Shaka surfaces
# without adding model latency or inference variance.

# shellcheck shell=bash

memory_e2e_contains() {
  local output="$1"
  local expected="$2"
  printf '%s\n' "$output" | grep -Fq "$expected"
}

memory_e2e_assert_scope() {
  local output="$1"
  local included="$2"
  local excluded="$3"
  local label="$4"

  if memory_e2e_contains "$output" "$included" && ! memory_e2e_contains "$output" "$excluded"; then
    pass "$label"
    return 0
  fi

  fail "$label"
  printf '%s\n' "$output"
  return 1
}

memory_e2e_assert_both() {
  local output="$1"
  local first="$2"
  local second="$3"
  local label="$4"

  if memory_e2e_contains "$output" "$first" && memory_e2e_contains "$output" "$second"; then
    pass "$label"
    return 0
  fi

  fail "$label"
  printf '%s\n' "$output"
  return 1
}

run_memory_recall_e2e() (
  set -eu

  section "Memory recall contract"

  fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/shaka-memory-e2e.XXXXXX")
  current_project="$fixture_root/current-project"
  unrelated_project="$fixture_root/unrelated-project"
  memory_dir="$SHAKA_HOME/memory"
  sessions_dir="$memory_dir/sessions"
  knowledge_root="$memory_dir/knowledge"
  current_knowledge="$knowledge_root/memory-e2e-current"
  unrelated_knowledge="$knowledge_root/memory-e2e-unrelated"
  current_session_file="$sessions_dir/2026-07-14-memorye2e-current.md"
  unrelated_session_file="$sessions_dir/2026-07-14-memorye2e-unrelated.md"

  memory_e2e_cleanup() {
    rm -f "$current_session_file" "$unrelated_session_file"
    rm -rf "$current_knowledge" "$unrelated_knowledge" "$fixture_root"
    if [ -n "${compiled_metadata_dir:-}" ]; then
      rm -rf "$compiled_metadata_dir"
    fi
  }
  trap memory_e2e_cleanup EXIT

  mkdir -p \
    "$current_project" \
    "$unrelated_project" \
    "$sessions_dir" \
    "$current_knowledge" \
    "$unrelated_knowledge"

  # macOS resolves /var through /private/var in process.cwd(); persist the
  # physical paths so fixture metadata and Shaka's runtime CWD are identical.
  current_project=$(cd "$current_project" && pwd -P)
  unrelated_project=$(cd "$unrelated_project" && pwd -P)

  cat >"$current_session_file" <<EOF
---
date: "2026-07-14"
cwd: $current_project
tags: [memory-e2e]
provider: claude
session_id: memory-e2e-current
---

# Memory E2E Current Session

## Summary

memory-e2e-scope-token
MEMORY_E2E_CURRENT_SESSION_CONTEXT
EOF

  cat >"$unrelated_session_file" <<EOF
---
date: "2026-07-14"
cwd: $unrelated_project
tags: [memory-e2e]
provider: claude
session_id: memory-e2e-unrelated
---

# Memory E2E Unrelated Session

## Summary

memory-e2e-scope-token
MEMORY_E2E_UNRELATED_SESSION_CONTEXT
EOF

  printf '{"cwd":"%s"}\n' "$current_project" >"$current_knowledge/.project.json"
  printf '{"cwd":"%s"}\n' "$unrelated_project" >"$unrelated_knowledge/.project.json"

  cat >"$current_knowledge/memory-design.md" <<'EOF'
---
title: Memory E2E Current Knowledge
updated: 2026-07-14
summary: Current project knowledge fixture.
---

memory-e2e-knowledge-token
EOF

  cat >"$unrelated_knowledge/memory-design.md" <<'EOF'
---
title: Memory E2E Unrelated Knowledge
updated: 2026-07-14
summary: Unrelated project knowledge fixture.
---

memory-e2e-knowledge-token
EOF

  cat >"$current_knowledge/_index.md" <<'EOF'
# Current Project Knowledge

MEMORY_E2E_CURRENT_KNOWLEDGE_CONTEXT
EOF

  cat >"$unrelated_knowledge/_index.md" <<'EOF'
# Unrelated Project Knowledge

MEMORY_E2E_UNRELATED_KNOWLEDGE_CONTEXT
EOF

  local default_output
  default_output=$(cd "$current_project" && shaka memory search memory-e2e-scope-token)
  memory_e2e_assert_scope \
    "$default_output" \
    "Memory E2E Current Session" \
    "Memory E2E Unrelated Session" \
    "Default memory search stays in the current project"

  local all_output
  all_output=$(cd "$current_project" && shaka memory search memory-e2e-scope-token --all)
  memory_e2e_assert_both \
    "$all_output" \
    "Memory E2E Current Session" \
    "Memory E2E Unrelated Session" \
    "All-project memory search is explicit"

  local explicit_output
  explicit_output=$(shaka memory search memory-e2e-scope-token --cwd "$unrelated_project")
  memory_e2e_assert_scope \
    "$explicit_output" \
    "Memory E2E Unrelated Session" \
    "Memory E2E Current Session" \
    "Explicit project search selects one project"

  local knowledge_output
  knowledge_output=$(
    cd "$current_project" && shaka memory search memory-e2e-knowledge-token --type knowledge
  )
  memory_e2e_assert_scope \
    "$knowledge_output" \
    "[knowledge] Memory E2E Current Knowledge" \
    "Memory E2E Unrelated Knowledge" \
    "Compiled knowledge is searchable"

  local tool_output
  tool_output=$(
    cd "$current_project" && \
      printf '%s\n' '{"query":"memory-e2e-scope-token","all_projects":true}' | \
      shaka tool memory-search
  )
  memory_e2e_assert_both \
    "$tool_output" \
    "Memory E2E Current Session" \
    "Memory E2E Unrelated Session" \
    "Memory-search tool honors all_projects"

  local context_output
  context_output=$(cd "$current_project" && bun "$SHAKA_HOME/system/hooks/session-start.ts" 2>/dev/null)
  memory_e2e_assert_scope \
    "$context_output" \
    "MEMORY_E2E_CURRENT_SESSION_CONTEXT" \
    "MEMORY_E2E_UNRELATED_SESSION_CONTEXT" \
    "Session-start context stays in the current project"
  memory_e2e_assert_scope \
    "$context_output" \
    "MEMORY_E2E_CURRENT_KNOWLEDGE_CONTEXT" \
    "MEMORY_E2E_UNRELATED_KNOWLEDGE_CONTEXT" \
    "Session-start knowledge stays in the current project"

  local metadata_project="$fixture_root/metadata-project"
  mkdir -p "$metadata_project"
  metadata_project=$(cd "$metadata_project" && pwd -P)
  (cd "$metadata_project" && shaka memory compile >/dev/null)

  local metadata_file=""
  local candidate
  for candidate in "$knowledge_root"/*/.project.json; do
    [ -f "$candidate" ] || continue
    if grep -Fq "\"cwd\":\"$metadata_project\"" "$candidate"; then
      metadata_file="$candidate"
      break
    fi
  done

  if [ -n "$metadata_file" ]; then
    compiled_metadata_dir=$(dirname "$metadata_file")
    pass "Compiled knowledge records project metadata"
  else
    fail "Compiled knowledge records project metadata"
    return 1
  fi
)
