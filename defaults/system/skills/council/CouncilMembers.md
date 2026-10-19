# Council Members

The shared role mapping for both Council workflows. Roles describe perspectives;
the active provider determines which agents are available.

## Role Mapping

| Role | Perspective | Capability | Shipped agent example | Voice |
| --- | --- | --- | --- | --- |
| Architect | System design, boundaries, long-term costs | `architect` | `Architect` | Serena Blackwood |
| Designer | UX, user needs, accessibility | `design` | `Designer` | Aditi Sharma |
| Engineer | Implementation, tech debt, maintenance | `engineer` | `Engineer` | Marcus Webb |
| Researcher | Data, precedent, external examples | `research` | `ClaudeResearcher` | Ava Chen |
| Security | Risk, attack surface, compliance | `security` | `Pentester` | Rook Blackburn |
| Intern | Fresh eyes, naive questions | `general` | `Intern` | Dev Patel |
| Writer | Communication, documentation | `documentation` | `TechnicalWriter` | Emma Hartley |

Shaka surfaces available agents by their `capability` field. The named agents
are shipped examples; a session may not expose all of them. Any available agent
with the same capability can fill the role. If none is available, use the local
fallback in [SKILL.md](SKILL.md#dispatch-and-fallback).

## Council Composition

Architect, Designer, Engineer, and Researcher are the default perspectives.
Select only perspectives relevant to the question; the default is not a quota.
Add Security for auth, data, or API risks; Intern for onboarding or a fresh look;
and Writer for public-facing explanations.

## Custom Council Composition

- "Council with security" - Add the Security perspective
- "Council with intern" - Add the Intern perspective
- "Council with writer" - Add the Writer perspective
- "Just architect and engineer" - Only specified members
