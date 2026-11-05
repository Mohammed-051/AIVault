#!/usr/bin/env node
// AIVault CLI. Usage: vault <command> [args] [--flags]   ·   vault <repo-url>  (shortcut for add)
import * as cmd from './lib/commands.mjs';
import { VERSION } from './lib/core.mjs';

const HELP = `AIVault ${VERSION} — a local library for agent skills, with a lockfile and permissions for what they can do.

  vault setup [--yes]              First run: folders, starter pack, connect your AI apps, PATH
  vault <repo-url>                 Add a repo (same as: vault add <repo-url>)
  vault add <source> [flags]       Clone to quarantine → security scan → file into library/<kind>/ → re-index
        source: owner/repo · GitHub URL · .../tree/<branch>/<folder> · any git URL · local folder
        --dry-run                  Preview what would be added
        --only a,b                 Keep only these skills from the repo
        --kind  skills|mcp|plugins|tools|catalogs     Override auto-detection
        --domain <id>              Default domain for skills that don't classify
        --name  <name>             Folder/source name
        --include-internal         Keep skills found in hidden folders (.claude/, .agents/) of MCP/tool repos
        --allow-risky              Add even if the security scan blocks it (only after reading the report)
  vault scan [name|all|url]        Security-scan sources (or preview a repo without adding it)
  vault remove <name>              Delete a source and re-index

Skill Lock
  vault update [name]              Download updates into staging, scan and diff them. Harmless ones apply;
                                   ones that add permissions or worsen the scan are held for review
  vault review [name]              Show held updates: new permissions, changed instructions, scan results
  vault approve <name> [--yes]     Apply a held update (or accept on-disk changes) and lock it
  vault reject <name>              Discard a held update and skip that version
  vault verify                     Check every skill file against vault.lock
  vault permissions [skill|source] What skills are allowed to do (network, secrets, publishing, …)

Library
  vault sync                       Clone anything in vault.json that's missing (new machine)
  vault index                      Rebuild dashboard.md and index/*.md
  vault search <words>             Find skills
  vault route "<task>"             What an agent should load for a task
  vault list [kind|domain|name]    List sources or a domain's skills
  vault doctor                     Check for broken paths, size budget, empty memory
  vault new-project "<name>" [--type dev|writing|content|media|research|business]
  vault new-skill <name>           Scaffold your own skill in local/skills/
  vault link <skill> [--to dir]    Link a skill into ~/.claude/skills for Claude Code
  vault pack [name|file]           List or install starter packs
  vault export [name]              Save your sources as a shareable pack
  vault migrate                    Adopt loose git clones in the vault folder into library/
  vault connect [--client id]      Connect the MCP server to Claude Desktop/Code, Cursor, Windsurf, VS Code
                                   (closes & reopens Claude Desktop; backs up every config)
  vault mcp-config                 Print the MCP config to connect other agents to this vault
  vault init                       Create vault.json and folders`;

function parse(argv) {
  const args = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (v !== undefined) flags[key] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !['dryRun', 'force', 'includeInternal', 'allowRisky', 'yes', 'noClose', 'noPacks', 'noPath', 'noClipboard', 'vscode'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}

const { args, flags } = parse(process.argv.slice(2));
let [command, ...rest] = args;
if (command && /^(https?:\/\/|git@)|^[\w.-]+\/[\w.-]+$/.test(command) && !['add'].includes(command)) { rest = [command]; command = 'add'; }

const table = {
  add: () => cmd.add(rest[0], flags),
  remove: () => cmd.remove(rest[0]), rm: () => cmd.remove(rest[0]),
  update: () => cmd.update(rest[0]), review: () => cmd.review(rest[0]), diff: () => cmd.review(rest[0]),
  approve: () => cmd.approve(rest[0], flags), reject: () => cmd.reject(rest[0]), verify: () => cmd.verify(),
  permissions: () => cmd.permissions(rest.join(' ') || undefined), perms: () => cmd.permissions(rest.join(' ') || undefined), sync: () => cmd.sync(), index: () => cmd.index(),
  search: () => cmd.find(rest.join(' ')), route: () => cmd.routeTask(rest.join(' ')),
  list: () => cmd.list(rest[0]), ls: () => cmd.list(rest[0]), doctor: () => cmd.doctor(),
  'new-project': () => cmd.newProject(rest.join(' '), flags), 'new-skill': () => cmd.newSkill(rest[0]),
  link: () => cmd.link(rest[0], flags), pack: () => cmd.pack(rest[0]), export: () => cmd.exportPack(rest[0]),
  migrate: () => cmd.migrate(), init: () => cmd.init(), 'mcp-config': () => cmd.mcpConfig(), connect: () => cmd.connect(flags),
  scan: () => cmd.scan(rest[0]), setup: () => cmd.setup(flags), version: () => [`aivault ${VERSION}`],
};

if (!command || command === 'help' || flags.help || !table[command]) {
  console.log(HELP);
  process.exit(command && !table[command] && command !== 'help' ? 1 : 0);
}
try {
  const out = await table[command]();
  console.log(out.join('\n'));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
