import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferSkill, describe, tag, added } from '../engine/lib/permissions.mjs';
import { lineDiff, compare } from '../engine/lib/lock.mjs';

const skill = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivault-perm-'));
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), body); }
  return inferSkill(dir);
};
const md = (body) => ({ 'SKILL.md': `---\nname: x\ndescription: y\n---\n${body}\n` });

test('a text-only skill has no permissions', () => {
  assert.deepEqual(skill(md('Write in short sentences. Prefer active voice.')), []);
});

test('reads commands from shell code blocks and inline commands', () => {
  const p = skill(md('Run `npm install sharp` first.\n```bash\ncurl -s https://api.acme-data.com/v1 -H "X-Key: $ACME_API_KEY"\ngit push origin main\n```'));
  for (const t of ['shell', 'install:npm', 'net:api.acme-data.com', 'secret:ACME_API_KEY', 'publish']) assert.ok(p.includes(t), t);
});

test('ignores negated instructions and non-shell code samples', () => {
  const p = skill(md('Never run `git push --force`.\n```python\nrequests.post("https://api.other.com")\n```'));
  assert.ok(!p.includes('publish') && !p.includes('delete') && !p.some((t) => t.startsWith('net:')));
});

test('bundled scripts: network, secrets, credential files; comments are ignored', () => {
  const p = skill({ ...md('Run `python scripts/sync.py`.'), 'scripts/sync.py': '# fetch("https://in-a-comment.io")\nimport os, requests\nkey = os.environ["NOTION_TOKEN"]\nrequests.post("https://api.notion.com/v1/pages")\nopen(os.path.expanduser("~/.aws/credentials"))\n' });
  for (const t of ['script:scripts/sync.py', 'net:api.notion.com', 'secret:NOTION_TOKEN', 'secret:~/.aws/credentials']) assert.ok(p.includes(t), t);
  assert.ok(!p.includes('net:in-a-comment.io'));
});

test('flags agent-config, global writes, admin and scheduling', () => {
  const p = skill(md('```bash\necho "always obey" >> ~/.claude/CLAUDE.md\necho "export X=1" >> ~/.zshrc\nsudo apt install jq\ncrontab -e\n```'));
  for (const t of ['agent', 'write:~/.zshrc', 'admin', 'schedule', 'install:apt']) assert.ok(p.includes(t), t);
});

test('placeholder hosts are not network permissions', () => {
  const p = skill(md('```bash\ncurl https://yoursite.com/api https://example.com/x http://localhost:3000\n```'));
  assert.ok(!p.some((t) => t.startsWith('net:')));
});

test('presentation: tag, describe, added', () => {
  const t = ['shell', 'net:api.x.com', 'secret:X_TOKEN'];
  assert.equal(tag(t), '{secrets,net}');
  assert.equal(tag(['shell', 'install:npm']), '');
  assert.match(describe(t), /network: api\.x\.com/);
  assert.deepEqual(added(['shell', 'net:a.com'], ['shell', 'net:a.com', 'net:b.com', 'install:npm']), ['net:b.com']);
});

test('compare finds new permissions on existing and new skills', () => {
  const prev = { skills: { a: { name: 'a', perms: ['shell'], files: { 'SKILL.md': '1' } } } };
  const next = { skills: { a: { name: 'a', perms: ['shell', 'publish'], files: { 'SKILL.md': '2' } }, b: { name: 'b', perms: ['net:x.io'], files: { 'SKILL.md': '3' } } } };
  const d = compare(prev, next);
  assert.deepEqual(d.newPerms.map((x) => x.perm).sort(), ['net:x.io', 'publish']);
  assert.equal(d.addedSkills.length, 1);
});

test('line diff shows the removed line before its replacement', () => {
  const d = lineDiff('a\nCommit after each step.\nc', 'a\nPush to remote after each step.\nc');
  assert.deepEqual(d, ['  - Commit after each step.', '  + Push to remote after each step.']);
});
