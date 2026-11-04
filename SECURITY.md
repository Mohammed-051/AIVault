# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for:

- a scanner bypass (a malicious skill that AIVault rates `clean` or `caution`),
- a sandbox escape in `vault_read`, or
- anything that lets an agent add a blocked repo without the user.

Instead, use GitHub's **Security → Report a vulnerability** (private advisory) on this repository. Include:

- a minimal sample (use documentation IPs such as `203.0.113.x` and `example.com` domains, never live malware),
- the output of `vault scan <path>`,
- your OS and Node version.

You'll get an acknowledgement within a few days. Fixes ship with a regression test.

## Scope

| In scope | Out of scope |
|---|---|
| `engine/lib/security.mjs` detection gaps | Vulnerabilities inside third-party repos you add (report those upstream) |
| `vault_read` path traversal or `.git` access | Attacks that need an attacker to already control your machine |
| MCP tools acting without user intent (e.g. forcing `--allow-risky`) | Findings from optional external scanners (report to NVIDIA or Cisco) |

## What AIVault promises

- It never executes code from repos it adds.
- Repos are scanned in quarantine before reaching `library/`. Critical findings block the add.
- Updates are re-scanned, and rolled back if they become malicious.
- The MCP server can't override a block, and can't read outside the vault folder.

What it does **not** promise is that a `clean` verdict means a repo is safe. See [docs/security.md#limits-honest-list](docs/security.md).
