import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, nameFor, slug } from '../engine/lib/core.mjs';

test('parses owner/repo shorthand', () => {
  const s = parseSource('mattpocock/skills');
  assert.equal(s.url, 'https://github.com/mattpocock/skills.git');
  assert.equal(s.name, 'mattpocock-skills'); // generic repo names get the owner prefix
});

test('parses GitHub tree URL into a sparse subfolder source', () => {
  const s = parseSource('https://github.com/anthropics/skills/tree/main/skills/frontend-design');
  assert.equal(s.ref, 'main');
  assert.equal(s.subdir, 'skills/frontend-design');
  assert.equal(s.name, 'frontend-design');
});

test('parses blob URL to a SKILL.md as its folder', () => {
  const s = parseSource('https://github.com/a/b/blob/main/skills/pdf/SKILL.md');
  assert.equal(s.subdir, 'skills/pdf');
});

test('accepts generic git URLs and strips trailing punctuation', () => {
  assert.equal(parseSource('git@gitlab.com:team/tools.git').name, 'team-tools');
  assert.equal(parseSource('https://github.com/blader/humanizer).').repo, 'humanizer');
});

test('rejects junk', () => {
  assert.throws(() => parseSource('not a repo!!'));
});

test('naming helpers', () => {
  assert.equal(nameFor('win4r', 'Awesome-Claude-MCP-Servers'), 'win4r-awesome-claude-mcp-servers');
  assert.equal(nameFor('blader', 'humanizer'), 'humanizer');
  assert.equal(slug('Hello World!.git'), 'hello-world');
});
