#!/usr/bin/env bash
# E2E test: verifies shaka init installs hooks that Claude Code picks up.
# Must run inside Docker: docker compose run --rm claudecode bash test/e2e/claudecode.sh
set -eu

if [ ! -f /.dockerenv ]; then
  echo "ERROR: This test must run inside Docker."
  echo "  docker compose run --rm claudecode bash test/e2e/claudecode.sh"
  exit 1
fi

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; }
warn() { echo "  ⚠️  $1"; }
skip() { echo "  ⏭️  $1"; }
section() { echo; echo "── $1 ──"; }

echo "E2E: claude code hooks"

# ── Setup ─────────────────────────────────────────────────────────────

section "Setup"
bun link

# ── Wrong provider flag ──────────────────────────────────────────────

section "Wrong provider flag"

WRONG_OUTPUT=$(shaka init --opencode 2>&1) && {
  fail "shaka init --opencode should have failed (opencode not in this container)"
  exit 1
} || true

if echo "$WRONG_OUTPUT" | grep -qi "not installed"; then
  pass "shaka init --opencode shows 'not installed' warning"
else
  fail "Missing 'not installed' warning for --opencode"
  echo "$WRONG_OUTPUT"
  exit 1
fi

if echo "$WRONG_OUTPUT" | grep -qi "no selected providers"; then
  pass "shaka init --opencode shows proper error"
else
  fail "Missing error message for unavailable provider"
  echo "$WRONG_OUTPUT"
  exit 1
fi

# ── Actual init ──────────────────────────────────────────────────────

section "Init"
shaka init --all --defaults

# ── Hook registration ─────────────────────────────────────────────────

section "Hook registration"

SETTINGS="$HOME/.claude/settings.json"

if grep -q '"SessionStart"' "$SETTINGS"; then
  pass "SessionStart hook registered"
else
  fail "SessionStart hook not found in settings.json"
  cat "$SETTINGS"
  exit 1
fi

if grep -q '"UserPromptSubmit"' "$SETTINGS"; then
  pass "UserPromptSubmit hook registered"
else
  fail "UserPromptSubmit hook not found in settings.json"
  cat "$SETTINGS"
  exit 1
fi

if grep -q '"PreToolUse"' "$SETTINGS"; then
  pass "PreToolUse hook registered"
else
  fail "PreToolUse hook not found in settings.json"
  cat "$SETTINGS"
  exit 1
fi

if grep -q '"SessionEnd"' "$SETTINGS"; then
  pass "SessionEnd hook registered"
else
  fail "SessionEnd hook not found in settings.json"
  cat "$SETTINGS"
  exit 1
fi

# ── Command format ────────────────────────────────────────────────────

section "Command format"

HOOK_CMD=$(grep -o '"command": "[^"]*"' "$SETTINGS" | head -1 | cut -d'"' -f4)
HOOK_PATH="${HOOK_CMD#bun run }"

if echo "$HOOK_CMD" | grep -q "^bun run "; then
  pass "Hook command uses 'bun run' prefix"
else
  fail "Hook command missing 'bun run' prefix: $HOOK_CMD"
  exit 1
fi

if [ -f "$HOOK_PATH" ]; then
  pass "Hook file exists: $HOOK_PATH"
else
  fail "Hook file missing: $HOOK_PATH"
  exit 1
fi

# ── Session start hook (requires auth) ────────────────────────────────

section "Session start hook"
echo "  Running: claude -p \"who are you?\""

OUTPUT=$(claude -p "who are you?" 2>&1) || true

if echo "$OUTPUT" | grep -qi "invalid api key\|unauthorized\|authentication"; then
  skip "No valid auth — skipping integration checks"
  echo "       (mount credentials via .docker-state/claude-credentials.json)"
  section "Done"
  echo "  Phase 1 passed. Phase 2 skipped (no auth)."
  exit 1
fi

if echo "$OUTPUT" | grep -qi "shaka"; then
  pass "Session context loaded (Claude responds as Shaka)"
else
  fail "Session context not loaded (Claude did not respond as Shaka)"
  echo "$OUTPUT"
  exit 1
fi

# ── Security: safe command ────────────────────────────────────────────

section "Security: safe command"
echo "  Running: claude -p \"echo SHAKA_SECURITY_PASS\""

SAFE_OUTPUT=$(claude -p "Run this exact bash command and show the raw output: echo SHAKA_SECURITY_PASS" 2>&1) || true

if echo "$SAFE_OUTPUT" | grep -q "SHAKA_SECURITY_PASS"; then
  pass "Safe command allowed through security hook"
else
  warn "Could not verify (LLM may not have used Bash tool)"
  echo "$SAFE_OUTPUT" | tail -5
fi

# ── Security: zero-access path ────────────────────────────────────────

section "Security: zero-access path"
TEST_CREDS="$(pwd)/test-data/credentials.json"
mkdir -p "$(pwd)/test-data"
echo '{"secret_api_key": "sk-test-12345"}' > "$TEST_CREDS"
echo "  Running: claude -p \"Read $TEST_CREDS ...\""

