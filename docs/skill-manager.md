# Skill manager

Installing big packages side by side (everything-claude-code, Superpowers, get-shit-done, marketingskills…) causes three problems:

- **Overlap.** Several packages ship a skill for the same job, and the agent picks one at random or loads two.
- **Unused agents.** Packages ship specialist subagents, but nothing tells your agent when to use them.
- **Dead weight.** Skills nobody opens still sit in the library and the indexes.

AIVault treats the library as a team. Your agent is the manager: it looks up who is good at each phase of the work, hands that phase over, and moves on.

## Phases

Every skill and agent is tagged with up to two of six phases. The tags are read from its name and description.

| Phase | Code work | Other work |
|---|---|---|
| **Discover** | explore the codebase, look up docs, gather requirements | research, competitor analysis, interviews |
| **Plan** | spec, architecture, task breakdown | outline, content strategy, brief |
| **Build** | implement | draft, design, generate |
| **Verify** | tests, debugging, build errors | fact-check, copy-edit, proofread |
| **Review** | code review, security review | editorial critique, SEO or accessibility audit |
| **Ship** | commit, PR, release, deploy, docs | publish, post, launch |

The keywords for each phase are plain data in `engine/lib/phases.mjs`.

## `vault plan`: a playbook for multi-step work

```console
$ vault plan "fix a rendering bug in my C++ OpenGL rasterizer"
1. Discover — research, requirements, brainstorming, exploring a codebase or topic
   skill: brainstorming
   agent: code-explorer
2. Plan — outline, spec, architecture, task breakdown, strategy
   skill: writing-plans
   agent: architect
3. Build — implement, draft, create, generate
   skill: test-driven-development
   agent: tdd-guide
4. Verify — test, debug, fix errors, fact-check, proofread
   skill: cpp-testing
   skill: verification-before-completion
   agent: cpp-build-resolver
5. Review — code review, security review, editorial critique, audits
   skill: requesting-code-review
   agent: cpp-reviewer
6. Ship — release, deploy, publish, docs, commit/PR, announce
   skill: finishing-a-development-branch {publishes,deletes}
```

Output trimmed. This was a real run on a vault with eight popular packages: 1,262 skills and 105 agents.

How the picks are made:

- **Task-specific matches first.** A skill or agent that matches the task's words ranks highest. `cpp-testing` and `cpp-reviewer` come from the words "C++" and "rasterizer".
- **General process skills fill the gaps.** Skills for the phase that match the task's domain fill the remaining slots: TDD, writing plans, code review, copy-editing and so on.
- **Skills for another stack are left out.** If a skill's name points at a technology the task doesn't mention (`laravel-tdd`, `django-build-resolver`, `springboot-tdd`), it isn't suggested. It shows up as soon as the task names that technology.
- **Engineering helpers stay out of non-code work.** A blog-post plan doesn't get a software architect.
- **One phase per item.** Each skill or agent appears once, in the phase where it fits best.

Through MCP, the same playbook comes from `vault_plan`. Then, at the start of each phase, the agent calls `vault_route` with that phase to get the full picks for it:

```console
$ vault route "fix a rendering bug in my C++ OpenGL rasterizer" --phase review
Phase: Review — code review, security review, editorial critique, audits
Skills for this phase (load at most 2):
- receiving-code-review — …
- requesting-code-review — …
Agent to hand this phase to (optional):
- cpp-reviewer — Expert C++ code reviewer specializing in memory safety, modern C++ idioms…
- code-reviewer — Expert code review specialist…
```

The dashboard protocol and the recommended agent instructions tell agents to work this way: call `vault_plan` once, then `vault_route` with a phase each time a phase starts.

## Agents

Subagent files (`agents/<name>.md` with `name`, `description` and optionally `tools` in the frontmatter, the Claude Code format) are indexed in `index/agents.md`, grouped by phase.

- **Permissions.** These come from the `tools:` line plus the file's own instructions:
  - `Bash` means *runs commands*.
  - `WebFetch` or `WebSearch` means *network: web search / fetch*.
  - `mcp__x` means *uses MCP server x*.
  - No `tools:` line means *inherits every tool*, tagged `{all-tools}`.
- **Locked like skills.** Agent files are pinned in `vault.lock`. An update that gives an agent new tools is held for review, and a tampered agent file is refused.
- **Delegating:**
  - *Claude Code:* `vault link <agent>` copies the agent into `~/.claude/agents/`, so the Task tool can run it. The copy is refreshed when you approve an update. `vault unlink <agent>` removes it.
  - *Any other app:* the agent opens the file with `vault_read` and does that phase itself, following its instructions. The file starts with its approved permissions and tool list.

Agents inside a skill's folder, such as `skill-creator/agents/grader.md`, belong to that skill and aren't listed on their own. Translated copies under `docs/` are skipped too.

## Overlaps and preferences

```console
$ vault overlaps
• Skills for "test driven development" (2, similarity 0.56)
    * test-driven-development            superpowers                Use when implementing any feature or bugfix…
      tdd-workflow                       everything-claude-code     Test-driven development workflow: write a failing test first…
    → vault prefer test-driven-development
```

- **How matching works.** Skills or agents from different sources that share a domain are compared by their name, description and headings. The headings matter because many skills have a bare trigger as their description.
- **Strict groups.** A group only forms when every member resembles every other, so a generic TDD skill never drags in `django-tdd` through a chain of partial matches. Identical copies are already hidden by the catalog.
- **`vault prefer <id>`** makes that item the winner for its group. You can name the losers yourself with `--over a,b`. The losers:
  - leave the index;
  - are swapped for the winner in `vault route` and `vault plan`;
  - stay searchable.

  `vault unprefer <id>` undoes it. Preferences are stored in `vault.json` under `prefer`.
- **Suggested winner.** By default this is your own `local/` skill, then an official source, then the source you added first.

`vault doctor` reports how many unresolved groups you have.

## Usage

Every `SKILL.md` or agent file opened through `vault_read` is counted in `.vault/usage.json`. The counts stay on your machine.

```console
$ vault usage
Most used:
    14×  writing-plans                      superpowers                last 2026-11-05
     9×  security-review                    everything-claude-code     last 2026-11-04
Never opened (added 14+ days ago) — candidates to remove or trim with "only":
  awesome-claude-skills           863 skills · added 2026-10-20 · `vault remove awesome-claude-skills`
```

`vault doctor` also warns when `~/.claude/skills` holds more than about 40 skills. Claude Code lists every installed skill in each session and starts dropping descriptions past that point, so keep only your daily skills there and let the vault route the rest on demand.

## Limits

- **Phases and overlaps come from names, descriptions and headings.** A skill with a vague description can land in the wrong phase. Fix it with `overrides` in `vault.json`, or prefer a better-described skill.
- **Delegation depends on the app.** Claude Code runs installed agents as real subagents. Elsewhere, "delegating" means the main agent follows the agent's instructions itself for that phase.
- **Usage counts only cover `vault_read`.** Skills that Claude Code loads natively from `~/.claude/skills` aren't counted.
