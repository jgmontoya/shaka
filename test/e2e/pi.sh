#!/usr/bin/env bash
# E2E test: verifies shaka init installs the extension, prefixed skill
# symlinks, agent skills, and uninstall preserves user files for Pi.
# Must run inside Docker: docker compose run --rm pi bash test/e2e/pi.sh
set -eu

if [ ! -f /.dockerenv ]; then
  echo "ERROR: This test must run inside Docker."
  echo "  docker compose run --rm pi bash test/e2e/pi.sh"
  exit 1
fi

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

echo "E2E: pi hooks"

# ── Setup ─────────────────────────────────────────────────────────────

section "Setup"
bun link

# Verify Pi CLI is installed (the dockerfile-pi image bun-installs it globally
# at build time; if it's missing the image is broken, not the script).
if command -v pi >/dev/null 2>&1; then
  pass "Pi CLI installed: $(pi --version 2>&1 || echo unknown)"
else
  fail "Pi CLI not found in container — check dockerfile-pi"
  exit 1
fi

# Scope shaka + Pi state to the container's home so tests don't fight any
# fixtures the dockerfile pre-populated. Each `mkdir -p` is safe whether the
# directory exists or not.
SHAKA_HOME="${HOME}/.config/shaka-test"
PI_CODING_AGENT_DIR="${HOME}/.pi-test/agent"
export SHAKA_HOME PI_CODING_AGENT_DIR
mkdir -p "$SHAKA_HOME" "$PI_CODING_AGENT_DIR"

# ── Wrong provider flag ──────────────────────────────────────────────

section "Wrong provider flag"

# Claude is not installed in the pi container; init --claude must refuse,
# matching the codex container's wrong-flag check.
WRONG_OUTPUT=$(shaka init --claude 2>&1) && {
  fail "shaka init --claude should have failed (Claude not in this container)"
  exit 1
} || true

if echo "$WRONG_OUTPUT" | grep -qi "not installed"; then
  pass "shaka init --claude shows 'not installed' warning"
else
  fail "Missing 'not installed' warning for --claude"
  echo "$WRONG_OUTPUT"
  exit 1
fi

# ── shaka init --pi ───────────────────────────────────────────────────

section "shaka init --pi"

INIT_OUTPUT=$(shaka init --pi --defaults --force 2>&1) || {
  fail "shaka init --pi exited non-zero"
  echo "$INIT_OUTPUT"
  exit 1
}
pass "shaka init --pi succeeded"

# ── Generated extension ──────────────────────────────────────────────

section "Generated extension"

EXTENSION_PATH="$PI_CODING_AGENT_DIR/extensions/shaka.ts"
if [ ! -f "$EXTENSION_PATH" ]; then
  fail "missing $EXTENSION_PATH"
  exit 1
fi
if ! grep -q SHAKA_GENERATED_EXTENSION "$EXTENSION_PATH"; then
  fail "extension at $EXTENSION_PATH is missing the SHAKA_GENERATED_EXTENSION marker"
  exit 1
fi
pass "extension carries SHAKA_GENERATED_EXTENSION marker"

# Smoke-load gate has already run inside `shaka init --pi`. If Pi rejected the
# extension, install would have aborted and removed the file — so the marker
# check above implicitly verifies the gate passed against real Pi.
pass "smoke-load gate accepted the generated extension (real Pi)"

# ── Skills + agents ──────────────────────────────────────────────────

section "Prefixed skills + agents"

