import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempVault } from './helpers.mjs';

const VAULT = tempVault();
const pkg = (name, files) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aivault-pkg-')), name);
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  return dir;
};
const skill = (name, desc, body = '') => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n${body}\n`;
const agent = (name, desc, tools) => `---\nname: ${name}\ndescription: ${desc}\n${tools === undefined ? '' : `tools: ${tools}\n`}---\nYou are ${name}.\n`;
let cmd; const read = (f) => fs.readFileSync(path.join(VAULT, f), 'utf8');

before(async () => {
  cmd = await import('../engine/lib/commands.mjs');
  cmd.init();
  await cmd.add(pkg('alpha', {
    'skills/writing-plans/SKILL.md': skill('writing-plans', 'Write an implementation plan and task breakdown before touching code.'),
    'skills/test-driven-development/SKILL.md': skill('test-driven-development', 'Write a failing test first, then make it pass. Red green refactor for any feature or bugfix.'),
    'skills/requesting-code-review/SKILL.md': skill('requesting-code-review', 'Request a code review of your changes before merging.'),
    'skills/laravel-tdd/SKILL.md': skill('laravel-tdd', 'Laravel testing with PHPUnit and Pest: test-driven development for Laravel apps.'),
    'agents/code-reviewer.md': agent('code-reviewer', 'Reviews code for quality, security and maintainability after changes.', 'Read, Grep, Glob'),
    'agents/web-researcher.md': agent('web-researcher', 'Researches libraries and APIs on the web before implementation.', 'Read, WebFetch, WebSearch, Bash'),
    'agents/do-anything.md': agent('do-anything', 'General helper for implementing features.'),
    'skills/constructor/SKILL.md': skill('constructor', 'Explains the constructor and toString of JavaScript classes (hasOwnProperty, valueOf, __proto__).'),
  }), { name: 'alpha' });
  await cmd.add(pkg('beta', {
    'skills/tdd-workflow/SKILL.md': skill('tdd-workflow', 'Test-driven development workflow: write a failing test first, watch it fail, then implement the smallest change.'),
  }), { name: 'beta' });
});

test('subagents are indexed with permissions from their tools line', () => {
  const idx = read('index/agents.md');
  assert.match(idx, /\*\*code-reviewer\*\*/);
  assert.match(idx, /\*\*web-researcher\*\* \{net\}/);
  assert.match(idx, /\*\*do-anything\*\* \{all-tools\}/);
  assert.match(read('dashboard.md'), /index\/agents\.md/);
  assert.match(read('dashboard.md'), /act as the manager/);
});

test('plan gives a phase-by-phase playbook and leaves out skills for another stack', () => {
  const p = cmd.plan('add an orders endpoint to my Express API').join('\n');
  assert.match(p, /Plan — [\s\S]*writing-plans/);
  assert.match(p, /test-driven-development|tdd-workflow/);
  assert.match(p, /Review — [\s\S]*(requesting-code-review|code-reviewer)/);
  assert.doesNotMatch(p, /laravel-tdd/);
  assert.match(cmd.plan('add an orders page to my Laravel app').join('\n'), /laravel-tdd/);
});

test('route with a phase returns that phase\'s skills and an agent', () => {
  const r = cmd.routeTask('add an orders endpoint to my Express API', { phase: 'review' }).join('\n');
  assert.match(r, /Phase: Review/);
  assert.match(r, /code-reviewer/);
  assert.throws(() => cmd.routeTask('x', { phase: 'nope' }), /phase must be one of/);
});

test('overlaps finds look-alikes across packages; prefer picks the winner', () => {
  const o = cmd.overlaps().join('\n');
  assert.match(o, /test-driven-development/);
  assert.match(o, /tdd-workflow/);
  assert.doesNotMatch(o, /laravel-tdd[\s\S]*tdd-workflow[\s\S]*vault prefer/); // specialized skill is not lumped in
  cmd.prefer('tdd-workflow');
  const idx = fs.readdirSync(path.join(VAULT, 'index')).map((f) => read(`index/${f}`)).join('\n');
  assert.match(idx, /\*\*tdd-workflow\*\*/);
  assert.doesNotMatch(idx, /\*\*test-driven-development\*\*/);
  const r = cmd.routeTask('test driven development for my feature').join('\n');
  assert.match(r, /tdd-workflow/);
  assert.doesNotMatch(r, /- test-driven-development/);
  cmd.unprefer('tdd-workflow');
  assert.match(fs.readdirSync(path.join(VAULT, 'index')).map((f) => read(`index/${f}`)).join('\n'), /\*\*test-driven-development\*\*/);
});

test('words like "constructor" or "toString" are plain words, not object internals', async () => {
  assert.match(cmd.routeTask('constructor toString valueOf').join('\n'), /constructor/);
  assert.ok(Array.isArray(cmd.overlaps()));
  assert.match((await cmd.doctor()).join('\n'), /All good|problem/);
});

test('usage counts what agents actually open', () => {
  const cat = JSON.parse(read('.vault/catalog.json'));
  const sk = cat.skills.find((s) => s.name === 'writing-plans');
  cmd.readFile(sk.path); cmd.readFile(sk.path);
  assert.match(cmd.usage().join('\n'), /2×\s+writing-plans/);
});

test('link installs an agent for Claude Code and unlink removes it', () => {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'aivault-agents-'));
  assert.match(cmd.link('code-reviewer', { to }).join('\n'), /Installed agent code-reviewer/);
  assert.ok(fs.existsSync(path.join(to, 'code-reviewer.md')));
  cmd.unlink('code-reviewer');
  assert.ok(!fs.existsSync(path.join(to, 'code-reviewer.md')));
});
