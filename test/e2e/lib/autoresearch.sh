#!/usr/bin/env bash
# Autoresearch e2e — bounded 2-iteration loop against a real provider CLI.
#
# Sourced from claudecode.sh / opencode.sh / codex.sh after each script has
# confirmed its provider's auth is available. Inherits pass/fail/warn/section
# helpers and $SHAKA_HOME from the caller's scope.
#
# Usage:
#   source test/e2e/lib/autoresearch.sh
#   run_autoresearch_e2e <expected-provider-name>

# shellcheck shell=bash

run_autoresearch_e2e() {
  local provider="$1"
  local ar_root="/tmp/ar-e2e-${provider}"
  local ar_wt="${ar_root}.ar-drop-the-sleep"
  local prev_pwd="$PWD"

  cleanup_autoresearch() {
    cd "$prev_pwd" >/dev/null 2>&1 || true
    git -C "$ar_root" worktree remove "$ar_wt" --force >/dev/null 2>&1 || true
    git -C "$ar_root" branch -D autoresearch/drop-the-sleep >/dev/null 2>&1 || true
    rm -rf "$ar_root" "$ar_wt"
  }

  fail_autoresearch() {
    cleanup_autoresearch
    return 1
  }

  section "Autoresearch"

  local skill_path="$SHAKA_HOME/system/skills/Autoresearch/SKILL.md"
  if [ -f "$skill_path" ]; then
    pass "Autoresearch skill deployed"
  else
    fail "Autoresearch SKILL.md missing from $skill_path"
    fail_autoresearch
    return $?
  fi

  # Scratch repo, kept well away from shaka's own git state
  rm -rf "$ar_root" "$ar_wt"
  mkdir "$ar_root"
  cd "$ar_root" || { fail "cannot cd to $ar_root"; fail_autoresearch; return $?; }

  git init -q -b main
  git config user.email ar@shaka
  git config user.name ar

  # Optimization target — an obvious sleep the agent can remove or shorten
  cat > slow.sh <<'EOF'
#!/bin/sh
sleep 0.3
EOF
  chmod +x slow.sh

  # Finalized spec + benchmark. With --wizard (below), setupWorkspace runs in
  # its non-TTY todo-template mode, inherits these files tracked at HEAD, and
  # doesn't overwrite — the worktree gets the finalized spec verbatim and the
  # loop runs. Without --wizard, full-auto's interactive default would hard-
  # error on the non-TTY guard before touching the worktree.
  cat > autoresearch.md <<'EOF'
# Autoresearch: drop the sleep

Speed up slow.sh. The sleep in slow.sh is unnecessary work; shorten or remove
it to reduce the benchmark's measured runtime.

## Metric

- command: `./autoresearch.sh`
- unit: ms
- direction: minimize

## Files in scope

- slow.sh

## Off-limits

- autoresearch.*
EOF

  cat > autoresearch.sh <<'EOF'
#!/bin/sh
set -e
START_MS=$(bun -e 'console.log(Date.now())')
./slow.sh
END_MS=$(bun -e 'console.log(Date.now())')
echo "METRIC name=runtime value=$(( END_MS - START_MS )) unit=ms"
EOF
  chmod +x autoresearch.sh

  git add -A
  git -c commit.gpgSign=false commit -q -m "spec"

  echo "  Running: shaka autoresearch start 'drop the sleep' --wizard --provider $provider --max-iterations 2"
  # `--wizard` opts out of the interactive full-auto default — this test ships
  # a finalized spec at HEAD and just wants to exercise the loop, not author
  # setup via a provider TUI. Without the flag, `runFullAutoStart` hard-errors
  # on the non-TTY guard (bash-script stdin isn't a TTY) before the loop ever
  # runs.
  #
  # Force the provider under test. Without --provider, Shaka auto-detects,
  # which on multi-CLI boxes (the common user) can silently exercise the
  # wrong backend and turn the per-entry provider check below into a false
  # positive.
  #
  # Capture the exit status — masking with `|| true` would let the E2E pass
  # even if autoresearch segfaulted or panicked after creating partial
  # artifacts. Fail loudly with the log so real regressions don't slip
  # through the post-condition checks below.
  local ar_status=0
  shaka autoresearch start "drop the sleep" --wizard --provider "$provider" --max-iterations 2 >/tmp/ar.log 2>&1 || ar_status=$?
  if [ "$ar_status" -ne 0 ]; then
    fail "autoresearch start failed (exit $ar_status)"
    tail -30 /tmp/ar.log
    fail_autoresearch
    return $?
  fi

  if [ -d "$ar_wt" ]; then
    pass "experiment worktree created at $ar_wt"
  else
    fail "experiment worktree missing"
    tail -30 /tmp/ar.log
    fail_autoresearch
    return $?
  fi

  local ar_jsonl="$ar_wt/autoresearch.jsonl"
  if [ ! -f "$ar_jsonl" ]; then
    fail "autoresearch.jsonl not created"
    tail -30 /tmp/ar.log
    fail_autoresearch
    return $?
  fi

  local entries
  entries=$(wc -l < "$ar_jsonl" | tr -d ' ')
  if [ "$entries" = "2" ]; then
    pass "two iterations recorded"
  else
    fail "expected 2 jsonl entries, got $entries"
    cat "$ar_jsonl"
    fail_autoresearch
    return $?
  fi

  # Per-iteration structural assertions + warn-only LLM assertions
  local i entry iter verdict attributed_provider hyp
  for i in 1 2; do
    entry=$(sed -n "${i}p" "$ar_jsonl")

    iter=$(echo "$entry" | jq -r '.iter' 2>/dev/null || echo "parse-error")
    if [ "$iter" = "$i" ]; then
      pass "entry $i has iter=$i"
    else
      fail "entry $i has iter=$iter, expected $i"
      fail_autoresearch
      return $?
    fi

    verdict=$(echo "$entry" | jq -r '.verdict' 2>/dev/null || echo "parse-error")
    case "$verdict" in
      keep|discard|incorrect|crash|timeout)
        pass "entry $i verdict is valid: $verdict"
        ;;
      *)
        fail "entry $i has unknown verdict: $verdict"
        echo "$entry"
        fail_autoresearch
        return $?
        ;;
    esac

    attributed_provider=$(echo "$entry" | jq -r '.provider' 2>/dev/null)
    if [ "$attributed_provider" = "$provider" ]; then
      pass "entry $i attributed to $provider"
    else
      # Hard fail: with --provider forced above, any mismatch indicates a
      # real routing bug. Downgrading to `warn` would mask it.
      fail "entry $i provider is $attributed_provider (expected '$provider')"
      fail_autoresearch
      return $?
    fi

    hyp=$(echo "$entry" | jq -r '.hypothesis' 2>/dev/null)
    if [ -n "$hyp" ] && [ "$hyp" != "null" ]; then
      pass "entry $i hypothesis: $(echo "$hyp" | cut -c1-60)"
    else
      warn "entry $i has no hypothesis (agent may not have followed the response format)"
    fi
  done

  if git -C "$ar_root" rev-parse --verify autoresearch/drop-the-sleep >/dev/null 2>&1; then
    pass "experiment branch exists"
  else
    fail "experiment branch missing"
    fail_autoresearch
    return $?
  fi

  # Cleanup
  cleanup_autoresearch
}

