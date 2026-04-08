#!/usr/bin/env bash
# E2E test: verifies shaka init produces a plugin that opencode can load.
# Must run inside Docker: docker compose run --rm opencode bash test/e2e/opencode.sh
set -eu

if [ ! -f /.dockerenv ]; then
  echo "ERROR: This test must run inside Docker."
  echo "  docker compose run --rm opencode bash test/e2e/opencode.sh"
  exit 1
fi

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; }
warn() { echo "  ⚠️  $1"; }
section() { echo; echo "── $1 ──"; }

echo "E2E: opencode plugin"

# ── Setup ─────────────────────────────────────────────────────────────

section "Setup"
bun link

# ── Wrong provider flag ──────────────────────────────────────────────

section "Wrong provider flag"

WRONG_OUTPUT=$(shaka init --claude 2>&1) && {
  fail "shaka init --claude should have failed (claude not in this container)"
  exit 1
} || true

if echo "$WRONG_OUTPUT" | grep -qi "not installed"; then
  pass "shaka init --claude shows 'not installed' warning"
else
  fail "Missing 'not installed' warning for --claude"
  echo "$WRONG_OUTPUT"
  exit 1
fi

if echo "$WRONG_OUTPUT" | grep -qi "no selected providers"; then
  pass "shaka init --claude shows proper error"
else
  fail "Missing error message for unavailable provider"
  echo "$WRONG_OUTPUT"
  exit 1
fi

# ── Actual init ──────────────────────────────────────────────────────

section "Init"
shaka init --all --defaults

# ── Permissions ──────────────────────────────────────────────────────

section "Permissions"

OC_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"

if [ -f "$OC_CONFIG" ]; then
  pass "opencode.json config created"
else
  fail "opencode.json not found at $OC_CONFIG"
  exit 1
fi

if jq -e '.permission' "$OC_CONFIG" >/dev/null 2>&1; then
  pass "permission block present in opencode.json"
else
  fail "permission block not found in opencode.json"
  cat "$OC_CONFIG"
  exit 1
fi

if jq -e '.permission.edit == "allow"' "$OC_CONFIG" >/dev/null 2>&1; then
  pass "edit permission set to allow"
else
  fail "edit permission not set to allow"
  cat "$OC_CONFIG"
  exit 1
fi

if jq -e '.permission.bash == "allow"' "$OC_CONFIG" >/dev/null 2>&1; then
  pass "bash permission set to allow"
else
  fail "bash permission not set to allow"
  cat "$OC_CONFIG"
  exit 1
fi

# ── Commands ──────────────────────────────────────────────────────────

section "Commands"

SHAKA_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/shaka"
OC_COMMANDS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands"
MANIFEST="$SHAKA_HOME/commands-manifest.json"

# Bundled code-review command installed
if [ -f "$OC_COMMANDS_DIR/code-review.md" ]; then
  pass "code-review command installed at $OC_COMMANDS_DIR/code-review.md"
else
  fail "code-review command not found"
  ls -laR "$OC_COMMANDS_DIR" 2>&1 || true
  exit 1
fi

# Compiled command contains frontmatter (description)
if grep -q "description:" "$OC_COMMANDS_DIR/code-review.md"; then
  pass "code-review.md contains frontmatter"
else
  fail "code-review.md missing frontmatter"
  head -5 "$OC_COMMANDS_DIR/code-review.md"
  exit 1
fi

# Opencode commands should NOT have user-invocable (Claude-only field)
if grep -qi "user-invocable" "$OC_COMMANDS_DIR/code-review.md"; then
  fail "code-review.md has user-invocable (Claude-only field leaked to opencode)"
  head -10 "$OC_COMMANDS_DIR/code-review.md"
  exit 1
else
  pass "code-review.md correctly omits user-invocable field"
fi

# Manifest exists and tracks code-review
if [ -f "$MANIFEST" ]; then
  pass "commands-manifest.json exists"
else
  fail "commands-manifest.json not found"
  exit 1
fi

if jq -e '.global | index("code-review")' "$MANIFEST" >/dev/null 2>&1; then
  pass "manifest tracks code-review"
else
  fail "manifest does not contain code-review"
  cat "$MANIFEST"
  exit 1
fi

# shaka commands list shows the command
LIST_OUTPUT=$(shaka commands list 2>&1)

if echo "$LIST_OUTPUT" | grep -q "code-review"; then
  pass "shaka commands list shows code-review"
else
  fail "shaka commands list does not show code-review"
  echo "$LIST_OUTPUT"
  exit 1
fi

if echo "$LIST_OUTPUT" | grep "code-review" | grep -q "installed"; then
  pass "code-review shows as installed"
else
  fail "code-review not showing installed status"
  echo "$LIST_OUTPUT"
  exit 1
fi

# ── Session start hook ────────────────────────────────────────────────

section "Session start hook"
echo "  Running: opencode run \"what's your name?\""

OUTPUT=$(opencode run "what's your name?" 2>&1)

