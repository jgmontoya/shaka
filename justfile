# Shaka — task runner
# Install just: https://github.com/casey/just

# Default: list available recipes
default:
    @just --list

# ── Dev ───────────────────────────────────────────────────────────────

# Run all hard checks, then warning-only architecture tripwires
check:
    bun run check
    bun run architecture:check

# Run tests
test *args:
    bun test {{ args }}

# Run typechecker
typecheck:
    bun run typecheck

# Run linter
lint:
    bun run lint

# Run warning-only architecture tripwires
architecture-check:
    bun run architecture:check

# Hermetic unit/integration regression lane
test-hermetic:
    bun test

# Generated provider artifact load/build lane
test-generated-artifacts:
    bun test test/integration/providers test/unit/providers/codex/configurer.test.ts test/unit/providers/opencode/configurer.test.ts test/integration/providers/pi/extension-load.test.ts

# Fix lint issues
lint-fix:
    bun run lint:fix

# Format code
format:
    bun run format

# ── E2E (Docker) ──────────────────────────────────────────────────────

# Run Claude Code e2e tests in Docker
e2e-claude:
    docker compose run --rm --build claudecode bash test/e2e/claudecode.sh

# Run opencode e2e tests in Docker
e2e-opencode:
    docker compose run --rm --build opencode bash test/e2e/opencode.sh

# Run Codex e2e tests in Docker
e2e-codex:
    docker compose run --rm --build codex bash test/e2e/codex.sh

# Run Pi e2e tests in Docker
e2e-pi:
    docker compose run --rm --build pi bash test/e2e/pi.sh

# Run all e2e tests
e2e: e2e-claude e2e-opencode e2e-codex e2e-pi

# ── Docker shells ─────────────────────────────────────────────────────

# Open interactive shell in Claude Code container
shell-claude:
    docker compose run --rm --build claudecode sh

# Open interactive shell in opencode container
shell-opencode:
    docker compose run --rm --build opencode sh

# Open interactive shell in Codex container
shell-codex:
    docker compose run --rm --build codex sh

# Open interactive shell in Pi container
shell-pi:
    docker compose run --rm --build pi sh
