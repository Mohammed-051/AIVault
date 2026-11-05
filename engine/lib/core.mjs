// Core helpers: vault paths, config, git, source parsing. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = process.env.AIVAULT_HOME
  ? path.resolve(process.env.AIVAULT_HOME)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const P = {
  config: path.join(ROOT, 'vault.json'),
  library: path.join(ROOT, 'library'),
  local: path.join(ROOT, 'local'),
  memory: path.join(ROOT, 'memory'),
  index: path.join(ROOT, 'index'),
  state: path.join(ROOT, '.vault'),
  catalog: path.join(ROOT, '.vault', 'catalog.json'),
  dashboard: path.join(ROOT, 'dashboard.md'),
  packs: path.join(ROOT, 'packs'),
  templates: path.join(ENGINE, 'templates'),
  engine: ENGINE,
};

export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ENGINE, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();

export const KINDS = ['skills', 'mcp', 'plugins', 'tools', 'catalogs'];

// Owners whose repos win name collisions (official sources first).
export const OFFICIAL_OWNERS = ['anthropics', 'modelcontextprotocol', 'github', 'vercel-labs', 'openai', 'microsoft', 'google'];

// ---------- small fs helpers ----------
export const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
export const abs = (relPath) => path.join(ROOT, ...relPath.split('/'));
export const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
export function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}
export function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.replace(/\r?\n/g, '\n'));
}
export function slug(s) {
  return String(s).toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}
export function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

// Remove a directory tree, clearing read-only bits (git pack files on Windows).
export function rmTree(p) {
  if (!exists(p)) return;
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); return; } catch { /* fall through */ }
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      try { fs.chmodSync(f, 0o666); } catch {}
      if (e.isDirectory() && !e.isSymbolicLink()) walk(f);
    }
  };
  walk(p);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

// ---------- config ----------
export const DEFAULT_CONFIG = {
  version: 1,
  name: 'My AIVault',
  sources: [],
  profiles: {
    code: {
      label: 'Code (any language, any stack)',
      domains: ['dev-core', 'frontend', 'backend', 'systems', 'embedded', 'mobile', 'data-ml', 'devops-security', 'agent-tooling'],
      load: [],
    },
    creative: {
      label: 'Writing, content, media, design, documents',
      domains: ['writing', 'content-marketing', 'media', 'design', 'documents'],
      load: [],
    },
    default: { label: 'Everything else', load: [] },
  },
  pins: [],
  overrides: {},
  sourceDefaults: {},
  budget: { maxSkillsPerTask: 3, descChars: 150 },
  // block: 'critical' (default) or 'high'. external: 'auto' | 'skillspector' | 'cisco' | 'off'
  security: { block: 'critical', external: 'auto' },
  // Skill Lock. hold: 'permissions' (default) holds updates that add permissions or worsen the scan verdict;
  // 'code' also holds updates that change bundled scripts; 'any' holds every change for review.
  lock: { hold: 'permissions' },
};

export function loadConfig() {
  const cfg = readJSON(P.config, null);
  if (!cfg) return structuredClone(DEFAULT_CONFIG);
  return { ...structuredClone(DEFAULT_CONFIG), ...cfg, budget: { ...DEFAULT_CONFIG.budget, ...(cfg.budget || {}) }, security: { ...DEFAULT_CONFIG.security, ...(cfg.security || {}) }, lock: { ...DEFAULT_CONFIG.lock, ...(cfg.lock || {}) } };
}
export function saveConfig(cfg) { writeJSON(P.config, cfg); }

// ---------- git ----------
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        windowsHide: true,
      });
    } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e) }); return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}
const GITC = ['-c', 'core.longpaths=true', '-c', 'advice.detachedHead=false'];
export const git = (args, cwd, timeoutMs = 600000) => run('git', [...GITC, ...args], { cwd, timeoutMs });

export async function gitAvailable() { return (await run('git', ['--version'])).code === 0; }
export async function gitHead(dir) { const r = await git(['rev-parse', '--short', 'HEAD'], dir); return r.code === 0 ? r.stdout : null; }
export async function gitHeadFull(dir) { const r = await git(['rev-parse', 'HEAD'], dir); return r.code === 0 ? r.stdout : null; }
export async function remoteHead(url, ref) {
  const r = await git(['ls-remote', url, ref || 'HEAD'], undefined, 60000);
  return r.code === 0 && r.stdout ? r.stdout.split(/\s+/)[0] : null;
}
export async function gitRemote(dir) { const r = await git(['remote', 'get-url', 'origin'], dir); return r.code === 0 ? r.stdout : null; }

// ---------- source parsing ----------
const GENERIC_REPO = new Set(['skills', 'claude-skills', 'agent-skills', 'agents', 'servers', 'plugins', 'tools', 'prompts', 'mcp', 'mcp-servers', 'dotfiles', 'claude', 'config']);

// Accepts: owner/repo · https://github.com/o/r(.git) · .../tree/<ref>/<subdir> · .../blob/<ref>/<file>
//          any git URL (https/ssh, GitLab, Bitbucket) · a local folder path
export function parseSource(input) {
  const s = String(input || '').trim().replace(/[)>\].,]+$/, '');
  if (!s) throw new Error('No source given.');
  if (exists(s) && fs.statSync(s).isDirectory()) {
    const p = path.resolve(s);
    return { type: 'local', path: p, name: slug(path.basename(p)) };
  }
  let m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) return gh(m[1], m[2]);
  m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?/i);
  if (m) {
    const src = gh(m[1], m[2]);
    if (m[4]) src.ref = m[4];
    if (m[5]) {
      let sub = decodeURIComponent(m[5]).replace(/\/+$/, '');
      if (m[3] === 'blob') sub = sub.split('/').slice(0, -1).join('/');
      if (sub) { src.subdir = sub; src.name = slug(sub.split('/').pop()); }
    }
    return src;
  }
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s)) {
    const last = s.replace(/\.git$/, '').split(/[/:]/).filter(Boolean);
    const repo = last.pop(); const owner = last.pop() || '';
    return { type: 'git', url: s, owner, repo, name: nameFor(owner, repo) };
  }
  throw new Error(`Can't read "${s}" as a repo. Use owner/repo, a GitHub/Git URL, or a local folder.`);
}
function gh(owner, repo) {
  repo = repo.replace(/\.git$/, '');
  return { type: 'git', url: `https://github.com/${owner}/${repo}.git`, owner, repo, name: nameFor(owner, repo) };
}
export function nameFor(owner, repo) {
  const r = slug(repo);
  return GENERIC_REPO.has(r) || r.startsWith('awesome') ? slug(`${owner}-${repo}`) : r;
}
export function sourceKey(src) {
  return src.type === 'local' ? `local:${src.path}` : `${String(src.url).toLowerCase().replace(/\.git$/, '')}#${src.subdir || ''}`;
}
