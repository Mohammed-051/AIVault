// Keyword search (BM25) over the catalog, the task router and the phase planner.
// Used by `vault search`, `vault route`, `vault plan` and the vault_route / vault_plan MCP tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P, readJSON } from './core.mjs';
import { domainById } from './domains.mjs';
import { tag } from './permissions.mjs';
import { PHASES, phaseById } from './phases.mjs';
import { classify } from './scan.mjs';

const STOP = new Set('a an and are as at be by for from how i in is it its my me of on or so that the this to we with you your want need help please can could should would do does using use make build create work working after before about into some any just get got new few minutes minute set up'.split(' '));
const SYN = {
  esp: ['esp32'], cpp: ['c++'], js: ['javascript'], ts: ['typescript'], ui: ['frontend'], ux: ['design'],
  ppt: ['pptx'], deck: ['pptx', 'slides'], slides: ['pptx'], doc: ['docx'], word: ['docx'], spreadsheet: ['xlsx', 'excel'],
  robotic: ['humanize'], humanlike: ['humanize'], blog: ['article'], tweet: ['twitter'], db: ['database'], ml: ['machine'],
  tdd: ['test', 'driven'], e2e: ['end', 'test'], pr: ['pull', 'request'], i18n: ['internationalization'], a11y: ['accessibility'],
  stall: ['hang', 'debug'], crash: ['debug'], freeze: ['hang', 'debug'], bug: ['debug'], vid: ['video'],
};
// Light stemming so "stalls/stalled/stalling" and "humanize/humanizing" match, without prefix false-positives.
const stem = (t) => t.length <= 4 ? t : t.replace(/(ization|isation|ations|ation|ings|ing|izes|ized|ize|ises|ised|ise|ers|er|ates|ate|ies|es|ed|ly|s)$/, '') || t;
export const tokenize = (s) => String(s || '').toLowerCase().replace(/c\+\+/g, ' cpp ').split(/[^a-z0-9]+/)
  .filter((t) => t.length > 1 && !STOP.has(t)).flatMap((t) => [t, ...(SYN[t] || [])]).map(stem);

const FAMILY_WORDS = new Set(['automation', 'skill', 'integration', 'expert', 'pro'].map(stem));

// BM25 over any list of catalog items. Returns every item with its raw score and match details.
function bm25(items, query) {
  const q = [...new Set(tokenize(query))];
  const docs = items.map((s) => {
    const name = tokenize(s.name.replace(/[-_]/g, ' '));
    const body = tokenize(`${s.desc} ${s.domains.map((d) => domainById[d]?.title).join(' ')}`);
    return { s, name, body, len: name.length * 3 + body.length };
  });
  const N = docs.length || 1; const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = Object.fromEntries(q.map((t) => [t, docs.filter((d) => d.name.includes(t) || d.body.includes(t)).length]));
  const k1 = 1.2, b = 0.75;
  return {
    q, N, df,
    rows: docs.map((d) => {
      let score = 0; let matched = 0; const nameMatched = new Set();
      for (const t of q) {
        const nt = d.name.filter((x) => x === t).length;
        const tf = nt * 3 + d.body.filter((x) => x === t).length;
        if (!tf) continue;
        matched++; if (nt) nameMatched.add(t);
        const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / avg));
      }
      const core = d.name.filter((x) => !FAMILY_WORDS.has(x));
      const fullName = core.length > 0 && core.every((x) => nameMatched.has(x));
      return { d, score, matched, nameMatched, fullName };
    }),
  };
}

// The user's choice between look-alike skills (vault prefer): show the winner instead of the others.
function applyPreferences(results, catalog, pool) {
  const byId = new Map((pool || [...catalog.skills, ...(catalog.agents || [])]).map((s) => [s.id, s]));
  const out = []; const seen = new Set();
  for (const r of results) {
    const winner = r.deferTo && byId.get(r.deferTo);
    const pick = winner ? { ...winner, score: r.score, preferredOver: r.id } : r;
    if (seen.has(pick.id)) continue;
    seen.add(pick.id); out.push(pick);
  }
  return out;
}

