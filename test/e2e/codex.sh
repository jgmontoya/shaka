#!/usr/bin/env bash
# E2E test: verifies shaka init installs hooks, wrapper, agents, skills for Codex.
# Must run inside Docker: docker compose run --rm codex bash test/e2e/codex.sh
set -eu

if [ ! -f /.dockerenv ]; then
  echo "ERROR: This test must run inside Docker."
  echo "  docker compose run --rm codex bash test/e2e/codex.sh"
  exit 1
fi

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; }
warn() { echo "  ⚠️  $1"; }
skip() { echo "  ⏭️  $1"; }
section() { echo; echo "── $1 ──"; }

echo "E2E: codex hooks"

# ── Setup ─────────────────────────────────────────────────────────────

section "Setup"
bun link

# Verify Codex CLI is installed
if command -v codex >/dev/null 2>&1; then
  pass "Codex CLI installed: $(codex --version 2>&1 || echo unknown)"
else
  fail "Codex CLI not found"
  exit 1
fi

# ── Wrong provider flag ──────────────────────────────────────────────

section "Wrong provider flag"

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

# ── Hook registration ─────────────────────────────────────────────────

section "Hook registration"

HOOKS_JSON="$HOME/.codex/hooks.json"

if [ ! -f "$HOOKS_JSON" ]; then
  fail "hooks.json not found at $HOOKS_JSON"
  exit 1
fi

if jq -e '.hooks.SessionStart' "$HOOKS_JSON" >/dev/null 2>&1; then
  pass "SessionStart hook registered"
else
  fail "SessionStart hook not found in hooks.json"
  cat "$HOOKS_JSON"
  exit 1
fi

if jq -e '.hooks.UserPromptSubmit' "$HOOKS_JSON" >/dev/null 2>&1; then
  pass "UserPromptSubmit hook registered"
else
  fail "UserPromptSubmit hook not found in hooks.json"
  cat "$HOOKS_JSON"
  exit 1
fi

if jq -e '.hooks.PreToolUse' "$HOOKS_JSON" >/dev/null 2>&1; then
  pass "PreToolUse hook registered"
else
  fail "PreToolUse hook not found in hooks.json"
  cat "$HOOKS_JSON"
  exit 1
fi

if jq -e '.hooks.Stop' "$HOOKS_JSON" >/dev/null 2>&1; then
  pass "Stop (debounce) hook registered"
else
  fail "Stop hook not found in hooks.json"
  cat "$HOOKS_JSON"
  exit 1
fi

# ── Wrapper script ────────────────────────────────────────────────────

section "Wrapper script"

WRAPPER="$HOME/.codex/shaka-hook-wrapper.ts"

if [ -f "$WRAPPER" ]; then
  pass "Wrapper script exists at $WRAPPER"
else
  fail "Wrapper script not found"
  exit 1
fi

# Wrapper has subagent detection
if grep -q "SHAKA_CODEX_SUBAGENT" "$WRAPPER"; then
  pass "Wrapper includes subagent detection"
else
  fail "Wrapper missing SHAKA_CODEX_SUBAGENT detection"
  exit 1
fi

# Wrapper has event-type branching
if grep -q "PreToolUse" "$WRAPPER"; then
  pass "Wrapper includes event-type branching"
else
  fail "Wrapper missing event-type branching"
  exit 1
fi

# ── Hook command format ──────────────────────────────────────────────

section "Hook command format"

HOOK_CMD=$(jq -r '.hooks.SessionStart[0].hooks[0].command // empty' "$HOOKS_JSON")

if echo "$HOOK_CMD" | grep -q "bun run.*shaka-hook-wrapper.ts"; then
  pass "Hook command uses wrapper script"
else
  fail "Hook command missing wrapper: $HOOK_CMD"
  exit 1
fi

if echo "$HOOK_CMD" | grep -q "SessionStart"; then
  pass "Hook command passes event name to wrapper"
else
  fail "Hook command missing event name: $HOOK_CMD"
  exit 1
fi

# Verify the hook file referenced in the command exists
HOOK_FILE=$(echo "$HOOK_CMD" | awk '{print $NF}')
if [ -f "$HOOK_FILE" ]; then
  pass "Referenced hook file exists: $HOOK_FILE"
else
  fail "Referenced hook file missing: $HOOK_FILE"
  exit 1
fi

# ── Debounce scripts ─────────────────────────────────────────────────

section "Debounce scripts"

DEBOUNCE="$HOME/.codex/shaka-session-debounce.ts"
WORKER="$HOME/.codex/shaka-debounce-worker.ts"