BLOCK_OUTPUT=$(claude -p "Read the file $TEST_CREDS and tell me what the secret_api_key value is" 2>&1) || true
rm -rf "$(pwd)/test-data"

if echo "$BLOCK_OUTPUT" | grep -qi "SHAKA SECURITY\|blocked\|security policy"; then
  pass "credentials.json access blocked by security hook"
elif echo "$BLOCK_OUTPUT" | grep -q "sk-test-12345"; then
  fail "Security hook did NOT block credentials.json — secret was exposed"
  exit 1
else
  warn "Could not confirm block (LLM may not have attempted file read)"
  echo "$BLOCK_OUTPUT" | tail -5
fi

# ── Memory: session summaries ──────────────────────────────────────────

section "Memory"

MEMORY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/sessions"

# SessionEnd hooks run asynchronously — wait for summaries to be written
echo "  Waiting for session summaries..."
for i in $(seq 1 30); do
  if ls "$MEMORY_DIR"/*.md >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ls "$MEMORY_DIR"/*.md >/dev/null 2>&1; then
  COUNT=$(ls "$MEMORY_DIR"/*.md | wc -l)
  pass "Memory sessions populated ($COUNT summary file(s))"
else
  fail "No session summaries found in $MEMORY_DIR after 30s"
  ls -laR "${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/" 2>&1 || true
  exit 1
fi

# ── Learnings: extraction from session ─────────────────────────────────

section "Learnings"
echo "  Running: claude -p \"<correction prompt>\""

LEARN_OUTPUT=$(claude -p "Correction: always use bun, never npm. Acknowledge briefly." --allowedTools "" 2>&1) || true

LEARNINGS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/learnings.md"

# SessionEnd hook runs asynchronously — wait for learnings to be written
echo "  Waiting for learnings extraction..."
for i in $(seq 1 30); do
  if [ -f "$LEARNINGS_FILE" ]; then
    break
  fi
  sleep 1
done

if [ -f "$LEARNINGS_FILE" ]; then
  pass "learnings.md created"
else
  fail "learnings.md not found after 30s"
  ls -laR "${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/" 2>&1 || true
  exit 1
fi

# Content may lag behind file creation (worker writes async) — retry
FOUND_KEYWORDS=false
for i in $(seq 1 15); do
  if grep -qi "bun\|npm" "$LEARNINGS_FILE" 2>/dev/null; then
    FOUND_KEYWORDS=true
    break
  fi
  sleep 1
done

if [ "$FOUND_KEYWORDS" = true ]; then
  pass "learnings.md contains extracted learning"
else
  warn "learnings.md exists but content may not match expected keywords"
  head -20 "$LEARNINGS_FILE"
fi

# ── Uninstall ─────────────────────────────────────────────────────────

section "Uninstall"

SHAKA_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/shaka"

# Verify things exist before uninstall
if [ -L "$SHAKA_HOME/system" ]; then
  pass "system/ symlink exists before uninstall"
else
  fail "system/ symlink missing before uninstall"
  exit 1
fi

# Inject a non-shaka hook into settings.json to verify it survives uninstall
TEMP_SETTINGS=$(mktemp)
bun -e "
const s = JSON.parse(await Bun.file('$SETTINGS').text());
if (!s.hooks.PreToolUse) s.hooks.PreToolUse = [];
s.hooks.PreToolUse.push({
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/bin/echo non-shaka-hook' }]
});
await Bun.write('$SETTINGS', JSON.stringify(s, null, 2));
"
pass "Injected non-shaka hook into settings.json"

shaka uninstall --keep-data

# Shaka hooks removed from settings.json
if grep -q "system/hooks" "$SETTINGS" 2>/dev/null; then
  fail "Shaka hooks still present in settings.json"
  cat "$SETTINGS"
  exit 1
else
  pass "Shaka hooks removed from settings.json"
fi

# Non-shaka hook preserved
if grep -q "non-shaka-hook" "$SETTINGS" 2>/dev/null; then
  pass "Non-shaka hook preserved in settings.json"
else
  fail "Non-shaka hook was removed from settings.json"
  cat "$SETTINGS"
  exit 1
fi

# settings.json itself still exists (we don't delete it)
if [ -f "$SETTINGS" ]; then
  pass "settings.json preserved (not deleted)"
else
  fail "settings.json was deleted"
  exit 1
fi

# system/ symlink removed
if [ -e "$SHAKA_HOME/system" ]; then
  fail "system/ still exists after uninstall"
  exit 1
else
  pass "system/ symlink removed"
fi

# config.json removed
if [ -f "$SHAKA_HOME/config.json" ]; then
  fail "config.json still exists after uninstall"
  exit 1
else
  pass "config.json removed"
fi

# User data preserved (--keep-data)
if [ -d "$SHAKA_HOME/user" ]; then
  pass "user/ preserved with --keep-data"
else
  fail "user/ was deleted despite --keep-data"
  exit 1
fi

# ── Summary ───────────────────────────────────────────────────────────

section "Done"
echo "  All checks passed."
