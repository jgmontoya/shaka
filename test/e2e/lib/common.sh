#!/usr/bin/env bash
# Shared status-line helpers for e2e scripts.
#
# Sourced from test/e2e/{claudecode,opencode,codex,pi}.sh at the top of each
# script, right after the Docker guard. Kept deliberately small — every
# e2e section below is structured as a narrative of provider-specific
# assertions, and those assertions are better left inline. Only the
# stateless formatting helpers live here.

# shellcheck shell=bash

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; }
warn() { echo "  ⚠️  $1"; }
skip() { echo "  ⏭️  $1"; }
section() { echo; echo "── $1 ──"; }
