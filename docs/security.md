# Security model

AIVault assumes **every third-party repo is untrusted** until it has been scanned. This matters: in February 2026 Snyk reviewed 3,984 public agent skills and confirmed **76 malicious payloads**, and **13.4% of skills had at least one critical issue** ([ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/)). The rules below are built from the techniques documented there and in [*Exploring the Emerging Threats of the Agent Skill Ecosystem*](https://arxiv.org/html/2605.28588).

## The pipeline

```text
vault add <link>
   │
   ├─ git clone --depth 1  →  .vault/tmp/<name>/      (quarantine; git hooks are never cloned)
   ├─ static scan (36 rules, offline, ~0.1–2 s per repo)
   ├─ + NVIDIA SkillSpector or Cisco skill-scanner, if installed (auto-detected)
   │
   ├─ blocked  → quarantine deleted, nothing added, report saved
   ├─ review   → added, every skill marked ⚠ in the indexes, agents told to ask first
   └─ clean / caution → added
```

`vault update` downloads new versions into staging and scans them before anything changes. A blocked update is discarded and the approved version stays. A clean update can still be held: [Skill Lock](skill-lock.md) compares it with the version you approved and holds it if it gains permissions, such as a new network host, a secret or `git push`. Static rules alone would let those through.

AIVault itself **never executes code from a repo**: no installers, npm scripts, hooks or binaries. It reads files.

## Verdicts

| Verdict | Meaning | What happens |
|---|---|---|
| `clean` ✓ | No findings above low | Added normally |
| `caution` · | Medium findings only (e.g. an `https` installer one-liner, a tunnel URL) | Added; visible in `vault scan` |
| `review` ⚠ | At least one high finding | Added; skills flagged ⚠ in indexes; `vault_read` prepends a warning; dashboard tells agents to ask before following them |
| `blocked` ⛔ | At least one critical finding (or an external scanner says *do not install*) | **Not added.** Only a human can override: `vault add <link> --allow-risky` |

Set `"security": { "block": "high" }` in `vault.json` to also block `review` repos.

The MCP `vault_add` tool has **no override parameter**, so an agent, or a prompt-injected page talking to one, cannot force a risky install.

## Context-aware severity

The same text can be harmless in one place and dangerous in another. The scanner weighs where it appears:

- **Instruction files** are the files an agent follows: `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, and `.md` files under `skills/`, `agents/`, `commands/`, `references/` and similar folders. All rules apply at full strength.
- **Entry-point scripts get full severity.** These are scripts an instruction file tells the agent to run, npm install hooks, root `install.*`/`setup.*` scripts, and `bin/`. Other code is lowered one level, because nothing runs it automatically.
- **Human docs are lowered one level.** These are READMEs and guides that aren't instruction files.
- **`tests/`, `docs/`, `bench/`, `e2e/`, `fixtures/` and `.github/` are skipped,** unless an instruction file points at a script inside them. An attacker can't hide a payload in `tests/` and have `SKILL.md` run it.
- **Quoted attack examples are low.** A prompt-security skill that writes *"Ignore previous instructions" — detect and block these* is teaching, not attacking.
- **`curl … | sh` is graded by URL:**
  - Well-known vendor installers (uv, rustup, Docker, Homebrew, nvm, Bun, Deno and others) are low.
  - An unknown `https` domain is medium.
  - `http://` or a raw IP address is critical.

### Calibration

The scanner was checked against 24 widely used public repos. These included Anthropic skills, Superpowers, Matt Pocock skills, everything-claude-code (4,700 files), the official MCP servers, GitHub MCP, Composio and marketingskills.

- **None are blocked.**
- **One gets `review`,** and it deserves a human glance: a `base64` → `eval` in a verify script.

`tests/fixtures/malicious-skill` reproduces the published attack techniques. It is blocked with 5 critical and 6 high findings.

## Rules

| Rule | Base severity | Category | Applies to | Detects |
|---|---|---|---|---|
| `RCE-PIPE-SHELL` | critical | remote-exec | all text | Downloads code and pipes it straight into a shell/interpreter |
| `RCE-IEX-DOWNLOAD` | critical | remote-exec | all text | PowerShell download-and-execute |
| `RCE-SOURCE-REMOTE` | critical | remote-exec | all text | Sources or evals remote content at runtime |
| `RCE-BASE64-EXEC` | critical | obfuscation | all text | Decodes a hidden payload and executes it |
| `RCE-PS-ENCODED` | critical | obfuscation | all text | Runs an encoded (hidden) PowerShell command |
| `RCE-REVERSE-SHELL` | critical | backdoor | all text | Reverse shell / remote backdoor |
| `EXFIL-ENV-DUMP` | critical | exfiltration | all text | Collects all environment variables (API keys) and may send them out |
| `EXFIL-ENDPOINT` | high | exfiltration | all text | Sends data to a webhook/paste endpoint commonly used for exfiltration |
| `EXFIL-TUNNEL` | medium | exfiltration | all text | Tunnel/upload endpoint (legit for dev, also used for exfiltration) |
| `CRED-FILE-ACCESS` | high | credentials | scripts | Touches credential stores (SSH keys, cloud creds, browser passwords, wallets) |
| `CRED-ASK-SECRET` | high | credentials | instruction files | Asks the user to hand over secrets in chat |
| `PI-IGNORE-INSTRUCTIONS` | high | prompt-injection | instruction files | Tries to override the agent's instructions |
| `PI-HIDE-FROM-USER` | high | prompt-injection | instruction files | Tells the agent to hide actions from the user |
| `PI-SILENT-EXEC` | high | prompt-injection | instruction files | Instructs silent execution without user approval |
| `PI-SAFETY-BYPASS` | high | prompt-injection | instruction files | Talks the agent out of its safety checks |
| `PI-ROLE-SPOOF` | medium | prompt-injection | instruction files | Impersonates system/role messages |
| `PI-MEMORY-POISON` | high | persistence | instruction files | Writes into agent memory/instruction files so changes persist across sessions |
| `DL-RAW-IP` | high | download | all text | Fetches from a raw IP address instead of a domain |
| `DL-EXECUTABLE` | medium | download | instruction files | Links an executable for the agent to download |
| `DL-PASSWORD-ARCHIVE` | high | download | all text | Extracts a password-protected archive (hides contents from scanners) |
| `SYS-PERSISTENCE` | high | persistence | all text | Installs something that survives reboot |
| `SYS-SECURITY-OFF` | critical | tampering | all text | Disables antivirus/firewall/OS security |
| `SYS-DESTRUCTIVE` | critical | tampering | all text | Wipes the home folder or a disk |
| `SYS-MINER` | critical | malware | all text | Cryptocurrency miner |
| `SYS-KEYLOGGER` | high | malware | scripts | Keyboard capture |
| `OBF-HEX-BLOB` | medium | obfuscation | scripts | Long hex-escaped blob |
| `OBF-CHARCODE` | medium | obfuscation | scripts | Builds strings from char codes to hide them |
| `SECRET-KEY` | medium | secrets | all text | Hard-coded credential |
| `PI-INVISIBLE-UNICODE` | high | prompt-injection | instruction files | Zero-width, bidi and Unicode tag characters that hide text |
| `PI-HIDDEN-COMMENT` | medium | prompt-injection | instruction files | HTML comments carrying instructions (invisible when rendered) |
| `OBF-BASE64-BLOB` | medium | obfuscation | instruction files | 400+ char encoded blobs inside instructions |
| `BIN-DISGUISED` | critical | malware | all files | PE/ELF/Mach-O binary behind a harmless file name |
| `BIN-EXECUTABLE` | high/medium | supply-chain | all files | Compiled executables or libraries shipped in the repo |
| `BIN-ARCHIVE` | low | supply-chain | all files | Archives (contents not inspected) |
| `SUPPLY-INSTALL-HOOK` | critical/high/low | supply-chain | package.json | npm pre/post-install hooks (critical if they pipe downloads into a shell) |
| `FS-SYMLINK-ESCAPE` | high | tampering | all files | Symlinks pointing outside the repo |

## Deep scanning (optional)

If either tool is on your PATH, AIVault runs it automatically and merges its verdict. Set `security.external` to `skillspector`, `cisco` or `off` to choose.

| Tool | Install | Adds |
|---|---|---|
| [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) | `uv tool install git+https://github.com/NVIDIA/skillspector.git` | 68 patterns, YARA signatures, OSV dependency CVEs, MCP tool poisoning. AIVault runs it with `--no-llm`. |
| [Cisco skill-scanner](https://github.com/cisco-ai-defense/skill-scanner) | `pip install cisco-ai-skill-scanner` | Bytecode and pipeline analysis, Unicode steganography, supply chain checks. |

## Limits (honest list)

- **Static analysis can be evaded** by a determined attacker. For example, code fetched at runtime from a domain that looks harmless today.
- **Archive contents** (`.zip`, `.7z`) are flagged but not inspected.
- **Only the repo's own files are scanned.** Dependencies it would install are not checked; SkillSpector adds OSV lookups for that.
- **A clean verdict means "no known bad patterns", not "audited".** Read a skill before giving an agent broad permissions.

## Reporting

Found a bypass or a false positive? See [SECURITY.md](../SECURITY.md).
