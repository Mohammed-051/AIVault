// Scan a cloned repo: find skills, detect what kind of thing it is, classify into domains.
// Reads files only. Never executes anything from the repo. Skips symlinks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DOMAINS } from './domains.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv',
  '__pycache__', 'coverage', 'test', 'tests', '__tests__', 'fixtures', 'deprecated', 'archive', 'archived',
  'in-progress', 'wip', 'drafts', 'legacy', '.github', '.vscode', '.idea']);

function walk(dir, depth, onFile, maxDepth = 9) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase())) walk(full, depth + 1, onFile, maxDepth);
    } else if (e.isFile()) onFile(full, e.name, depth);
  }
}

// Minimal YAML frontmatter reader: key: value, quoted values, and > / | blocks.
export function frontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { data: {}, body: text };
  const data = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, val] = kv;
    if (/^[>|][+-]?$/.test(val.trim()) || val.trim() === '') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      val = block.join(' ').trim();
    }
    data[key] = val.replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: text.slice(m[0].length) };
}

export function cleanDesc(s, max = 150) {
  let t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t;
}

function firstParagraph(md) {
  const lines = md.replace(/```[\s\S]*?```/g, '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (out.length) break; else continue; }
    if (/^(#|<|!\[|\[!\[|---|\||-\s*\[|>\s*\[!)/.test(t)) { if (out.length) break; continue; }
    out.push(t);
  }
  return out.join(' ');
}

// ---------- classification ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RX = DOMAINS.map((d) => ({ id: d.id, rx: d.keywords.map((k) => new RegExp(`(^|[^a-z0-9+])${esc(k)}`, 'i')) }));

export function classify(name, desc, relPath) {
  const scores = {};
  const fields = [[name.replace(/[-_]/g, ' '), 3], [relPath.replace(/[/_-]/g, ' '), 1.5], [desc, 1]];
  for (const d of RX) {
    let s = 0;
    for (const rx of d.rx) for (const [text, w] of fields) if (rx.test(text)) s += w;
    if (s) scores[d.id] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { domain: null, domains: [], score: 0 };
  const top = ranked[0][1];
  const domains = ranked.filter(([, s]) => s >= Math.max(2, top * 0.75)).slice(0, 2).map(([id]) => id);
  return { domain: ranked[0][0], domains: domains.length ? domains : [ranked[0][0]], score: top };
}

// ---------- repo scan ----------
export function scanRepo(root, opts = {}) {
  const descMax = opts.descChars || 150;
  const skills = []; const pkgs = []; const pyprojects = [];
  let hasServerJson = false, hasPlugin = false, readme = null, fileCount = 0;

  walk(root, 0, (full, name, depth) => {
    fileCount++;
    const lower = name.toLowerCase();
    if (lower === 'skill.md') skills.push(full);
    else if (lower === 'package.json' && depth <= 2) pkgs.push(full);
    else if (lower === 'pyproject.toml' && depth <= 2) pyprojects.push(full);
    else if (lower === 'server.json' && depth <= 1) hasServerJson = true;
    else if ((lower === 'plugin.json' || lower === 'marketplace.json') && full.includes('.claude-plugin')) hasPlugin = true;
    else if (lower === 'readme.md' && depth === 0) readme = full;
  });

  // Skills (dedupe identical content and same-name copies inside one repo; keep the shallowest path).
  const byName = new Map();
  for (const f of skills.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const { data, body } = frontmatter(text);
    const dirName = path.basename(path.dirname(f));
    const name = (data.name && /^[\w .:-]{1,80}$/.test(data.name) ? data.name : dirName).trim();
    const key = name.toLowerCase().replace(/\s+/g, '-');
    if (byName.has(key)) continue;
    const relPath = path.relative(root, f).split(path.sep).join('/');
    const desc = cleanDesc(data.description || firstParagraph(body), descMax);
    if (/^template(-skill)?$/i.test(name) || /^replace with/i.test(desc)) continue;
    const internal = relPath.split('/').slice(0, -1).some((seg) => seg.startsWith('.'));
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    byName.set(key, { name, desc, relPath, hash, internal, bytes: Buffer.byteLength(text), ...classify(name, desc, relPath) });
  }

  // Kind signals
  let mcp = hasServerJson; const mcpServers = [];
  for (const f of pkgs) {
    const j = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } })();
    const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.peerDependencies || {}) };
    const isMcp = !!j.mcpName || Object.keys(deps).some((d) => d.startsWith('@modelcontextprotocol/sdk') || d === 'fastmcp');
    if (isMcp) {
      mcp = true;
      if (j.name && !j.private) mcpServers.push({ name: j.name, dir: path.relative(root, path.dirname(f)).split(path.sep).join('/'), run: `npx -y ${j.name}` });
    }
  }
  for (const f of pyprojects) {
    const t = (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })();
    if (/["']mcp[\[>=<~"' ]|fastmcp/i.test(t) && /\[project\]/.test(t)) {
      const n = (t.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1];
      if (/mcp/i.test(n || '') || /mcp/i.test(path.basename(path.dirname(f)))) {
        mcp = true;
        if (n) mcpServers.push({ name: n, dir: path.relative(root, path.dirname(f)).split(path.sep).join('/'), run: `uvx ${n}` });
      }
    }
  }
  const base = String(opts.repoName || path.basename(root)).toLowerCase();
  const readmeText = readme ? fs.readFileSync(readme, 'utf8') : '';
  const linkCount = (readmeText.match(/\]\(https?:\/\//g) || []).length;
  const isCatalog = /^awesome|awesome-/.test(base) || (linkCount > 80 && fileCount < 40);
  if (!mcp && !isCatalog && /(^|-)mcp(-|$)/.test(base) && /mcp server/i.test(readmeText)) mcp = true;

  // Kind: an MCP server with few public skills is a connector (its .claude/.agents skills are usually
  // for the repo's own maintainers). Big skill collections stay skills even if they ship an MCP server.
  const all = [...byName.values()];
  const pub = all.filter((s) => !s.internal).length;
  let kind = 'tools';
  if (mcp && pub < 10) kind = 'mcp';
  else if (all.length >= 3) kind = 'skills';
  else if (isCatalog) kind = 'catalogs';
  else if (all.length >= 1) kind = 'skills';
  else if (hasPlugin) kind = 'plugins';

  const summary = cleanDesc(firstParagraph(readmeText), 200);
  return {
    kind, skills: all, plugin: hasPlugin, mcp, mcpServers, catalog: isCatalog,
    readme: readme ? path.relative(root, readme).split(path.sep).join('/') : null, summary,
    repoClass: classify(base, summary, ''),
  };
}