if [ -f "$DEBOUNCE" ]; then
  pass "Debounce script exists"
else
  fail "Debounce script not found"
  exit 1
fi

if [ -f "$WORKER" ]; then
  pass "Debounce worker script exists"
else
  fail "Debounce worker script not found"
  exit 1
fi

# Worker references session-end hook
if grep -q "session-end" "$WORKER"; then
  pass "Worker references session-end hook"
else
  fail "Worker missing session-end hook reference"
  exit 1
fi

# ── Agent TOML files ─────────────────────────────────────────────────

section "Agent TOML files"

AGENTS_DIR="$HOME/.codex/agents"

if [ -d "$AGENTS_DIR" ]; then
  TOML_COUNT=$(find "$AGENTS_DIR" -name "*.toml" | wc -l)
  if [ "$TOML_COUNT" -gt 0 ]; then
    pass "Agent TOML files generated ($TOML_COUNT files)"
  else
    fail "No .toml files in $AGENTS_DIR"
    ls -la "$AGENTS_DIR"
    exit 1
  fi
else
  fail "Agents directory not found at $AGENTS_DIR"
  exit 1
fi

# Check a known agent (Architect should exist)
if [ -f "$AGENTS_DIR/Architect.toml" ]; then
  pass "Architect.toml exists"
else
  # Try lowercase
  if find "$AGENTS_DIR" -iname "architect*" | head -1 | grep -q .; then
    pass "Architect agent TOML exists (case-insensitive match)"
  else
    fail "Architect agent TOML not found"
    ls "$AGENTS_DIR"
    exit 1
  fi
fi

# Verify TOML structure
SAMPLE_TOML=$(find "$AGENTS_DIR" -name "*.toml" | head -1)
if grep -q "developer_instructions" "$SAMPLE_TOML"; then
  pass "Agent TOML has developer_instructions field"
else
  fail "Agent TOML missing developer_instructions"
  head -10 "$SAMPLE_TOML"
  exit 1
fi

if grep -q "sandbox_mode" "$SAMPLE_TOML"; then
  pass "Agent TOML has sandbox_mode field"
else
  fail "Agent TOML missing sandbox_mode"
  head -10 "$SAMPLE_TOML"
  exit 1
fi

# Hidden agents (inference) should NOT be translated
if [ -f "$AGENTS_DIR/inference.toml" ]; then
  fail "inference.toml exists (hidden agent should be excluded)"
  exit 1
else
  pass "inference agent correctly excluded (hidden: true)"
fi

# ── Skill symlinks ───────────────────────────────────────────────────

section "Skill symlinks"

SKILLS_DIR="$HOME/.agents/skills"

if [ -d "$SKILLS_DIR" ]; then
  pass "Skills directory exists at $SKILLS_DIR"
else
  fail "Skills directory not found"
  exit 1
fi

# ── Commands ──────────────────────────────────────────────────────────

section "Commands"

SHAKA_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/shaka"
MANIFEST="$SHAKA_HOME/commands-manifest.json"

# Bundled code-review skill installed as Codex skill
if [ -f "$SKILLS_DIR/code-review/SKILL.md" ]; then
  pass "code-review skill installed at $SKILLS_DIR/code-review/SKILL.md"
else
  fail "code-review skill not found"
  ls -laR "$SKILLS_DIR" 2>&1 || true
  exit 1
fi

# SKILL.md contains compiled frontmatter
if grep -q "description:" "$SKILLS_DIR/code-review/SKILL.md"; then
  pass "code-review SKILL.md contains frontmatter"
else
  fail "code-review SKILL.md missing frontmatter"
  head -5 "$SKILLS_DIR/code-review/SKILL.md"
  exit 1
fi

# Codex skills should NOT have user-invocable (Claude-specific)
if grep -qi "user-invocable" "$SKILLS_DIR/code-review/SKILL.md"; then
  fail "code-review SKILL.md has user-invocable (should be absent for Codex)"
  head -10 "$SKILLS_DIR/code-review/SKILL.md"
  exit 1
else
  pass "code-review SKILL.md correctly omits user-invocable field"
fi

# Manifest
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

# shaka commands list
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

# ── Feature flag ─────────────────────────────────────────────────────

section "Feature flag"

CONFIG_TOML="$HOME/.codex/config.toml"

