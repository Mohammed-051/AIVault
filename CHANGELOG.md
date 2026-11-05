# Changelog

## 1.2.0 — Skill Lock

- **Lockfile.** `vault.lock` pins every source to the commit you approved, every skill file to a SHA-256 hash, and every skill to its permissions. Existing vaults are pinned on first run. `vault sync` checks out the locked commits on a new machine.
- **Permission labels.** Permissions are inferred from each skill's instructions and bundled scripts across 11 kinds: commands, bundled scripts, package installs, network hosts, secrets, deletes, publishing, writes outside the project, agent-config changes, admin rights and scheduling.
  - Shown as `{net,secrets}` tags in indexes and in `vault_route`.
  - Shown as a card at the top of every `SKILL.md` that `vault_read` serves.
  - Listed by `vault add --dry-run`, `vault add` and `vault permissions`.
- **Update review.** `vault update` stages and scans each new version and diffs it against the lock.
  - Updates with no new permissions apply on their own.
  - Updates that add permissions or worsen the scan verdict are held, and the agent keeps the approved version.
  - New commands: `vault review` (permission and line diffs), `vault approve`, `vault reject` (skips that commit) and `vault verify`.
  - `lock.hold` sets the policy: `permissions`, `code` or `any`.
- **Tamper refusal.** `vault_read` refuses files that changed or appeared since approval. `vault doctor` reports drift.
- **MCP.** New read-only `vault_review` and `vault_permissions` tools. There is deliberately no approve tool.
- **Scanner.** `EXFIL-ENV-DUMP` now also catches `$(env | …)`. Blocked updates show their top findings inline.
- **Other.** A single version number (`package.json`), Windows short-path-safe reads, `file://` sources, an animated README demo, and 39 tests.

## 1.1.0

- **Security gate.** Every `vault add` is cloned to quarantine and scanned (36 context-aware rules for malware, backdoors, exfiltration, prompt injection, obfuscation and leaked keys).
  - Critical findings block the add. High findings flag skills with ⚠ in every index.
  - `vault update` re-scans and rolls back updates that turn malicious.
  - NVIDIA SkillSpector or Cisco skill-scanner run automatically when installed.
  - New command: `vault scan`.
- **One MCP server.** New `vault_read` (sandboxed), `vault_memory` and `vault_scan` tools, so the separate filesystem server is no longer needed. `vault_add` can't override a block.
- **One-step setup.** `setup.cmd` / `setup.sh` / `vault setup`:
  - detects Claude Desktop (including the Microsoft Store version), Claude Code, Cursor, Windsurf and VS Code;
  - patches each config with a backup;
  - closes and reopens Claude Desktop;
  - adds `vault` to PATH and copies the agent instructions to the clipboard.
- New layout: all code in `engine/`, with a single `vault` / `vault.cmd` launcher at the root.
- Test suite (`node tests/run.mjs`) and CI on Windows, macOS and Linux.

## 1.0.0

- Paste-a-link install with auto-filing by kind (skills, mcp, plugins, tools, catalogs).
- 19-domain classifier, dedupe, skill families, and a token-budgeted `dashboard.md` with per-domain indexes.
- BM25 `vault route` / `vault search`, pinned routes, base-skill profiles.
- Project memory, starter packs, `vault export`, `vault link`, `vault migrate`.