export function search(query, { limit = 8, catalog = readJSON(P.catalog, null), items } = {}) {
  if (!catalog) throw new Error('No catalog yet. Run `vault index`.');
  const pool = (items || catalog.skills).filter((s) => !s.dupOf);
  const { q, N, df, rows } = bm25(pool, query);
  if (!q.length) return [];
  const scored = rows.map(({ d, score, matched, nameMatched, fullName }) => {
    // Family members (e.g. 800 "<app>-automation" skills) surface only when the app itself is named in full.
    if (d.s.family && !fullName) score = 0;
    // One weak word in a description is noise: need a rare/full name hit or two distinct matching words.
    const strongName = fullName || [...nameMatched].some((t) => df[t] <= Math.max(5, N * 0.01));
    if (!strongName && matched < Math.min(2, q.length)) score = 0;
    return { ...d.s, score: +score.toFixed(2) };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 0;
  return applyPreferences(scored.filter((r) => r.score >= Math.max(0.3, top * 0.4)), catalog).slice(0, limit);
}

// ---------- helpers shared by route and plan ----------
const findIn = (catalog) => (id) => catalog.skills.find((s) => s.id === id) || catalog.skills.find((s) => s.name.toLowerCase() === String(id).toLowerCase());

function projectFor(catalog, words) {
  return catalog.projects.find((p) => { const t = tokenize(p.title); return t.some((x) => words.has(x)) && t.filter((x) => words.has(x)).length >= Math.min(2, t.length); });
}

// Which domains is this task about? Votes from pins and the best matching skills.
function taskDomains(task, cfg, catalog) {
  const words = new Set(tokenize(task)); const find = findIn(catalog);
  const hits = search(task, { limit: 9, catalog });
  const pins = (cfg.pins || []).map((p) => ({ p, n: tokenize(p.when).filter((t) => words.has(t)).length }))
    .filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 2).map((x) => x.p);
  const votes = {};
  pins.forEach((p) => p.load.map(find).filter(Boolean).forEach((s) => s.domains.forEach((d) => { votes[d] = (votes[d] || 0) + 10; })));
  hits.slice(0, 5).forEach((h, i) => h.domains.forEach((d) => { votes[d] = (votes[d] || 0) + (5 - i); }));
  // The task's own words count too, so a small or new vault still knows "Express API" is backend work.
  for (const d of classify('', task, '').domains) votes[d] = (votes[d] || 0) + 4;
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([d]) => d);
  return { hits, pins, domains: ranked.slice(0, 2), top: ranked[0] };
}

function baseSkills(cfg, catalog, topDomain) {
  const prof = Object.values(cfg.profiles || {}).find((p) => p.domains && p.domains.includes(topDomain)) || cfg.profiles?.default;
  return { prof, base: (prof?.load || []).map(findIn(catalog)).filter(Boolean) };
}

export const agentInstalled = (a) => fs.existsSync(path.join(os.homedir(), '.claude', 'agents', `${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`));

// Words that describe *how* a skill works rather than *what technology* it is for. A skill whose name
// has any other word the task doesn't mention ("laravel-tdd", "uspto-database") is specialized for
// something else, so it only shows up when the task names it.
const PROCESS = new Set([...PHASES.flatMap((p) => p.keywords.map((k) => k.replace(/!$/, ''))),
  'driven', 'systematic', 'requesting', 'receiving', 'finishing', 'branch', 'dispatching', 'parallel', 'subagent', 'worktrees', 'completion',
  'verification', 'executing', 'writing', 'skill', 'workflow', 'process', 'guide', 'best', 'practices', 'agent', 'code', 'general', 'core',
  'continuous', 'loop', 'patterns', 'pattern', 'development', 'developer', 'engineering', 'engineer', 'specialist', 'expert', 'checklist',
  'strategist', 'content', 'copy', 'article', 'blog', 'long', 'form', 'technical', 'project', 'feature', 'task', 'tasks', 'work', 'session',
  'web', 'app', 'software', 'system', 'end', 'full', 'stack', 'quality', 'gate', 'update', 'updater', 'writer', 'manager', 'lead', 'chief',
  'staff', 'senior', 'principal', 'assistant', 'helper', 'brand', 'voice', 'marketing', 'product', 'user', 'customer', 'team', 'change', 'changes',
].flatMap((w) => tokenize(w)));
const specializedFor = (s, taskWords) => tokenize(s.name.replace(/[-_]/g, ' ')).filter((t) => !PROCESS.has(t) && !taskWords.has(t));