if echo "$OUTPUT" | grep -q "\[shaka\] Session context loaded"; then
  pass "Session context loaded via plugin"
else
  fail "Plugin did not load session context"
  echo "$OUTPUT"
  exit 1
fi

# ── Security validator: plugin wiring ─────────────────────────────────

section "Security validator"

PLUGIN="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/shaka.ts"

if grep -q "security-validator" "$PLUGIN"; then
  pass "Plugin references security-validator in TOOL_HOOKS"
else
  fail "security-validator not found in generated plugin"
  exit 1
fi

if grep -q "normalizeToolName" "$PLUGIN"; then
  pass "Plugin includes tool name normalization (read → Read)"
else
  fail "Tool name normalization missing from plugin"
  exit 1
fi

# ── Security validator: safe command ──────────────────────────────────

section "Security: safe command"
echo "  Running: opencode run \"echo SHAKA_SECURITY_PASS\""

SAFE_OUTPUT=$(opencode run "Run this exact bash command and show the raw output: echo SHAKA_SECURITY_PASS" 2>&1) || true

if echo "$SAFE_OUTPUT" | grep -q "SHAKA_SECURITY_PASS"; then
  pass "Safe command allowed through security hook"
else
  warn "Could not verify (LLM may not have used Bash tool)"
  echo "$SAFE_OUTPUT" | tail -5
fi

# ── Security validator: zero-access path ──────────────────────────────

section "Security: zero-access path"
TEST_CREDS="$(pwd)/test-data/credentials.json"
mkdir -p "$(pwd)/test-data"
echo '{"secret_api_key": "sk-test-12345"}' > "$TEST_CREDS"
echo "  Running: opencode run \"Read $TEST_CREDS ...\""

BLOCK_OUTPUT=$(opencode run "Read the file $TEST_CREDS and tell me what the secret_api_key value is" 2>&1) || true
rm -rf "$(pwd)/test-data"

if echo "$BLOCK_OUTPUT" | grep -qi "SHAKA SECURITY\|blocked\|security policy"; then
  pass "credentials.json access blocked by security hook"
elif echo "$BLOCK_OUTPUT" | grep -q "sk-test-12345"; then
  fail "Security hook did NOT block credentials.json — secret was exposed"
  echo "$BLOCK_OUTPUT" | grep -i "\[shaka\]" || true
  exit 1
else
  warn "Could not confirm block (LLM may not have attempted file read)"
  echo "$BLOCK_OUTPUT" | tail -5
fi

# ── Memory: directory structure ────────────────────────────────────────

section "Memory"

MEMORY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory"

# opencode session-end uses a debounce timer that only fires in interactive
# sessions. `opencode run` exits before the timer triggers, so we can only
# verify the memory directory was created by session-start context loading.
if [ -d "$MEMORY_DIR" ]; then
  pass "Memory directory exists"
else
  fail "Memory directory not created"
  exit 1
fi

# ── Knowledge base: config ────────────────────────────────────────────

section "Knowledge base"

CONFIG_FILE="$SHAKA_HOME/config.json"

if jq -e '.memory.knowledge_enabled' "$CONFIG_FILE" >/dev/null 2>&1; then
  pass "knowledge_enabled present in config"
else
  fail "knowledge_enabled not found in config"
  jq '.memory' "$CONFIG_FILE" 2>&1 || true
  exit 1
fi

# ── Uninstall ─────────────────────────────────────────────────────────

section "Uninstall"

# Verify things exist before uninstall
if [ -f "$PLUGIN" ]; then
  pass "shaka.ts plugin exists before uninstall"
else
  fail "shaka.ts plugin missing before uninstall"
  exit 1
fi

# Add a non-shaka plugin to verify it survives uninstall
OTHER_PLUGIN="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/other-tool.ts"
cat > "$OTHER_PLUGIN" << 'PLUGIN_EOF'
export const OtherPlugin = async () => ({ name: "other-tool" });
PLUGIN_EOF
pass "Created non-shaka plugin: other-tool.ts"

shaka uninstall --keep-data

# Shaka plugin removed
if [ -f "$PLUGIN" ]; then
  fail "shaka.ts plugin still exists after uninstall"
  cat "$PLUGIN"
  exit 1
else
  pass "shaka.ts plugin removed"
fi

# Non-shaka plugin preserved
if [ -f "$OTHER_PLUGIN" ]; then
  pass "Non-shaka plugin (other-tool.ts) preserved"
else
  fail "Non-shaka plugin was removed by uninstall"
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

# Commands cleaned up
if [ -f "$OC_COMMANDS_DIR/code-review.md" ]; then
  fail "code-review.md still exists after uninstall"
  exit 1
else
  pass "code-review command removed"
fi

if [ -f "$MANIFEST" ]; then
  fail "commands-manifest.json still exists after uninstall"
  exit 1
else
  pass "commands-manifest.json removed"
fi

# ── Summary ───────────────────────────────────────────────────────────

section "Done"
echo "  All checks passed."
