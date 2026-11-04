import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempVault, FIX, REPO } from './helpers.mjs';

const VAULT = tempVault();
let cmd;
before(async () => { cmd = await import('../engine/lib/commands.mjs'); cmd.init(); });

test('adds a clean local skill folder and routes to it', async () => {
  const out = (await cmd.add(path.join(FIX, 'benign-skill'))).join('\n');
  assert.match(out, /Added "benign-skill"/);
  assert.ok(fs.existsSync(path.join(VAULT, 'dashboard.md')));
  assert.match(cmd.routeTask('defend my app against prompt injection').join('\n'), /prompt-safety/);
});

test('refuses a malicious skill and leaves nothing behind', async () => {
  const out = (await cmd.add(path.join(FIX, 'malicious-skill'))).join('\n');
  assert.match(out, /BLOCKED/);
  assert.match(out, /Not added/);
  const cfg = JSON.parse(fs.readFileSync(path.join(VAULT, 'vault.json'), 'utf8'));
  assert.ok(!cfg.sources.some((s) => s.name === 'malicious-skill'));
});

test('vault_read stays inside the vault', () => {
  assert.match(cmd.readFile('dashboard.md').join('\n'), /Router/);
  assert.throws(() => cmd.readFile('../../../../etc/hosts'), /outside the vault|Not found/);
});

test('project memory: create, append, read', () => {
  cmd.newProject('Test Project', { type: 'writing' });
  cmd.memory('append', 'test-project', 'drafted chapter 1');
  assert.match(cmd.memory('read', 'test-project').join(''), /drafted chapter 1/);
});

test('MCP server answers initialize and lists tools', async () => {
  const child = spawn(process.execPath, [path.join(REPO, 'engine', 'mcp.mjs')], { env: { ...process.env, AIVAULT_HOME: VAULT } });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 800));
  child.kill();
  const list = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['vault_route', 'vault_read', 'vault_memory', 'vault_add', 'vault_scan']) assert.ok(names.includes(n));
  assert.ok(!JSON.stringify(list.result.tools.find((t) => t.name === 'vault_add').inputSchema).includes('allowRisky'));
});
