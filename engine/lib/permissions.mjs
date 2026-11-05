// Permission inference: what a skill can make an agent do, read statically from its files.
// Output is a sorted list of tokens like "net:api.openai.com" or "publish", grouped into a
// plain-English card. Tokens are what Skill Lock pins and diffs on every update.
// Static analysis only: it describes what the files ask for, it cannot sandbox anything.
import fs from 'node:fs';
import path from 'node:path';

// kind → [level, label]. Level decides whether a *new* token holds an update for review.
export const PERM = {
  shell: ['low', 'runs commands'],
  script: ['low', 'runs bundled scripts'],
  install: ['low', 'installs packages'],
  net: ['medium', 'network'],
  secret: ['medium', 'reads secrets'],
  delete: ['medium', 'deletes files or history'],
  publish: ['medium', 'pushes / publishes / deploys'],
  write: ['high', 'writes outside the project'],
  agent: ['high', 'changes agent settings or memory'],
  admin: ['high', 'uses sudo / admin rights'],
  schedule: ['high', 'schedules background jobs'],
};
export const LEVEL = { low: 1, medium: 2, high: 3 };
export const SHORT = { net: 'net', secret: 'secrets', delete: 'deletes', publish: 'publishes', write: 'writes-global', agent: 'agent-config', admin: 'admin', schedule: 'schedules' };

const kindOf = (t) => t.split(':')[0];
export const levelOf = (t) => LEVEL[PERM[kindOf(t)]?.[0] || 'low'];

// ---------- files that belong to one skill ----------
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'out', 'target', '.next', 'coverage']);
export const MAX_FILES = 300;
const MAX_BYTES = 5 * 1024 * 1024;

// Every file under a skill folder, stopping at nested folders that are skills of their own.
export function skillFiles(dir) {
  const files = []; let partial = false;
  const walk = (d, depth) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || depth >= 8) continue;
        if (fs.existsSync(path.join(full, 'SKILL.md'))) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) { partial = true; return; }
        let size = 0; try { size = fs.statSync(full).size; } catch {}
        if (size > MAX_BYTES) { partial = true; continue; }
        files.push({ full, rel: path.relative(dir, full).split(path.sep).join('/'), ext: path.extname(e.name).toLowerCase(), size });
      }
    }
  };
  walk(dir, 0);
  return { files, partial };
}
// Would skillFiles() list this file (relative to the skill folder)? Used to spot files added after approval.
export function covered(relInSkill) {
  const parts = relInSkill.split('/');
  return !parts.slice(0, -1).some((p) => SKIP.has(p)) && parts.length <= 9;
}

