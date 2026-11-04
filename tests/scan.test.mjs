import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatter, cleanDesc, classify } from '../engine/lib/scan.mjs';
import { tokenize } from '../engine/lib/search.mjs';

test('reads folded YAML frontmatter', () => {
  const { data } = frontmatter('---\nname: x\ndescription: >\n  first line\n  second line\n---\nbody');
  assert.equal(data.name, 'x');
  assert.equal(data.description, 'first line second line');
});

test('cleans descriptions to one capped line', () => {
  const d = cleanDesc('Use **this** [skill](http://x) <b>now</b>\n\n' + 'word '.repeat(100), 60);
  assert.ok(d.length <= 61 && !d.includes('*') && !d.includes('<'));
});

test('classifies skills into domains', () => {
  assert.equal(classify('embedded-systems', 'firmware for ESP32 and FreeRTOS', '').domain, 'embedded');
  assert.equal(classify('humanizer', 'Remove signs of AI-generated writing', '').domain, 'writing');
  assert.equal(classify('pptx', 'create PowerPoint slides and presentations', '').domain, 'documents');
  assert.equal(classify('cro', 'improve landing page conversion and SEO copywriting', '').domain, 'content-marketing');
});

test('tokenizer stems and expands synonyms', () => {
  const t = tokenize('Stalled tasks in my C++ deck');
  assert.ok(t.includes('stall') && t.includes('cpp') && t.includes('pptx'));
});