# Autoresearch --oneshot e2e — exercises the full-auto non-interactive path.
#
# Unlike run_autoresearch_e2e (which pre-commits a finalized spec and uses
# --wizard to bypass the TTY guard), this test ships ONLY the target file at
# HEAD and lets the setup agent author autoresearch.md + autoresearch.sh via
# --oneshot. Covers the entire full-auto contract: objective → agent-authored
# setup → validation gate → commit → loop.
#
# Real LLM cost: one setup call + one loop iteration per invocation. Bounded
# to --max-iterations 1 so providers don't rack up a big token bill in CI.
#
# Usage (mirrors run_autoresearch_e2e):
#   source test/e2e/lib/autoresearch.sh
#   run_autoresearch_oneshot_e2e <expected-provider-name>

run_autoresearch_oneshot_e2e() {
  local provider="$1"
  local ar_root="/tmp/ar-e2e-oneshot-${provider}"
  local ar_wt="${ar_root}.ar-measure-slow-sh-runtime-in-ms"
  local prev_pwd="$PWD"

  cleanup_oneshot() {
    cd "$prev_pwd" >/dev/null 2>&1 || true
    git -C "$ar_root" worktree remove "$ar_wt" --force >/dev/null 2>&1 || true
    git -C "$ar_root" branch -D autoresearch/measure-slow-sh-runtime-in-ms >/dev/null 2>&1 || true
    rm -rf "$ar_root" "$ar_wt"
  }

  fail_oneshot() {
    cleanup_oneshot
    return 1
  }

  section "Autoresearch (--oneshot)"

  # Scratch repo with ONLY the target file — no spec, no harness. The agent
  # authors them from the objective.
  rm -rf "$ar_root" "$ar_wt"
  mkdir "$ar_root"
  cd "$ar_root" || { fail "cannot cd to $ar_root"; fail_oneshot; return $?; }

  git init -q -b main
  git config user.email ar@shaka
  git config user.name ar

  # Optimization target — an obvious sleep the agent can remove or shorten.
  cat > slow.sh <<'EOF'
#!/bin/sh
sleep 0.3
EOF
  chmod +x slow.sh

  git add -A
  git -c commit.gpgSign=false commit -q -m "target"

  echo "  Running: shaka autoresearch start 'Measure slow.sh runtime in ms' --oneshot --provider $provider --max-iterations 1"
  # --oneshot bypasses the non-TTY guard and invokes the setup agent via
  # runAgentStep (no TUI handoff). The agent authors autoresearch.md + .sh
  # from the objective; validateSetup gates commit; loop runs 1 iteration.
  #
  # Capture the exit status so real failures don't get masked by `|| true`.
  local ar_status=0
  shaka autoresearch start "Measure slow.sh runtime in ms" \
    --oneshot --provider "$provider" --max-iterations 1 >/tmp/ar-oneshot.log 2>&1 || ar_status=$?
  if [ "$ar_status" -ne 0 ]; then
    fail "autoresearch --oneshot failed (exit $ar_status)"
    tail -40 /tmp/ar-oneshot.log
    fail_oneshot
    return $?
  fi

  if [ -d "$ar_wt" ]; then
    pass "experiment worktree created at $ar_wt"
  else
    fail "experiment worktree missing"
    tail -40 /tmp/ar-oneshot.log
    fail_oneshot
    return $?
  fi

  # Setup artifacts — the agent authored these. We assert they exist and
  # are non-empty; content quality is enforced by validateSetup (which
  # already ran; if it had failed, shaka would have exited non-zero above).
  if [ -s "$ar_wt/autoresearch.md" ]; then
    pass "autoresearch.md authored by agent"
  else
    fail "autoresearch.md missing or empty"
    fail_oneshot
    return $?
  fi

  if [ -x "$ar_wt/autoresearch.sh" ]; then
    pass "autoresearch.sh authored and executable"
  else
    fail "autoresearch.sh missing or not executable"
    fail_oneshot
    return $?
  fi

  # Setup should have been committed by commitFinalizeIfDirty with the
  # agent-generated message. Presence of that subject is the provenance
  # check — distinguishes agent-authored setups from wizard-finalized ones.
  local setup_commit_subject
  setup_commit_subject=$(git -C "$ar_wt" log --format=%s --all \
    --grep="autoresearch: finalize agent-generated setup" -1 2>/dev/null || true)
  if [ -n "$setup_commit_subject" ]; then
    pass "agent-generated setup committed"
  else
    fail "no commit with 'autoresearch: finalize agent-generated setup' subject in worktree"
    git -C "$ar_wt" log --oneline -5
    fail_oneshot
    return $?
  fi

  # Loop ran — jsonl has at least one entry, attributed to the forced provider.
  local ar_jsonl="$ar_wt/autoresearch.jsonl"
  if [ ! -f "$ar_jsonl" ]; then
    fail "autoresearch.jsonl not created (loop never ran?)"
    tail -40 /tmp/ar-oneshot.log
    fail_oneshot
    return $?
  fi

  local entries
  entries=$(wc -l < "$ar_jsonl" | tr -d ' ')
  if [ "$entries" -ge 1 ]; then
    pass "at least one loop iteration recorded ($entries)"
  else
    fail "expected ≥1 jsonl entry, got $entries"
    cat "$ar_jsonl"
    fail_oneshot
    return $?
  fi

  local first_entry attributed_provider
  first_entry=$(sed -n '1p' "$ar_jsonl")
  attributed_provider=$(echo "$first_entry" | jq -r '.provider' 2>/dev/null)
  if [ "$attributed_provider" = "$provider" ]; then
    pass "loop iteration attributed to $provider"
  else
    # Hard fail: --provider forced the backend. A mismatch is a routing bug.
    fail "iteration 1 provider is $attributed_provider (expected '$provider')"
    fail_oneshot
    return $?
  fi

  # Cleanup
  cleanup_oneshot
}