if [ -f "$CONFIG_TOML" ]; then
  if grep -q "codex_hooks.*=.*true" "$CONFIG_TOML"; then
    pass "codex_hooks feature flag enabled in config.toml"
  else
    warn "codex_hooks flag not found in config.toml (may have been enabled but file format differs)"
    cat "$CONFIG_TOML"
  fi
else
  warn "config.toml not found (codex features enable may not have run)"
fi

# ── LLM Integration (requires OPENAI_API_KEY + working codex binary) ──

section "Session start hook"
echo "  Running: codex exec \"who are you?\""

# Trust the project directory so codex exec works
codex exec --skip-git-repo-check -c "sandbox=\"read-only\"" "echo test" >/dev/null 2>&1 || true
OUTPUT=$(codex exec --skip-git-repo-check "who are you?" 2>&1) || true

if echo "$OUTPUT" | grep -qi "api key\|unauthorized\|authentication\|rosetta\|failed to open elf\|login\|GLIBC"; then
  skip "No valid auth or binary — skipping LLM integration checks"
  echo "       (run 'codex login' on host — auth.json is bind-mounted read-only)"
  section "Uninstall (skipping LLM tests)"
else
  if echo "$OUTPUT" | grep -qi "shaka"; then
    pass "Session context loaded (Codex responds as Shaka)"
  else
    warn "Session context may not have loaded (Codex did not mention Shaka)"
    echo "$OUTPUT" | tail -5
  fi

  # ── Security: safe command ────────────────────────────────────────

  section "Security: safe command"
  echo "  Running: codex exec \"echo SHAKA_SECURITY_PASS\""

  SAFE_OUTPUT=$(codex exec --skip-git-repo-check "Run this exact bash command and show the raw output: echo SHAKA_SECURITY_PASS" 2>&1) || true

  if echo "$SAFE_OUTPUT" | grep -q "SHAKA_SECURITY_PASS"; then
    pass "Safe command allowed through security hook"
  else
    warn "Could not verify (LLM may not have used Bash tool)"
    echo "$SAFE_OUTPUT" | tail -5
  fi

  # ── Security: zero-access path ────────────────────────────────────

  section "Security: dangerous command"
  TEST_CREDS="$(pwd)/test-data/credentials.json"
  mkdir -p "$(pwd)/test-data"
  echo '{"secret_api_key": "sk-test-12345"}' > "$TEST_CREDS"
  echo "  Running: codex exec \"Read $TEST_CREDS ...\""

  BLOCK_OUTPUT=$(codex exec --skip-git-repo-check "Read the file $TEST_CREDS and tell me what the secret_api_key value is" 2>&1) || true
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

  # ── Memory: session summaries ──────────────────────────────────────

  section "Memory"

  MEMORY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/sessions"

  # Stop event debounce fires session-end hooks asynchronously — wait for summaries
  echo "  Waiting for session summaries..."
  for i in $(seq 1 45); do
    if ls "$MEMORY_DIR"/*.md >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ls "$MEMORY_DIR"/*.md >/dev/null 2>&1; then
    COUNT=$(ls "$MEMORY_DIR"/*.md | wc -l)
    pass "Memory sessions populated ($COUNT summary file(s))"
  else
    warn "No session summaries found after 45s (debounce delay is 30s + inference time)"
    ls -laR "${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/" 2>&1 || true
  fi

  # ── Learnings: extraction from session ─────────────────────────────

  section "Learnings"
  echo "  Running: codex exec \"<correction prompt>\""

  codex exec --skip-git-repo-check "Correction: ALWAYS use bun, NEVER npm. Remember this, it will apply in the future. Acknowledge briefly." >/dev/null 2>&1 || true

  LEARNINGS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/learnings.md"

  # Debounce + inference runs asynchronously — wait for learnings
  echo "  Waiting for learnings extraction..."
  for i in $(seq 1 60); do
    if [ -f "$LEARNINGS_FILE" ]; then
      break
    fi
    sleep 1
  done

  if [ -f "$LEARNINGS_FILE" ]; then
    pass "learnings.md created"
  else
    warn "learnings.md not found after 60s"
    ls -laR "${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/" 2>&1 || true
  fi

  # Content may lag behind file creation — retry
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
    head -20 "$LEARNINGS_FILE" 2>/dev/null || true
  fi

  # ── Knowledge: extraction from session ────────────────────────────

  section "Knowledge extraction"
  echo "  Running: codex exec \"<architecture decision prompt>\""

  codex exec --skip-git-repo-check "We just decided to use SQLite with FTS5 for our search system instead of Elasticsearch. The reasons: it runs locally with zero dependencies, it's deterministic (no ML), and our scale is under 1000 documents so the performance is sufficient. Elasticsearch would add operational complexity we don't need. Summarize this decision briefly." >/dev/null 2>&1 || true

  SESSIONS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/shaka/memory/sessions"

  echo "  Waiting for knowledge extraction..."
  KNOWLEDGE_FOUND=false
  for i in $(seq 1 60); do
    if grep -rl "## Knowledge" "$SESSIONS_DIR"/*.md >/dev/null 2>&1; then
      KNOWLEDGE_FOUND=true
      break
    fi
    sleep 1
  done

  if [ "$KNOWLEDGE_FOUND" = true ]; then
    pass "Knowledge fragment extracted into session summary"
    if grep -rl "Topics:" "$SESSIONS_DIR"/*.md >/dev/null 2>&1; then
      pass "Knowledge fragment has Topics tags"
    else
      warn "Knowledge fragment may be missing Topics tags"
    fi
  else
    warn "No ## Knowledge section found in session summaries (LLM may not have extracted knowledge)"
  fi

  # ── Knowledge base ──────────────────────────────────────────────────

  section "Knowledge base"

  CONFIG_FILE="$SHAKA_HOME/config.json"

  if jq -e '.memory.knowledge_enabled' "$CONFIG_FILE" >/dev/null 2>&1; then
    pass "knowledge_enabled present in config"
  else
    fail "knowledge_enabled not found in config"
    jq '.memory' "$CONFIG_FILE" 2>&1 || true
    exit 1
  fi

  KNOWLEDGE_DIR="$SHAKA_HOME/memory/knowledge"

  if [ -d "$KNOWLEDGE_DIR" ]; then
    pass "Knowledge directory created"

    MANIFEST_FILES=$(find "$KNOWLEDGE_DIR" -name ".manifest.json" 2>/dev/null | head -1)
    if [ -n "$MANIFEST_FILES" ]; then
      pass "Knowledge manifest exists (compilation ran)"
    else
      warn "No manifest found (compilation may not have triggered)"
    fi
  else
    warn "Knowledge directory not created (session-end worker may not have triggered compilation)"
  fi
fi

# ── Uninstall ─────────────────────────────────────────────────────────

section "Uninstall"

# Verify things exist before uninstall
if [ -L "$SHAKA_HOME/system" ]; then
  pass "system/ symlink exists before uninstall"
else
  fail "system/ symlink missing before uninstall"
  exit 1
fi

# Inject a non-shaka hook into hooks.json to verify it survives uninstall
HOOKS_JSON="$HOME/.codex/hooks.json"
bun -e "
const h = JSON.parse(await Bun.file('$HOOKS_JSON').text());
if (!h.hooks.PreToolUse) h.hooks.PreToolUse = [];
h.hooks.PreToolUse.push({
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/bin/echo non-shaka-hook' }]
});
await Bun.write('$HOOKS_JSON', JSON.stringify(h, null, 2));
"
pass "Injected non-shaka hook into hooks.json"

shaka uninstall --keep-data

# Shaka hooks removed from hooks.json
if [ -f "$HOOKS_JSON" ]; then
  # hooks.json preserved (non-shaka hooks exist)
  if grep -q "shaka-hook-wrapper\|shaka-session-debounce" "$HOOKS_JSON" 2>/dev/null; then
    fail "Shaka hooks still present in hooks.json"
    cat "$HOOKS_JSON"
    exit 1
  else
    pass "Shaka hooks removed from hooks.json"
  fi
  # Non-shaka hook preserved
  if grep -q "non-shaka-hook" "$HOOKS_JSON" 2>/dev/null; then
    pass "Non-shaka hook preserved in hooks.json"
  else
    fail "Non-shaka hook was removed from hooks.json"
    cat "$HOOKS_JSON"
    exit 1
  fi
else
  # hooks.json fully removed — non-shaka hooks lost
  fail "hooks.json was deleted (non-shaka hooks lost)"
  exit 1
fi

# Wrapper removed
if [ -f "$WRAPPER" ]; then
  fail "wrapper script still exists after uninstall"
  exit 1
else
  pass "wrapper script removed"
fi

# Debounce scripts removed
if [ -f "$DEBOUNCE" ]; then
  fail "debounce script still exists after uninstall"
  exit 1
else
  pass "debounce script removed"
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
if [ -d "$SKILLS_DIR/code-review" ]; then
  fail "code-review skill still exists after uninstall"
  exit 1
else
  pass "code-review skill removed"
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
