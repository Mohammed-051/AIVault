# Contributing to AIVault

Thanks for helping! AIVault stays **zero-dependency**: plain Node 18+ and git, no `npm install`. Please keep it that way.

## Quick dev loop

```bash
git clone https://github.com/Mohammed-051/AIVault.git && cd AIVault
node tests/run.mjs                       # all tests, one process per file
AIVAULT_HOME=/tmp/v node engine/cli.mjs init     # play in a throwaway vault
```

## Good first contributions

- **Starter packs.** Add `packs/<name>.json` with repos you've used and checked. Run `vault scan <url>` on each first and put the verdict in your PR.
- **Domain keywords.** Tune `engine/lib/domains.mjs` when a skill lands in the wrong domain. Include the skill and its description in the PR.
- **Scanner rules** (`engine/lib/security.mjs`). Every new rule needs:
  1. a malicious sample that it catches, and
  2. a **benign look-alike** that it does not flag (docs quoting the pattern, a vendor installer, a test).

  Add both to `tests/security.test.mjs`. Rules that block popular legitimate repos will be declined; run your rule against a few big repos (`vault scan <url>`).
- **Permission rules** (`engine/lib/permissions.mjs`). Same deal: a sample that should get the permission and a look-alike that shouldn't, in `tests/permissions.test.mjs`. Calibrate on a few big repos so tags stay rare and meaningful.
- **False-positive reports.** Use the issue template and paste the output of `vault scan <repo>`.

## Style

- ES modules, 2-space indent, small functions, no classes unless they earn it.
- Every command returns an array of output lines, so the CLI and the MCP server share the same code.
- Generated files (`dashboard.md`, `index/`) must stay within their token budget. `vault doctor` warns when they don't.

## Pull requests

- `node tests/run.mjs` passes on your machine. CI runs Node 18/20/22 on Windows, macOS and Linux.
- Update the README or `docs/` if behaviour changes, and add a line to `CHANGELOG.md`.
