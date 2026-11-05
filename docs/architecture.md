# Architecture

AIVault is about 2,600 lines of dependency-free JavaScript, and needs Node 18+ and git. Everything lives in one folder:

```text
AIVault/
├─ dashboard.md          generated router (~1.5–2k tokens) — agents start here
├─ index/<domain>.md     generated one-line-per-skill lists, ~0.1–2.5k tokens each
├─ index/connectors.md   MCP server sources + run commands
├─ index/tools.md        CLIs / workflow systems (need their own install)
├─ index/catalogs.md     awesome-lists
├─ index/plugins.md      sources that also install as Claude Code plugins
├─ library/<kind>/<name> cloned sources: skills · mcp · plugins · tools · catalogs
├─ local/skills/         your own skills (highest priority)
├─ memory/<project>.md   per-project context, decisions, log
├─ packs/*.json          shareable source lists
├─ vault.json            your config (sources, profiles, pins, overrides, security, lock policy)
├─ vault.lock            Skill Lock: approved commit, file hashes and permissions of every skill
├─ .vault/               catalog cache, quarantine (tmp/), staged updates (staging/, pending.json), security reports
└─ engine/
   ├─ cli.mjs            `vault` command
   ├─ mcp.mjs            MCP server (stdio JSON-RPC, no SDK)
   ├─ lib/core.mjs       paths, config, git, source parsing
   ├─ lib/scan.mjs       repo inspection: SKILL.md discovery, kind detection, frontmatter
   ├─ lib/domains.mjs    19-domain taxonomy + keywords (edit to taste)
   ├─ lib/security.mjs   malware / backdoor / injection scanner
   ├─ lib/permissions.mjs permission inference (network, secrets, publish, …) per skill
   ├─ lib/lock.mjs       vault.lock: pin, compare, line diffs, integrity checks
   ├─ lib/build.mjs      catalog → dashboard + indexes (dedupe, families, budgets)
   ├─ lib/search.mjs     BM25 search + task router
   ├─ lib/commands.mjs   every operation (shared by CLI and MCP)
   └─ lib/setup.mjs      app detection, config patching, setup wizard
```

## Adding a source

1. **Parse.** `parseSource` accepts `owner/repo`, GitHub URLs (including `tree/<ref>/<dir>`, which becomes a sparse checkout), any git URL, or a local folder.
2. **Quarantine.** The repo is shallow-cloned into `.vault/tmp/`. Git never transfers hooks, and AIVault runs nothing from the repo.
3. **Inspect.** `scanRepo` walks the tree, skipping symlinks and `node_modules`/`dist`/`tests`/`deprecated`.
   - It finds `SKILL.md` files and parses their frontmatter.
   - It detects MCP servers (`@modelcontextprotocol/sdk`, `mcpName`, `server.json`, `fastmcp`), plugin manifests and awesome-lists.
   - It picks a **kind**. An MCP server with fewer than 10 public skills counts as a connector; its `.claude/` and `.agents/` skills are usually for the repo's own maintainers and are skipped unless you use `--only`.
4. **Security.** `scanSource` returns clean, caution, review or blocked; see [security.md](security.md). Blocked sources are deleted from quarantine.
5. **File.** The source moves to `library/<kind>/<name>` and is recorded in `vault.json` with its commit and security summary.
6. **Lock.** Every skill folder is hashed and its permissions are inferred. The result is pinned in `vault.lock` with the full commit.
7. **Index.** `reindex` rebuilds the catalog and renders the dashboard and indexes. Index lines carry permission tags such as `{net,secrets}`.

## Updating a source

`vault update` never changes `library/` directly:

1. `git ls-remote` checks for a new commit without downloading anything.
2. A new version is cloned into `.vault/staging/<name>` and security-scanned. A blocked version is discarded.
3. The staged version is compared with `vault.lock`, skill by skill: new permissions, changed files and the scan verdict.
4. A harmless update is swapped into `library/` and re-locked. An update that gains permissions, or scans worse, is recorded in `.vault/pending.json` and waits for `vault approve` or `vault reject`.

See [skill-lock.md](skill-lock.md).

## Keeping the index small

- **Classification.** Each skill is scored against domain keywords: name ×3, path ×1.5, description ×1. A skill lands in at most 2 domains.
- **Dedupe.** Identical content, or the same name, from a lower-priority source is hidden. Priority order is: `local/`, then official owners (anthropics, modelcontextprotocol, github, …), then everything else in the order added.
- **Families.** 15 or more skills from one source sharing a naming pattern (e.g. `*-automation`) collapse into one index line. Agents reach individual members through `vault_route` or `vault search`, which match only when the app is named in full.
- **Compact paths.** Index entries are grouped by source with a shared base path, so each line carries only the short remainder.

## Routing

`vault_route(task)` returns, in about 300 tokens:

1. **Project memory**, if the task names a project.
2. **Base skills** for the task type. Profiles map domains to base skills: for example, code gets caveman and ponytail, writing gets none.
3. **Pinned routes** whose keywords match the task (at most 2).
4. **Up to 5 BM25 matches.** These use light stemming and synonyms, need two matching words or a rare name hit, and penalize skill families.

## MCP server

`engine/mcp.mjs` implements the stdio transport directly: `initialize`, `tools/list`, `tools/call` and `ping`. One server covers everything, so there's no separate filesystem server to configure.

- **`vault_read`** resolves real paths and refuses anything outside the vault or inside `.git`. It checks each file from a locked source against its hash and refuses changed or unknown files. It prepends a provenance or warning banner and, for `SKILL.md`, the approved permissions.
- **`vault_add`** exposes no override for blocked repos, and there is no tool to approve a held update.

## Cross-platform notes

- **Windows.**
  - `core.longpaths` is set on every git call.
  - Symlinks for `vault link` are created as junctions, so no admin rights are needed.
  - Claude Desktop is found in both the classic location (`%APPDATA%\Claude`) and the Microsoft Store location (`%LOCALAPPDATA%\Claude-Data\…`, `Packages\Claude_*`).
- **Paths** in generated files are always `/`-separated and relative to the vault root.
