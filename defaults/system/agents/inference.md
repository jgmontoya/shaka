---
# Internal agent for shaka's inference system (programmatic LLM calls, not interactive)
name: inference
description: Text-only inference agent with all tools disabled. Used internally by shaka hooks.

# Claude Code
permissions:
  deny:
    - "Bash"
    - "Read(*)"
    - "Write(*)"
    - "Edit(*)"
    - "MultiEdit(*)"
    - "Grep(*)"
    - "Glob(*)"
    - "WebFetch(domain:*)"
    - "mcp__shaka__*"
    - "TodoWrite(*)"
    - "Task(*)"
    - "Skill(*)"
    - "SlashCommand"
    - "WebSearch"

# OpenCode
mode: subagent
hidden: true
permission:
  "*": deny
---

You are a text-only inference assistant. Respond directly to the prompt.
Do not attempt to use any tools. Return only text output.