// Best items for one phase of a task. Task-specific matches come first; general process skills for the
// phase (TDD, planning, code review, editing…) fill the rest. Skills built for another stack never do.
export function forPhase(items, phase, task, domains, catalog, limit) {
  const ph = phaseById[phase];
  const pool = items.filter((s) => !s.dupOf && !s.family && (s.phases || []).includes(phase));
  if (!pool.length) return [];
  const t = bm25(pool, task); const p = bm25(pool, `${ph.title} ${ph.does}`).rows;
  const qn = t.q.length; const taskWords = new Set(t.q);
  const ranked = t.rows.map((row, i) => {
    const s = row.d.s;
    const inDomain = s.domains.some((d) => domains.includes(d));
    const taskHit = (qn && row.matched >= Math.min(2, qn)) || row.fullName;
    const foreign = specializedFor(s, taskWords).length > 0;
    const codeTask = domains.some((d) => CODE.has(d));
    const general = !foreign && (inDomain || (codeTask && (s.domains.includes('productivity') || s.domains.includes('dev-core'))));
    if (!(taskHit && (!foreign || row.fullName)) && !general) return null;
    if (s.kind === 'agent' && !general && !row.fullName) return null; // agents must fit the kind of work, not just share words
    const score = 3 * row.score + p[i].score + (inDomain ? 1 : 0) + (s.phases[0] === phase ? 1 : 0) + (taskHit ? 2 : 0);
    return { ...s, score: +score.toFixed(2) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  return applyPreferences(ranked, catalog).slice(0, limit);
}
const CODE = new Set(['dev-core', 'frontend', 'backend', 'systems', 'embedded', 'mobile', 'data-ml', 'devops-security', 'agent-tooling', 'integrations']);

const line = (s) => { const t = tag(s.perms); return `${s.id}${t ? ` ${t}` : ''} — ${s.desc.length > 120 ? s.desc.slice(0, 117).replace(/\s+\S*$/, '') + '…' : s.desc}\n     ${s.path}`; };
const agentLine = (a) => `${line(a)}${agentInstalled(a) ? '\n     (installed in Claude Code: delegate with the Task tool)' : ''}`;

// ---------- route: what to load now ----------
export function route(task, cfg, { limit = 5, phase } = {}) {
  const catalog = readJSON(P.catalog, null);
  if (!catalog) throw new Error('No catalog yet. Run `vault index`.');
  if (phase && !phaseById[phase]) throw new Error(`phase must be one of: ${PHASES.map((p) => p.id).join(', ')}`);
  const words = new Set(tokenize(task)); const find = findIn(catalog);
  const lines = [`Vault root: ${catalog.root}`];
  const project = projectFor(catalog, words);
  if (project) lines.push(`Project memory: ${project.file}${project.filled ? '' : ' (still empty — ask the user for context)'}`);

  const { hits, pins, domains, top } = taskDomains(task, cfg, catalog);
  const { prof, base } = baseSkills(cfg, catalog, top);
  if (base.length) lines.push(`Base skills (${prof.label}): ${base.map((s) => s.path).join(' ; ')}`);
  for (const pin of pins) lines.push(`Pinned route "${pin.when}": ${pin.load.map(find).filter(Boolean).map((s) => s.path).join(' ; ')}`);
  const shown = new Set([...base, ...pins.flatMap((p) => p.load.map(find).filter(Boolean))].map((s) => s.id));

  if (phase) {
    const ph = phaseById[phase];
    lines.push(`Phase: ${ph.title} — ${ph.does}`);
    const sk = forPhase(catalog.skills, phase, task, domains, catalog, limit).filter((s) => !shown.has(s.id)).slice(0, 3);
    const ag = forPhase(catalog.agents || [], phase, task, domains, catalog, 2);
    lines.push(sk.length ? 'Skills for this phase (load at most 2):' : 'No phase-specific skill. Use the base skills and your judgment.');
    for (const s of sk) lines.push(`- ${line(s)}`);
    if (ag.length) { lines.push('Agent to hand this phase to (optional):'); for (const a of ag) lines.push(`- ${agentLine(a)}`); }
  } else {
    const rest = hits.filter((h) => !shown.has(h.id)).slice(0, limit);
    if (rest.length) {
      lines.push('Candidate skills (pick at most 2, open the path):');
      for (const h of rest) { const t = tag(h.perms); lines.push(`- ${h.id} [${h.domains.join(', ')}]${t ? ` ${t}` : ''} — ${h.desc}\n  ${h.path}`); }
    } else lines.push('No matching skills. Work without one, or browse index/ files listed in dashboard.md.');
    const ag = (catalog.agents || []).length ? search(task, { limit: 1, catalog, items: catalog.agents }) : [];
    if (ag.length) lines.push(`Agent that fits (optional): ${agentLine(ag[0])}`);
    lines.push('Multi-step work? Call vault_plan for a phase-by-phase playbook.');
  }
  if (lines.some((l) => /\{[a-z-]+(,[a-z-]+)*\}/.test(l))) lines.push('{…} = approved permissions (network, secrets, publishing…). The full list is at the top of each file you open.');
  return lines.join('\n');
}

// ---------- plan: a phase-by-phase playbook for multi-step work ----------
export function plan(task, cfg) {
  const catalog = readJSON(P.catalog, null);
  if (!catalog) throw new Error('No catalog yet. Run `vault index`.');
  const words = new Set(tokenize(task));
  const { domains, top } = taskDomains(task, cfg, catalog);
  const { prof, base } = baseSkills(cfg, catalog, top);
  const lines = [`Playbook: ${task}`, `Domains: ${domains.map((d) => domainById[d]?.title || d).join(', ') || 'general'}`];
  const project = projectFor(catalog, words);
  if (project) lines.push(`Project memory: ${project.file} — read it first; log one line per finished phase with vault_memory.`);
  if (base.length) lines.push(`Base skills for every phase (${prof.label}): ${base.map((s) => s.path).join(' ; ')}`);
  lines.push('', 'You are the manager. Work through the phases that apply, in order. At the start of each, call vault_route with that phase to load its skills. Skip phases the task does not need.');
  // Each skill/agent appears once, in the phase where it ranks best (ties go to its main phase).
  const picks = PHASES.map((ph) => ({ ph, sk: forPhase(catalog.skills, ph.id, task, domains, catalog, 5), ag: forPhase(catalog.agents || [], ph.id, task, domains, catalog, 3) }));
  const home = new Map();
  for (const key of ['sk', 'ag']) {
    for (const { ph, [key]: list } of picks) list.forEach((s, i) => {
      const h = home.get(s.id);
      if (!h || i < h.i || (i === h.i && s.phases[0] === ph.id)) home.set(s.id, { ph: ph.id, i });
    });
  }
  let n = 0;
  for (const { ph, sk: allSk, ag: allAg } of picks) {
    const sk = allSk.filter((s) => home.get(s.id)?.ph === ph.id).slice(0, 2);
    const ag = allAg.filter((s) => home.get(s.id)?.ph === ph.id).slice(0, 1);
    if (!sk.length && !ag.length) continue;
    lines.push('', `${++n}. ${ph.title} — ${ph.does}`);
    for (const s of sk) lines.push(`   skill: ${line(s)}`);
    for (const a of ag) lines.push(`   agent: ${agentLine(a)}`);
  }
  if (!n) lines.push('', 'No phase-specific skills or agents match. Use vault_route for the task as a whole.');
  lines.push('', 'Delegating: if your app supports subagents (Claude Code: installed agents, via the Task tool), hand the phase to the agent. Otherwise open the agent file with vault_read and do the phase yourself, following it. Ask the user before anything beyond an item\'s {permissions}.');
  return lines.join('\n');
}
