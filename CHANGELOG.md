# Changelog

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
