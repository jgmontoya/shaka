#!/usr/bin/env bash
# Workflow `until` e2e — verifies dynamic loop-stopping through the real
# installed shaka CLI.
#
# Sourced from the provider e2e scripts. Inherits pass/fail/warn/section
# helpers and $SHAKA_HOME from the caller's scope.
#
# Usage:
#   source test/e2e/lib/workflow-until.sh
#   run_workflow_until_e2e                    # deterministic; no LLM; all providers
#   run_workflow_until_judge_e2e <provider>   # prompt-type judge; call only from
#                                             # a script's LLM-capable section
#
# pi.sh intentionally calls only the deterministic check: it scopes pi state
# to an auth-less test dir (PI_CODING_AGENT_DIR), so a judge there would
# always warn without testing anything.

# shellcheck shell=bash

run_workflow_until_e2e() {
  section "Workflow until (deterministic)"

  local wf_dir="$SHAKA_HOME/customizations/workflows"
  mkdir -p "$wf_dir"
  cat >"$wf_dir/until-e2e.yaml" <<'EOF'
description: e2e — deterministic run-type until
state: none
loop: 5
until:
  run: test -f done.txt
steps:
  - name: work
    run: |
      echo tick >> counter.txt
      test "$(wc -l < counter.txt)" -ge 2 && touch done.txt || true
EOF

  local work_dir output
  work_dir="$(mktemp -d)"
  output=$( (cd "$work_dir" && shaka run until-e2e) 2>&1 ) || true
  rm -rf "$work_dir"

  if echo "$output" | grep -q "satisfied after 2/5 iterations"; then
    pass "CLI reports early stop (satisfied after 2/5 iterations)"
  else
    fail "Missing early-stop summary line"
    echo "$output" | tail -10
    return 1
  fi

  local run_dir satisfied_at completed_iters
  run_dir=$(ls -td "$SHAKA_HOME/runs/until-e2e"-* 2>/dev/null | head -1) || true
  satisfied_at=$(jq '.satisfiedAt' "$run_dir/run.json" 2>/dev/null) || true
  completed_iters=$(jq '.completedIterations' "$run_dir/run.json" 2>/dev/null) || true

  if [ "$satisfied_at" = "2" ] && [ "$completed_iters" = "2" ]; then
    pass "run.json records satisfiedAt=2, completedIterations=2"
  else
    fail "run.json satisfiedAt=$satisfied_at completedIterations=$completed_iters (expected 2/2)"
    cat "$run_dir/run.json" 2>/dev/null || true
    return 1
  fi

  if [ -f "$run_dir/iter-1/until.out" ] && [ -f "$run_dir/iter-2/until.out" ] && [ ! -d "$run_dir/iter-3" ]; then
    pass "until.out artifacts for exactly 2 iterations"
  else
    fail "Unexpected until artifact layout"
    find "$run_dir" 2>/dev/null | head -20
    return 1
  fi
}

run_workflow_until_judge_e2e() {
  local provider="$1"

  section "Workflow until (LLM judge)"

  local wf_dir="$SHAKA_HOME/customizations/workflows"
  mkdir -p "$wf_dir"
  cat >"$wf_dir/until-judge-e2e.yaml" <<'EOF'
description: e2e — prompt-type until judged by a real LLM
state: none
loop: 3
until:
  prompt: |
    Read the file status.txt in the current working directory. Condition: the file
    contains the word READY.
steps:
  - name: advance
    run: |
      if [ -f step1 ]; then echo READY > status.txt; else touch step1; echo "not yet" > status.txt; fi
EOF

  # The judge dir must be a git repo — codex exec refuses untrusted non-git
  # directories. Harmless for the other providers.
  local judge_dir output
  judge_dir="$(mktemp -d)"
  git -C "$judge_dir" init -q
  git -C "$judge_dir" config user.email "e2e@example.com"
  git -C "$judge_dir" config user.name "Shaka E2E"
  git -C "$judge_dir" commit -q --allow-empty -m "init"

  echo "  Running: shaka run until-judge-e2e (up to 3 $provider judge calls)..."
  output=$( (cd "$judge_dir" && shaka run until-judge-e2e) 2>&1 ) || true
  rm -rf "$judge_dir"

  local run_dir satisfied_at
  run_dir=$(ls -td "$SHAKA_HOME/runs/until-judge-e2e"-* 2>/dev/null | head -1) || true
  satisfied_at=$(jq '.satisfiedAt' "$run_dir/run.json" 2>/dev/null) || true

  if [ "$satisfied_at" = "2" ]; then
    pass "$provider judge: CONTINUE at iter 1, SATISFIED at iter 2 (verdict protocol works)"
  elif [ "$satisfied_at" = "null" ]; then
    warn "Judge never satisfied — loop ran to cap (LLM may not have followed the verdict line)"
    tail -3 "$run_dir"/iter-*/until.out 2>/dev/null || true
  elif [ -z "$satisfied_at" ]; then
    fail "No run.json produced for until-judge-e2e"
    echo "$output" | tail -10
    return 1
  else
    warn "Judge satisfied at unexpected iteration: $satisfied_at"
    echo "$output" | tail -5
  fi
}