// ---------- inference ----------
const CODE_EXT = new Set(['.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rb', '.pl', '.php', '.go', '.rs', '.lua', '.vbs', '.applescript']);
const MD_EXT = new Set(['.md', '.mdx', '.txt']);
const SHELL_LANG = /^(bash|sh|shell|zsh|fish|console|terminal|powershell|pwsh|ps1|ps|cmd|bat|batch)?$/i;
const CMD_START = /^\s*(\$\s*)?(sudo\s+)?(npx|npm|pnpm|yarn|bun|pip3?|uvx?|python3?|node|deno|git|gh|curl|wget|brew|apt(-get)?|cargo|go|docker|kubectl|make|bash|sh|zsh|pwsh|powershell|rm|mv|cp|mkdir|chmod|ln|cat|echo|export|set|setx|winget|choco|scoop|iwr|irm|Invoke-\w+|Remove-Item|Set-\w+|New-Item|crontab|schtasks|launchctl|systemctl|vercel|netlify|firebase|fly|wrangler|terraform|twine|ssh|scp|rsync|tee|source|\.\/[\w.-]+)\b/;
const NEGATED = /\b(never|don'?t|do not|avoid|instead of|rather than|not)\b/i;

const NET_VERB = /\b(fetch\s*\(|axios|requests\.(get|post|put|patch|delete)|httpx\.(get|post|put|Client|AsyncClient)|urllib\.request|urlopen|aiohttp\.ClientSession|http\.(get|request)|https\.(get|request)|XMLHttpRequest|WebClient|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|curl\s|wget\s|got\(|ky\(|new\s+WebSocket|socket\.connect|net\.connect|git\s+clone|gh\s+api)/i;
const URL_RX = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi;
const IGNORE_HOST = /^(localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|([\w-]+\.)?example\.(com|org|net)|([\w-]+\.)?w3\.org|json-schema\.org|schema\.org|schemas\.[\w.]+|purl\.org|xmlns\.com|semver\.org|spdx\.org|opensource\.org|creativecommons\.org|([\w-]+\.)?(your|my)[\w-]*\.[a-z]{2,}|(domain|site|website|company|acme|foo|bar|test|placeholder|directory)\.(com|org|io|dev)|[\w.-]+\.(local|test|invalid|example))$/i;
const SECRET_NAME = /\b[A-Z][A-Z0-9]*_(?:[A-Z0-9]+_)*(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|CREDENTIALS?)\b/g;
const SECRET_USE = /(process\.env\.|process\.env\[['"]|os\.environ(?:\.get)?\(?\[?['"]|os\.getenv\(['"]|getenv\(['"]|\$\{?|\$env:|%|ENV\[['"])$/;
const CRED_PATHS = [
  [/\.ssh[\\/](id_\w+|config)\b/, '~/.ssh'], [/\.aws[\\/]credentials/, '~/.aws/credentials'], [/\.git-credentials/, '.git-credentials'],
  [/\.netrc\b/, '.netrc'], [/\bdotenv\b|load_dotenv|(read|open|cat|source|Get-Content)[^\n]{0,30}['"\s]\.env\b/, '.env'],
  [/security\s+find-(generic|internet)-password|\bkeyring\.get_password|SecKeychainFind/, 'keychain'], [/\bgh\s+auth\s+token\b/, 'gh auth token'],
  [/\.config[\\/]gcloud|application_default_credentials/, 'gcloud credentials'], [/\.kube[\\/]config/, '~/.kube/config'], [/\.docker[\\/]config\.json/, '~/.docker/config.json'],
];
const INSTALL = [
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b(?!\s*$)/, 'npm'], [/\bnpx\s+(-y\s+|--yes\s+)?[@\w]/, 'npx'], [/\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b/, 'pip'],
  [/\buv\s+(pip\s+install|add|tool\s+install)\b|\buvx\s+\w/, 'uv'], [/\bbrew\s+install\b/, 'brew'], [/\bapt(-get)?\s+install\b/, 'apt'],
  [/\bcargo\s+install\b/, 'cargo'], [/\bgo\s+install\b/, 'go'], [/\bwinget\s+install\b/, 'winget'], [/\bchoco\s+install\b/, 'choco'],
  [/\bscoop\s+install\b/, 'scoop'], [/\bgem\s+install\b/, 'gem'], [/\bdocker\s+(pull|run)\b/, 'docker'],
];
const DELETE = /\brm\s+-[a-z]*r[a-z]*\b|\brmdir\s+\/s\b|Remove-Item\b[^\n]*-Recurse|shutil\.rmtree|fs\.(rm|rmSync|rmdir|rmdirSync)\([^)]*recursive|\brimraf\b|\bgit\s+(clean\s+-[a-z]*f|reset\s+--hard|push\s+[^\n]*(--force|-f\b)|branch\s+-D)|\bDROP\s+(TABLE|DATABASE)\b|\bdel\s+\/[sq]/;
const PUBLISH = /\bgit\s+push\b|\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+create)|\bnpm\s+publish\b|\bpnpm\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bdocker\s+push\b|\bvercel\b[^\n]*(--prod|deploy)|\bnetlify\s+deploy\b|\bfirebase\s+deploy\b|\bfly(ctl)?\s+deploy\b|\bwrangler\s+(deploy|publish)\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bsmtplib\b|\bsendmail\b|chat\.postMessage/;
const ADMIN = /(^|[\s;&|`(])sudo\s+\w|Start-Process[^\n]*-Verb\s+RunAs|\brunas\s+\/|Set-ExecutionPolicy\b|\bchmod\s+(-R\s+)?777\b|\bsetcap\b/;
const SCHEDULE = /\bcrontab\s+(-e|[^-\s])|\bschtasks(\.exe)?\s+\/create|Register-ScheduledTask|\blaunchctl\s+(load|bootstrap)|\bsystemctl\s+(--user\s+)?enable\b|\/etc\/cron\.|LaunchAgents/;
const AGENT_FILE = /(~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)?[\\/]?\.claude[\\/](settings(\.local)?\.json|CLAUDE\.md|agents|commands|hooks|skills)|\bCLAUDE\.md\b|\bAGENTS\.md\b|\.cursorrules|\.cursor[\\/]rules|copilot-instructions\.md|claude_desktop_config\.json|\.mcp\.json|mcp_config\.json/;
const GLOBAL_PATH = /(?<![\w.])(~[\\/][\w.\-/\\]*|\$HOME[\\/][\w.\-/\\]*|\$\{HOME\}[\\/][\w.\-/\\]*|%USERPROFILE%[\\/][\w.\-\\]*|%APPDATA%[\\/]?[\w.\-\\]*|%LOCALAPPDATA%[\\/]?[\w.\-\\]*|\$env:(USERPROFILE|APPDATA|LOCALAPPDATA)[\\/]?[\w.\-\\]*|\/etc\/[\w.\-/]+|\/usr\/local\/[\w.\-/]+|\$PROFILE\b|HKCU:?\\[\w\\]+|HKLM:?\\[\w\\]+|os\.path\.expanduser\(['"]~[^'"]*|os\.homedir\(\)|Path\.home\(\))/;
const WRITE_VERB = /(>>?\s*["']?(~|\$HOME|%|\/etc|\/usr)|\btee\b|\b(cp|mv|ln|mkdir|touch|install)\b|\bwrite(File(Sync)?|_text|_bytes)?\s*\(|open\([^)]*['"][wa]b?\+?['"]|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|New-ItemProperty|Set-ItemProperty|reg\s+add|setx\b|appendFile|mkdirSync|copyFile)/i;

function hosts(text) {
  const out = new Set(); let m;
  URL_RX.lastIndex = 0;
  while ((m = URL_RX.exec(text))) { const h = m[1].toLowerCase().replace(/^www\./, ''); if (!IGNORE_HOST.test(h)) out.add(h); }
  return out;
}
const shortPath = (p) => p.replace(/\\/g, '/').replace(/^(\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)/i, '~').replace(/['"]/g, '').split('/').slice(0, 3).join('/');

// Split a markdown file into "things the agent is told to run" and prose.
function commandsOf(md) {
  const cmds = []; const prose = [];
  const fence = /^(\s*)(```|~~~)\s*([\w+-]*)[^\n]*\n([\s\S]*?)^\1\2\s*$/gm;
  let last = 0; let m;
  while ((m = fence.exec(md))) {
    prose.push(md.slice(last, m.index)); last = fence.lastIndex;
    const lang = m[3] || '';
    if (SHELL_LANG.test(lang)) cmds.push(m[4]);
  }
  prose.push(md.slice(last));
  const text = prose.join('\n');
  for (const line of text.split('\n')) {
    const spans = line.match(/`([^`\n]{3,300})`/g) || [];
    for (const s of spans) {
      const body = s.slice(1, -1);
      if (!CMD_START.test(body)) continue;
      const before = line.slice(0, line.indexOf(s));
      if (NEGATED.test(before.slice(-50))) continue;
      cmds.push(body);
    }
  }
  return { cmds: cmds.join('\n'), prose: text };
}

function inferText(text, { code }, add) {
  for (const [rx, mgr] of INSTALL) if (rx.test(text)) add(`install:${mgr}`);
  if (DELETE.test(text)) add('delete');
  if (PUBLISH.test(text)) add('publish');
  if (ADMIN.test(text)) add('admin');
  if (SCHEDULE.test(text)) add('schedule');
  for (const [rx, name] of CRED_PATHS) if (rx.test(text)) add(`secret:${name}`);
  if (/\$\(\s*(printenv|env|set)\b|\b(printenv|env)\s*\||JSON\.stringify\(\s*process\.env\s*\)|dict\(\s*os\.environ\s*\)|json\.dumps\(\s*os\.environ|Get-ChildItem\s+env:/.test(text)) add('secret:all environment variables');
  let m; SECRET_NAME.lastIndex = 0;
  while ((m = SECRET_NAME.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (code ? SECRET_USE.test(before) || /['"]$/.test(before) : true) add(`secret:${m[0]}`);
  }
  for (const line of text.split('\n')) {
    if (!WRITE_VERB.test(line)) continue;
    if (AGENT_FILE.test(line)) { add('agent'); continue; }
    const g = line.match(GLOBAL_PATH);
    if (g) add(`write:${shortPath(g[0])}`);
  }
  if (NET_VERB.test(text)) {
    const h = hosts(text);
    if (h.size) for (const x of h) add(`net:${x}`);
    else if (code) add('net:*');
  }
}

// Comment lines describe behaviour; they don't perform it.
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|#(?!!)|\*|\/\*|--\s|REM\s|::)/i.test(l)).join('\n');

// Permissions for one skill folder (or a precomputed file list).
export function inferSkill(dir, listing = skillFiles(dir)) {
  const set = new Set();
  const add = (t) => set.add(t);
  const scripts = new Set(listing.files.filter((f) => CODE_EXT.has(f.ext)).map((f) => f.rel));
  for (const f of listing.files) {
    if (!MD_EXT.has(f.ext) && !CODE_EXT.has(f.ext)) continue;
    if (f.size > 1024 * 1024) continue;
    let text; try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    if (CODE_EXT.has(f.ext)) { inferText(stripComments(text), { code: true }, add); continue; }
    const { cmds, prose } = commandsOf(text);
    if (cmds.trim()) { add('shell'); inferText(cmds, { code: false }, add); }
    // Prose that tells the agent to send data somewhere still counts as network.
    for (const line of prose.split('\n')) {
      if (/\b(fetch|POST|send|upload|webhook|call the|request to|report to)\b/.test(line) && !NEGATED.test(line)) for (const h of hosts(line)) add(`net:${h}`);
      if (/\b(append|add|write|save|update)\b[^.\n]{0,60}\b(CLAUDE\.md|AGENTS\.md|\.claude\/settings|\.cursorrules)/i.test(line) && !NEGATED.test(line)) add('agent');
    }
    // Scripts the instructions point at.
    for (const s of scripts) if (text.includes(s) || text.includes(path.basename(s))) { add('shell'); add(`script:${s}`); }
  }
  return [...set].sort();
}

// ---------- presentation ----------
export function group(tokens = []) {
  const g = {};
  for (const t of tokens) { const [k, ...rest] = t.split(':'); (g[k] ||= []).push(rest.join(':')); }
  return g;
}
const ORDER = ['agent', 'admin', 'schedule', 'write', 'secret', 'net', 'publish', 'delete', 'install', 'script', 'shell'];

// "runs commands · network: api.x.com, y.io · reads secrets: OPENAI_API_KEY"
export function describe(tokens = [], { max = 4 } = {}) {
  const g = group(tokens);
  if (!tokens.length) return 'none detected (text only)';
  return ORDER.filter((k) => g[k]).map((k) => {
    const label = PERM[k][1];
    const details = g[k].filter(Boolean).map((d) => (d === '*' ? 'hosts not fixed in code' : d));
    if (!details.length) return label;
    return `${label}: ${details.slice(0, max).join(', ')}${details.length > max ? ` +${details.length - max}` : ''}`;
  }).join(' · ');
}

// Compact tag for index lines: only medium/high kinds, e.g. "{net,secrets}".
export function tag(tokens = []) {
  const kinds = [...new Set(tokens.filter((t) => levelOf(t) >= 2).map(kindOf))];
  return kinds.length ? `{${ORDER.filter((k) => kinds.includes(k)).map((k) => SHORT[k]).join(',')}}` : '';
}

// Tokens in `next` that are missing from `prev` and worth a human look.
export function added(prev = [], next = [], minLevel = 2) {
  const before = new Set(prev);
  return next.filter((t) => !before.has(t) && levelOf(t) >= minLevel);
}
