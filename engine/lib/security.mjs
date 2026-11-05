// Security scanner. Runs on every `vault add` (in quarantine, before anything reaches library/),
// on `vault update` (rolls back if new critical findings appear) and on `vault scan`.
// Static, offline, zero dependencies. Optionally chains NVIDIA SkillSpector / Cisco skill-scanner.
// Rules are based on published research on malicious agent skills (Snyk ToxicSkills, arXiv 2605.28588).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, exists, writeJSON, writeText, P } from './core.mjs';

export const SEVERITY = { critical: 4, high: 3, medium: 2, low: 1 };
const WEIGHT = { critical: 40, high: 15, medium: 4, low: 1 };

// where: 'agent' = files an agent reads as instructions (SKILL.md, agent/command .md, AGENTS.md…)
//        'code'  = scripts and source files      'any' = both (+ READMEs and other docs)
const R = (id, severity, category, where, rx, why) => ({ id, severity, category, where, rx, why });
export const RULES = [
  // --- remote code execution ---
  R('RCE-PIPE-SHELL', 'critical', 'remote-exec', 'any', /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,240}\|\s*(sudo\s+)?((ba|z|k|da)?sh|iex|Invoke-Expression|python3?|node|perl|ruby|source)\b/i, 'Downloads code and pipes it straight into a shell/interpreter'),
  R('RCE-IEX-DOWNLOAD', 'critical', 'remote-exec', 'any', /\b(iex|Invoke-Expression)\b\s*\(?\s*(\(?\s*New-Object\s+Net\.WebClient|\(?\s*(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b)/i, 'PowerShell download-and-execute'),
  R('RCE-SOURCE-REMOTE', 'critical', 'remote-exec', 'any', /(source|\.)\s+<\(\s*(curl|wget)|eval\s+["']?\$\(\s*(curl|wget)/i, 'Sources or evals remote content at runtime'),
  R('RCE-BASE64-EXEC', 'critical', 'obfuscation', 'any', /base64\s+(-d|--decode|-D)\b[^\n]{0,120}\|\s*(sudo\s+)?(ba|z)?sh\b|FromBase64String[^\n]{0,160}(iex|Invoke-Expression)|eval\s*\(\s*(atob\s*\(|Buffer\.from\([^)]*['"]base64)|exec\s*\(\s*(base64\.b64decode|__import__\(\s*['"]base64)/i, 'Decodes a hidden payload and executes it'),
  R('RCE-PS-ENCODED', 'critical', 'obfuscation', 'any', /\bpowershell(\.exe)?\b[^\n]{0,60}\s-(e|ec|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{24,}/i, 'Runs an encoded (hidden) PowerShell command'),
  R('RCE-REVERSE-SHELL', 'critical', 'backdoor', 'any', /\/dev\/tcp\/\d{1,3}\.|\bnc(at)?\s+(-\w+\s+)*-e\s|bash\s+-i\s+>&\s*\/dev|socat\s+[^\n]*exec:|New-Object\s+System\.Net\.Sockets\.TCPClient\s*\(\s*['"]\d/i, 'Reverse shell / remote backdoor'),

  // --- credential theft & exfiltration ---
  R('EXFIL-ENV-DUMP', 'critical', 'exfiltration', 'any', /(curl|wget)\b[^\n]{0,160}\$\(\s*(printenv|env|set)\b|JSON\.stringify\(\s*process\.env\s*\)|json\.dumps\(\s*(dict\()?\s*os\.environ|(printenv|\benv)\s*\|\s*(curl|nc|wget)\b|Get-ChildItem\s+env:[^\n]{0,80}(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)/i, 'Collects all environment variables (API keys) and may send them out'),
  R('EXFIL-ENDPOINT', 'high', 'exfiltration', 'any', /discord(app)?\.com\/api\/webhooks\/|api\.telegram\.org\/bot|webhook\.site|requestbin|pipedream\.net|\binteract\.sh\b|\.oast\.(fun|me|pro|live|site)|pastebin\.com\/api|anonfiles|file\.io\//i, 'Sends data to a webhook/paste endpoint commonly used for exfiltration'),
  R('EXFIL-TUNNEL', 'medium', 'exfiltration', 'any', /ngrok(-free)?\.(io|app)|transfer\.sh|hooks\.slack\.com\/services\//i, 'Tunnel/upload endpoint (legit for dev, also used for exfiltration)'),
  R('CRED-FILE-ACCESS', 'high', 'credentials', 'code', /\.ssh[\\/](id_rsa|id_ed25519|id_ecdsa)\b|\.aws[\\/]credentials|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|\.config[\\/]gcloud[\\/]|\bLogin Data\b|cookies\.sqlite|key4\.db|logins\.json|wallet\.dat|Keychains?[\\/]|\.gnupg[\\/]|Local\\Google\\Chrome\\User Data|\.mozilla[\\/]firefox/i, 'Touches credential stores (SSH keys, cloud creds, browser passwords, wallets)'),
  R('CRED-ASK-SECRET', 'high', 'credentials', 'agent', /\b(paste|enter|share|give)\b[^\n]{0,40}\byour\s+(seed phrase|mnemonic|private key|password|api[\s_-]?key|secret key)\b[^\n]{0,60}\b(here|to me|in (the )?chat|below)\b/i, 'Asks the user to hand over secrets in chat'),

  // --- prompt injection (agent-facing text) ---
  R('PI-IGNORE-INSTRUCTIONS', 'high', 'prompt-injection', 'agent', /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding|system|safety)\s+(instructions|prompts?|rules|guidelines|messages)/i, 'Tries to override the agent\'s instructions'),
  R('PI-HIDE-FROM-USER', 'high', 'prompt-injection', 'agent', /\b(do not|don't|never|without)\s+(tell(ing)?|inform(ing)?|mention(ing)?|reveal(ing)?|show(ing)?|notify(ing)?|alert(ing)?)\s+(this\s+(to\s+)?)?(the\s+)?user\b/i, 'Tells the agent to hide actions from the user'),
  R('PI-SILENT-EXEC', 'high', 'prompt-injection', 'agent', /\b(silently|quietly|secretly)\s+(\w+\s+)?(run|execute|install|download|send|upload|delete|exfiltrate)\b|\b(run|execute|install|download|send|upload)\b[^.\n]{0,30}\b(silently|without (asking|confirmation|prompting|user approval))\b/i, 'Instructs silent execution without user approval'),
  R('PI-SAFETY-BYPASS', 'high', 'prompt-injection', 'agent', /\b(security|safety|antivirus)\s+(warnings?|alerts?|checks?|prompts?)\s+(are|is)\s+(false positives?|test artifacts?|expected|harmless|safe to ignore)|\bdisable\s+(your\s+)?(safety|guardrails|content filter)|\bDAN mode\b|\bdeveloper mode enabled\b/i, 'Talks the agent out of its safety checks'),
  R('PI-ROLE-SPOOF', 'medium', 'prompt-injection', 'agent', /^\s*<\/?(system|im_start|im_end)>|^\s*\[(SYSTEM|INST)\]|^\s*(new|updated)\s+system\s+(prompt|instructions)\s*:/im, 'Impersonates system/role messages'),
  R('PI-MEMORY-POISON', 'high', 'persistence', 'agent', /(>>|\bappend|\bwrite(File)?|Add-Content|Set-Content|Out-File)[^\n]{0,80}\b(CLAUDE\.md|AGENTS\.md|MEMORY\.md|SOUL\.md|\.cursorrules|copilot-instructions\.md|\.claude[\\/]settings(\.local)?\.json)/i, 'Writes into agent memory/instruction files so changes persist across sessions'),

  // --- suspicious downloads ---
  R('DL-RAW-IP', 'high', 'download', 'any', /https?:\/\/(?!127\.|0\.0\.0\.0|10\.|192\.168\.|localhost)\d{1,3}(\.\d{1,3}){3}(:\d+)?\//i, 'Fetches from a raw IP address instead of a domain'),
  R('DL-EXECUTABLE', 'medium', 'download', 'agent', /https?:\/\/[^\s"'<>)]+\.(exe|msi|scr|pkg|dmg|apk|jar|bat|cmd|ps1|vbs|appimage)(\?[^\s"'<>)]*)?(?=[\s"'<>)]|$)/i, 'Links an executable for the agent to download'),
  R('DL-PASSWORD-ARCHIVE', 'high', 'download', 'any', /\b(unzip|7z|7za|unrar)\b[^\n]*\s(-P\s*\S+|-p\S+)/i, 'Extracts a password-protected archive (hides contents from scanners)'),

  // --- persistence / system tampering ---
  R('SYS-PERSISTENCE', 'high', 'persistence', 'any', /\bcrontab\s+-[^l\s]|\/etc\/cron\.|\/etc\/systemd\/system\/|systemctl\s+enable\b|Library[\\/]Launch(Agents|Daemons)|CurrentVersion\\Run(Once)?\b|schtasks(\.exe)?\s+\/create|Start Menu\\Programs\\Startup/i, 'Installs something that survives reboot'),
  R('SYS-SECURITY-OFF', 'critical', 'tampering', 'any', /Set-MpPreference[^\n]*-Disable\w*\s+\$?true|Add-MpPreference[^\n]*-Exclusion|\bsetenforce\s+0\b|\bufw\s+disable\b|spctl\s+--master-disable|csrutil\s+disable|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i, 'Disables antivirus/firewall/OS security'),
  R('SYS-DESTRUCTIVE', 'critical', 'tampering', 'any', /\brm\s+-(rf|fr)\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*)(\s|$|;)|Remove-Item[^\n]*-Recurse[^\n]*\s(C:\\\s|\$env:USERPROFILE\s|~\s)|\bformat\s+c:|\bmkfs\.\w+\s+\/dev\/(sd|nvme)/i, 'Wipes the home folder or a disk'),
  R('SYS-MINER', 'critical', 'malware', 'any', /\bxmrig\b|stratum\+tcp:\/\/|\bcryptonight\b|\bminerd\b/i, 'Cryptocurrency miner'),
  R('SYS-KEYLOGGER', 'high', 'malware', 'code', /GetAsyncKeyState|SetWindowsHookEx\w*\s*\(\s*(13|WH_KEYBOARD)|pynput\.keyboard\.Listener|\bkeylogger\b/i, 'Keyboard capture'),

  // --- obfuscation ---
  R('OBF-HEX-BLOB', 'medium', 'obfuscation', 'code', /(\\x[0-9a-f]{2}){40,}/i, 'Long hex-escaped blob'),
  R('OBF-CHARCODE', 'medium', 'obfuscation', 'code', /fromCharCode\(\s*(\d+\s*,\s*){25,}|chr\(\d+\)\s*\+\s*(chr\(\d+\)\s*\+\s*){20,}/i, 'Builds strings from char codes to hide them'),

  // --- leaked secrets (sloppy or stolen keys) ---
  R('SECRET-KEY', 'medium', 'secrets', 'any', /\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}|\bsk-ant-[A-Za-z0-9_-]{30,}|\bsk-(proj-)?[A-Za-z0-9]{40,}\b|\bxox[baprs]-[0-9A-Za-z-]{20,}|\bAIza[0-9A-Za-z_-]{35}\b|-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'Hard-coded credential'),
];

// Install one-liners from well-known vendors are common in legit docs → downgraded to low.
const KNOWN_INSTALLERS = /(astral\.sh|sh\.rustup\.rs|get\.docker\.com|bun\.sh|deno\.land|get\.pnpm\.io|raw\.githubusercontent\.com\/(nvm-sh|Homebrew)|brew\.sh|ollama\.com|claude\.ai\/install|install\.python-poetry\.org|starship\.rs|get\.volta\.sh|fnm\.vercel\.app|cli\.github\.com|tailscale\.com\/install|sdk\.cloud\.google\.com|aka\.ms\/install|dot\.net\/v1|nixos\.org|mise\.run|pixi\.sh|vercel\.com\/install|fly\.io\/install|supabase\.com|railway\.app\/install|get\.k3s\.io|helm\.sh|uv\.run|opencode\.ai\/install|cursor\.com\/install|gemini|anthropic\.com)/i;
const PLACEHOLDER = /(x{6,}|EXAMPLE|example|your[-_ ]?(api[-_ ]?)?key|<[^>]+>|\.\.\.|dummy|fake|test|sample|REDACTED|placeholder)/i;

const TEXT_EXT = new Set(['.md', '.mdx', '.txt', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rb', '.pl', '.php', '.go', '.rs', '.lua', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.vbs', '.applescript', '.fish', '.nu']);
const CODE_EXT = new Set(['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rb', '.pl', '.php', '.go', '.rs', '.lua', '.vbs', '.applescript', '.fish', '.nu']);
const BINARY_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.scr', '.com', '.msi', '.pkg', '.dmg', '.apk', '.jar', '.pyc', '.bin', '.elf', '.sys', '.cpl', '.ocx']);
const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.xz', '.bz2']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
// Not executed by agents or installers: scanned only when an agent-facing file points at them.
const PASSIVE_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixtures', '__fixtures__', 'testdata', 'bench', 'benchmark', 'benchmarks', 'evals', 'eval', 'results', 'docs', 'doc', '.github', 'coverage', 'snapshots', '__snapshots__']);
const CONFIG_JSON = /^(package|server|plugin|marketplace|hooks|settings(\.local)?|\.?mcp|mcp[\w.-]*|claude_desktop_config)\.json$/i;
const RULE_FILE_EXT = new Set(['.yar', '.yara', '.sigma', '.rules']); // detection signatures, not instructions

function isAgentFacing(rel, root) {
  const base = path.basename(rel).toLowerCase();
  if (['skill.md', 'agents.md', 'claude.md', 'gemini.md', '.cursorrules', 'copilot-instructions.md'].includes(base)) return true;
  if (!base.endsWith('.md')) return false;
  const parts = rel.toLowerCase().split('/');
  if (parts.length === 1) return false; // root README/CONTRIBUTING are human docs
  return parts.some((p) => ['skills', 'agents', 'commands', 'prompts', 'references', 'reference', '.claude', '.agents', 'rules', 'instructions', 'workflows'].includes(p))
    || exists(path.join(root, ...path.dirname(rel).split('/'), 'SKILL.md'));
}

function lineOf(text, index) { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }
const snippet = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 140);
const lower = (sev) => ({ critical: 'high', high: 'medium', medium: 'low', low: 'low' })[sev];
const NET = /\b(fetch\s*\(|axios|requests\.(post|get|put)|urllib|http\.request|https\.request|XMLHttpRequest|curl\s|wget\s|Invoke-WebRequest|Invoke-RestMethod|WebClient|socket\.connect|net\.connect)/i;
const QUOTED_CONTEXT = /\b(e\.g|example|examples|such as|attack|attacker|inject|injection|detect|defen[cs]e|jailbreak|red[- ]team|malicious|adversar|resist|guardrail|flag|block|test case|payload)/i;

// Invisible characters used to smuggle instructions past human review.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩]|[\u{E0000}-\u{E007F}]/u;

// Context decides severity: the same text is dangerous in a SKILL.md an agent follows or an install hook,
// and mostly harmless in a doc that quotes it or a test nobody runs.
function adjust(rule, m, text, ctx) {
  const ls = text.lastIndexOf('\n', m.index) + 1; const le = text.indexOf('\n', m.index);
  const line = text.slice(ls, le === -1 ? text.length : le);
  const before = text.slice(Math.max(0, m.index - 60), m.index);
  let sev = rule.severity;
  switch (rule.id) {
    case 'RCE-PIPE-SHELL': {
      const url = (m[0].match(/https?:\/\/[^\s'"|)]+/) || [])[0] || (m[0].match(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\/[^\s'"|)]*/i) || [])[0];
      if (!url) return 'low';                                    // prose like "curl … | sh" or a local pipe
      if (/localhost|127\.0\.0\.1|\$\{?\w/.test(url)) return 'low';
      if (/^http:\/\//i.test(url) || /\/\/\d{1,3}(\.\d{1,3}){3}/.test(url)) return 'critical';
      if (KNOWN_INSTALLERS.test(url)) return 'low';
      sev = 'medium'; break;                                     // https installer from a named domain: review it
    }
    case 'PI-IGNORE-INSTRUCTIONS': case 'PI-SAFETY-BYPASS': case 'PI-HIDE-FROM-USER': case 'PI-ROLE-SPOOF':
      if (/["'`“”‘’>]/.test(text[m.index - 1] || '') || QUOTED_CONTEXT.test(line)) return 'low';
      break;
    case 'PI-SILENT-EXEC':
      if (/\b(not|never|don'?t|rather than|instead of|avoid|fail(s|ed|ing)?|error|drop|lose|skip)\b/i.test(before + ' ' + m[0])) return 'low';
      sev = 'medium'; break;
    case 'CRED-ASK-SECRET': if (QUOTED_CONTEXT.test(line)) return 'low'; break;
    case 'EXFIL-ENV-DUMP': if (!NET.test(text)) return 'low'; break;
    case 'CRED-FILE-ACCESS': sev = NET.test(text) ? 'high' : 'low'; break;
    case 'DL-RAW-IP':
      if (/\/\/(1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|208\.67\.222\.222)\b/.test(m[0])) return 'low';
      if (/\/\/169\.254\./.test(m[0])) return ctx.code ? 'medium' : 'low';
      if (!ctx.code) sev = 'medium'; break;
    case 'SYS-PERSISTENCE': if (!ctx.code) sev = 'medium'; break;
    case 'SYS-DESTRUCTIVE': if (!ctx.code) sev = 'medium'; break;
    case 'PI-MEMORY-POISON': sev = 'medium'; break;
  }
  if (ctx.code && !ctx.entry && SEVERITY[sev] >= 3) sev = lower(sev); // code that nothing runs automatically
  if (ctx.humanDoc && SEVERITY[sev] > 1) sev = lower(sev);            // README / guides for humans
  return sev;
}

export function scanDir(root, opts = {}) {
  root = path.resolve(root);
  const findings = []; const stats = { files: 0, scanned: 0, bytes: 0, skippedLarge: 0, binaries: 0, archives: 0, symlinks: 0, passiveSkipped: 0 };
  const maxFile = 1024 * 1024; const maxTotal = 300 * 1024 * 1024;
  const add = (f) => { if (findings.filter((x) => x.rule === f.rule && x.file === f.file).length < 3) findings.push(f); };
  const R0 = path.resolve(root);

  // 1. inventory
  const files = [];
  const walk = (dir, depth, passive) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) {
        stats.symlinks++;
        let target = ''; try { target = path.resolve(path.dirname(full), fs.readlinkSync(full)); } catch {}
        if (!target.startsWith(R0 + path.sep)) add({ rule: 'FS-SYMLINK-ESCAPE', severity: 'high', category: 'tampering', file: rel, line: 0, why: 'Symlink points outside the repo', match: target });
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= 12) continue;
        walk(full, depth + 1, passive || PASSIVE_DIRS.has(e.name.toLowerCase()));
        continue;
      }
      if (e.isFile()) files.push({ full, rel, name: e.name, ext: path.extname(e.name).toLowerCase(), passive });
    }
  };
  walk(root, 0, false);
  stats.files = files.length;

  // 2. entry points: scripts an agent is told to run, install hooks, root install scripts, bin/
  const entry = new Set();
  const refRx = /(?:^|[\s`'"(\[=])((?:\.{1,2}\/)?[\w./-]+\.(?:sh|bash|ps1|py|js|mjs|cjs|ts|bat|cmd|rb|pl))(?=[\s`'")\]:;,]|$)/gm;
  for (const f of files) {
    if (/^(install|setup|bootstrap|postinstall|preinstall)\.(sh|ps1|cmd|bat|py|js|mjs)$/i.test(f.rel) || /^bin\//.test(f.rel) || /(^|\/)hooks?\//i.test(f.rel)) entry.add(f.full);
    const agent = isAgentFacing(f.rel, root);
    if (!agent && f.name !== 'package.json') continue;
    let text; try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    if (agent) { let rm; while ((rm = refRx.exec(text))) { entry.add(path.resolve(path.dirname(f.full), rm[1])); entry.add(path.resolve(root, rm[1])); } }
    else { try { const sc = JSON.parse(text).scripts || {}; for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) if (sc[k]) for (const t of String(sc[k]).match(/[\w./-]+\.(js|mjs|cjs|sh|ps1|py)/g) || []) entry.add(path.resolve(path.dirname(f.full), t)); } catch {} }
  }

  // 3. scan
  for (const f of files) {
    const { full, rel, name, ext } = f;
    if (f.passive && !entry.has(full)) { stats.passiveSkipped++; continue; }
    let size = 0; try { size = fs.statSync(full).size; } catch {}
    if (BINARY_EXT.has(ext)) { stats.binaries++; add({ rule: 'BIN-EXECUTABLE', severity: opts.kind === 'skills' ? 'high' : 'medium', category: 'supply-chain', file: rel, line: 0, why: 'Ships a compiled executable/library', match: name }); continue; }
    if (ARCHIVE_EXT.has(ext)) { stats.archives++; add({ rule: 'BIN-ARCHIVE', severity: 'low', category: 'supply-chain', file: rel, line: 0, why: 'Archive contents are not scanned', match: name }); continue; }
    if (size > maxFile || stats.bytes > maxTotal) { stats.skippedLarge++; continue; }
    let buf; try { buf = fs.readFileSync(full); } catch { continue; }
    if (buf.length >= 4 && ((buf[0] === 0x4d && buf[1] === 0x5a && buf.length > 64) || (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) ||
        buf.readUInt32BE(0) === 0xcffaedfe || buf.readUInt32BE(0) === 0xfeedfacf)) {
      if (!BINARY_EXT.has(ext)) add({ rule: 'BIN-DISGUISED', severity: 'critical', category: 'malware', file: rel, line: 0, why: 'Executable binary hidden behind a non-executable file name', match: name });
      continue;
    }
    if (!TEXT_EXT.has(ext) && name !== '.cursorrules' && !/^(Makefile|Dockerfile)$/.test(name)) continue;
    if (RULE_FILE_EXT.has(ext) || (ext === '.json' && !CONFIG_JSON.test(name))) continue;
    stats.bytes += size; stats.scanned++;
    const text = buf.toString('utf8');
    const agent = isAgentFacing(rel, root) || (opts.singleSkill && ext === '.md');
    const code = CODE_EXT.has(ext);
    const ctx = { agent, code, entry: entry.has(full), humanDoc: !agent && !code && (ext === '.md' || ext === '.mdx' || ext === '.txt') };

    for (const rule of RULES) {
      if (rule.where === 'agent' && !agent) continue;
      if (rule.where === 'code' && !code) continue;
      const m = rule.rx.exec(text);
      if (!m) continue;
      if (rule.id === 'SECRET-KEY' && PLACEHOLDER.test(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))) continue;
      const severity = adjust(rule, m, text, ctx);
      add({ rule: rule.id, severity, category: rule.category, file: rel, line: lineOf(text, m.index), why: rule.why, match: snippet(m[0]) });
    }
    if (agent || code) {
      const inv = INVISIBLE.exec(text);
      if (inv) add({ rule: 'PI-INVISIBLE-UNICODE', severity: agent ? 'high' : 'medium', category: 'prompt-injection', file: rel, line: lineOf(text, inv.index), why: 'Invisible/bidi Unicode characters can hide instructions', match: `U+${inv[0].codePointAt(0).toString(16).toUpperCase()}` });
    }
    if (agent) {
      const c = /<!--([\s\S]{0,600}?)-->/g; let hm;
      while ((hm = c.exec(text))) {
        if (/\b(ignore (previous|all|prior)|curl|wget|exfiltrat|send (the|all|your)|upload|password|token|api key|do not tell|don't tell)\b/i.test(hm[1])) {
          add({ rule: 'PI-HIDDEN-COMMENT', severity: 'medium', category: 'prompt-injection', file: rel, line: lineOf(text, hm.index), why: 'Hidden HTML comment with instructions (invisible when rendered)', match: snippet(hm[1]) });
          break;
        }
      }
      const b64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{400,}={0,2}(?![A-Za-z0-9+/=])/.exec(text);
      if (b64 && !/data:[\w/+.-]+;base64,$/.test(text.slice(Math.max(0, b64.index - 40), b64.index))) add({ rule: 'OBF-BASE64-BLOB', severity: 'medium', category: 'obfuscation', file: rel, line: lineOf(text, b64.index), why: 'Large encoded blob inside instructions', match: `${b64[0].slice(0, 40)}…` });
    }
    if (name === 'package.json') {
      try {
        const scripts = JSON.parse(text).scripts || {};
        for (const hook of ['preinstall', 'install', 'postinstall']) {
          const cmd = scripts[hook]; if (!cmd) continue;
          const bad = /\b(curl|wget|iwr|Invoke-WebRequest|powershell|node\s+-e|python\s+-c|eval)\b|https?:\/\//i.test(cmd);
          const piped = /\|\s*(ba|z)?sh\b|\|\s*(iex|node|python)/i.test(cmd);
          add({ rule: 'SUPPLY-INSTALL-HOOK', severity: piped ? 'critical' : bad ? 'high' : 'low', category: 'supply-chain', file: rel, line: 0, why: bad ? 'npm install hook downloads or evals code' : 'npm install hook runs code on install', match: `${hook}: ${snippet(cmd)}` });
        }
      } catch {}
    }
  }
  return summarize(findings.filter((f) => f.severity), stats);
}

export function summarize(findings, stats = {}, external = null) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const score = Math.min(100, findings.reduce((a, f) => a + WEIGHT[f.severity], 0));
  let verdict = 'clean';
  if (counts.critical) verdict = 'blocked';
  else if (counts.high) verdict = 'review';
  else if (counts.medium) verdict = 'caution';
  if (external?.verdict === 'blocked') verdict = 'blocked';
  else if (external?.verdict === 'review' && verdict !== 'blocked') verdict = 'review';
  findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.file.localeCompare(b.file));
  return { verdict, score, counts, findings, stats, external, scannedAt: new Date().toISOString() };
}

// ---------- optional external scanners ----------
async function which(cmd) {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
  return r.code === 0 ? r.stdout.split(/\r?\n/)[0] : null;
}

export async function externalScan(dir, mode = 'auto') {
  if (mode === 'off') return null;
  const tmp = path.join(os.tmpdir(), `aivault-ext-${Date.now()}.json`);
  try {
    if ((mode === 'auto' || mode === 'skillspector') && await which('skillspector')) {
      const r = await run('skillspector', ['scan', dir, '--no-llm', '--format', 'json', '--output', tmp], { timeoutMs: 180000 });
      const j = (() => { try { return JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch { return null; } })();
      if (j) {
        const rec = j.risk_assessment?.recommendation; const sev = String(j.risk_assessment?.severity || '').toLowerCase();
        return { tool: 'NVIDIA SkillSpector', verdict: rec === 'DO_NOT_INSTALL' ? 'blocked' : rec === 'CAUTION' || sev === 'high' ? 'review' : 'clean',
          summary: `score ${j.risk_assessment?.score ?? '?'} · ${rec || sev || 'n/a'} · ${(j.issues || []).length} issues` };
      }
      if (r.code === 1) return { tool: 'NVIDIA SkillSpector', verdict: 'blocked', summary: 'DO_NOT_INSTALL (exit 1)' };
    }
    if ((mode === 'auto' || mode === 'cisco') && await which('skill-scanner')) {
      await run('skill-scanner', ['scan', dir, '--format', 'json', '--output', tmp], { timeoutMs: 180000 });
      const raw = (() => { try { return fs.readFileSync(tmp, 'utf8'); } catch { return ''; } })();
      if (raw) {
        const c = (s) => (raw.match(new RegExp(`"severity"\\s*:\\s*"${s}"`, 'gi')) || []).length;
        const crit = c('critical'), high = c('high');
        return { tool: 'Cisco skill-scanner', verdict: crit ? 'blocked' : high ? 'review' : 'clean', summary: `${crit} critical · ${high} high` };
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return null;
}

export async function scanSource(dir, { kind, external = 'auto' } = {}) {
  const base = scanDir(dir, { kind });
  const ext = await externalScan(dir, external);
  return ext ? summarize(base.findings, base.stats, ext) : base;
}

// ---------- reports ----------
export const ICON = { clean: '✓', caution: '·', review: '⚠', blocked: '⛔' };

export function formatReport(name, rep, { max = 12 } = {}) {
  const c = rep.counts;
  const out = [`Security ${ICON[rep.verdict]} ${rep.verdict.toUpperCase()} — ${name}: ${c.critical} critical · ${c.high} high · ${c.medium} medium · ${c.low} low (${rep.stats.files ?? '?'} files)`];
  if (rep.external) out.push(`  ${rep.external.tool}: ${rep.external.summary}`);
  for (const f of rep.findings.filter((x) => x.severity !== 'low').slice(0, max)) {
    out.push(`  [${f.severity}] ${f.rule} — ${f.why}\n           ${f.file}${f.line ? `:${f.line}` : ''}  “${f.match}”`);
  }
  const hidden = rep.findings.filter((x) => x.severity !== 'low').length - max;
  if (hidden > 0) out.push(`  … ${hidden} more in .vault/security/${name}.md`);
  return out;
}

export function saveReport(name, rep) {
  const dir = path.join(P.state, 'security');
  writeJSON(path.join(dir, `${name}.json`), rep);
  const lines = [`# Security report — ${name}`, '', `Verdict: **${rep.verdict}** · score ${rep.score}/100 · scanned ${rep.scannedAt}`, ''];
  if (rep.external) lines.push(`External: ${rep.external.tool} — ${rep.external.summary}`, '');
  lines.push('| Severity | Rule | File | Why | Match |', '|---|---|---|---|---|');
  for (const f of rep.findings) lines.push(`| ${f.severity} | ${f.rule} | \`${f.file}${f.line ? `:${f.line}` : ''}\` | ${f.why} | \`${f.match.replace(/[|`]/g, ' ')}\` |`);
  writeText(path.join(dir, `${name}.md`), lines.join('\n') + '\n');
}

export function loadReport(name) {
  try { return JSON.parse(fs.readFileSync(path.join(P.state, 'security', `${name}.json`), 'utf8')); } catch { return null; }
}