SKILL_COUNT=$(find "$PI_CODING_AGENT_DIR/skills" -maxdepth 1 -name 'shaka-*' ! -name 'shaka-agent-*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$SKILL_COUNT" -lt 1 ]; then
  fail "no shaka-* skills installed under $PI_CODING_AGENT_DIR/skills"
  exit 1
fi
pass "$SKILL_COUNT shaka-* entries installed"

AGENT_COUNT=$(find "$PI_CODING_AGENT_DIR/skills" -maxdepth 1 -name 'shaka-agent-*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$AGENT_COUNT" -lt 1 ]; then
  fail "no shaka-agent-* skills installed under $PI_CODING_AGENT_DIR/skills"
  exit 1
fi
pass "$AGENT_COUNT shaka-agent-* skills installed"

# ── shaka doctor ──────────────────────────────────────────────────────

section "shaka doctor"

DOCTOR_OUTPUT=$(shaka doctor 2>&1 || true)
if ! echo "$DOCTOR_OUTPUT" | grep -q "pi:"; then
  fail "shaka doctor output missing \`pi:\` section"
  echo "$DOCTOR_OUTPUT"
  exit 1
fi
pass "shaka doctor reports Pi"

# Credential check follows the same contract as `checkPiCredentials` in
# src/providers/pi/credentials.ts: a Pi credential is "auth.json present
# OR ANTHROPIC_API_KEY set OR ANTHROPIC_OAUTH_TOKEN set". A run that
# injects an env var would otherwise fail here even though doctor is right.
AUTH_JSON="${PI_CODING_AGENT_DIR}/auth.json"
HAS_AUTH=false
if { [ -f "$AUTH_JSON" ] && [ -s "$AUTH_JSON" ]; } || \
   [ -n "${ANTHROPIC_API_KEY:-}" ] || \
   [ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]; then
  HAS_AUTH=true
fi

if [ "$HAS_AUTH" = "true" ]; then
  if echo "$DOCTOR_OUTPUT" | grep -qi "no credentials found"; then
    fail "doctor reported missing credentials even though Pi creds are present (auth.json or env var)"
    exit 1
  fi
  pass "doctor suppresses warning when Pi creds are present"
else
  if echo "$DOCTOR_OUTPUT" | grep -qi "no credentials found"; then
    pass "doctor surfaces the no-credentials warning when Pi isn't authenticated"
  else
    fail "doctor did not surface the expected no-credentials warning"
    exit 1
  fi
fi

# ── Workflow until ────────────────────────────────────────────────────
# Deterministic check only: this script scopes Pi state to an auth-less
# test dir (PI_CODING_AGENT_DIR), so the LLM judge variant would always
# warn without testing anything.

# shellcheck source=lib/workflow-until.sh
source "$(dirname "$0")/lib/workflow-until.sh"
run_workflow_until_e2e

# ── Uninstall preserves user files ────────────────────────────────────

section "Uninstall preserves user files"

USER_SKILL="$PI_CODING_AGENT_DIR/skills/my-personal-skill"
mkdir -p "$USER_SKILL"
echo "# personal" > "$USER_SKILL/SKILL.md"

USER_EXTENSION="$PI_CODING_AGENT_DIR/extensions/my-personal-extension.ts"
echo "// mine" > "$USER_EXTENSION"

UNINSTALL_OUTPUT=$(shaka uninstall --keep-data 2>&1) || {
  fail "shaka uninstall exited non-zero"
  echo "$UNINSTALL_OUTPUT"
  exit 1
}

if [ ! -f "$USER_SKILL/SKILL.md" ]; then
  fail "uninstall removed user skill at $USER_SKILL/SKILL.md"
  exit 1
fi
if [ ! -f "$USER_EXTENSION" ]; then
  fail "uninstall removed user extension at $USER_EXTENSION"
  exit 1
fi
if [ -f "$EXTENSION_PATH" ]; then
  fail "uninstall left Shaka extension at $EXTENSION_PATH"
  exit 1
fi
REMAINING=$(find "$PI_CODING_AGENT_DIR/skills" -maxdepth 1 -name 'shaka-*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$REMAINING" -ne 0 ]; then
  fail "uninstall left $REMAINING shaka-* skills behind"
  exit 1
fi
pass "uninstall removed Shaka artifacts and preserved user files"

echo
echo "── all checks passed ──"
