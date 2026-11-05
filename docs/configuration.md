# Configuration — `vault.json`

`vault setup` or `vault init` creates the file. It's personal and git-ignored. After editing it, run `vault index`.

```jsonc
{
  "name": "My AIVault",
  "sources": [ /* managed by vault add/remove — edit only `only`, `hide`, `domain`, `priority` */ ],

  // Base skills loaded per task type. `domains` decides which tasks a profile covers.
  "profiles": {
    "code":     { "label": "Code", "domains": ["dev-core", "frontend", "backend", "systems", "embedded", "mobile", "data-ml", "devops-security"], "load": ["caveman", "ponytail"] },
    "creative": { "label": "Writing, content, media, design, documents", "domains": ["writing", "content-marketing", "media", "design", "documents"], "load": [] },
    "default":  { "label": "Everything else", "load": [] }
  },

  // Hand-picked routes checked before search. `when` = comma-separated trigger words.
  "pins": [
    { "when": "C++, OpenGL, rasterizer, shader", "load": ["cpp-pro"] },
    { "when": "code review, pull request",       "load": ["code-review"] }
  ],

  // Per-skill tweaks (id or id@source).
  "overrides": {
    "slack-gif-creator": { "domain": "media" },
    "template-skill":    { "hidden": true }
  },

  // Applied automatically when a repo is added (keyed by owner/repo, lowercase).
  "sourceDefaults": {
    "morluto/rea": { "only": ["reverse-engineer-anything"], "includeInternal": true }
  },

  "budget":   { "maxSkillsPerTask": 3, "descChars": 150 },
  "security": { "block": "critical", "external": "auto" },

  // Skill Lock: when an update waits for your review. "permissions" (default) | "code" | "any"
  "lock": { "hold": "permissions" },

  // Written by `vault prefer`: the winner for a job, and the look-alikes it replaces.
  "prefer": { "test-driven-development": ["tdd-workflow"] },

  // Written by `vault link <agent>`: agents installed into ~/.claude/agents (kept in sync with approved updates).
  "linked": {}
}
```

## Source options

| Field | Effect |
|---|---|
| `only` | Keep only these skill names from the source |
| `hide` | Hide these skill names |
| `domain` | Fallback domain for skills that don't classify |
| `priority` | Lower number wins name collisions (`local` = 0, official owners = 1, others = 2) |
| `includeInternal` | Keep skills from hidden folders (`.claude/`, `.agents/`) in MCP/tool repos |
| `ref`, `subdir` | Branch/tag and sparse folder (set automatically from `tree/` links) |

## Skill Lock

| `lock.hold` | Holds an update when |
|---|---|
| `"permissions"` | it adds a network host, secret, publish/delete, global write, agent-config, admin or scheduling permission to any skill, or the scan verdict gets worse |
| `"code"` | the above, or a bundled script changed |
| `"any"` | anything in a skill folder changed |

`vault.lock` is written by AIVault. Don't edit it by hand; use `vault approve` and `vault reject`. Keep it next to `vault.json` when you move to a new machine, and `vault sync` will reproduce the exact approved versions. See [skill-lock.md](skill-lock.md).

## Domains

The 19 domains and their keywords are in `engine/lib/domains.mjs`. You can add a domain, rename one, or tune its keywords, then run `vault index`. If your change would help everyone, open a PR.

## Environment

| Variable | Effect |
|---|---|
| `AIVAULT_HOME` | Use a different vault folder. This lets you keep the engine in one place and run several vaults. |
