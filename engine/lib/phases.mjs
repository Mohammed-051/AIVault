// Work phases. Every skill and agent is tagged with the phases it helps in, so an agent working
// through a task can pull the right ones at each step (vault_plan, vault_route with a phase).
// Phases are generic on purpose: they fit code (spec → implement → test → review → release)
// and non-code work (research → outline → draft → edit → publish) alike.
// Keyword syntax: plain = prefix match ("test" matches "testing"); trailing "!" = whole word only.
export const PHASES = [
  {
    id: 'discover', title: 'Discover', does: 'research, requirements, brainstorming, exploring a codebase or topic',
    keywords: ['research', 'brainstorm', 'explor', 'discover', 'requirement', 'interview', 'investigat', 'understand', 'survey',
      'competitor', 'ideation', 'ideas', 'question', 'lookup', 'search', 'analyz', 'analys', 'audience', 'customer research', 'deep dive', 'learn'],
  },
  {
    id: 'plan', title: 'Plan', does: 'outline, spec, architecture, task breakdown, strategy',
    keywords: ['plan', 'planner', 'planning', 'spec', 'architect', 'design doc', 'roadmap', 'outline', 'breakdown', 'strategy', 'prd!',
      'scope', 'estimat', 'decompos', 'roadmap', 'system design', 'adr!', 'proposal', 'brief'],
  },
  {
    id: 'build', title: 'Build', does: 'implement, draft, create, generate',
    keywords: ['implement', 'build', 'creat', 'generat', 'draft', 'develop', 'scaffold', 'executor', 'coder', 'refactor', 'migrat',
      'component', 'api!', 'write', 'writing', 'copywrit', 'compose', 'design', 'prototype', 'convert', 'automat', 'integrat'],
  },
  {
    id: 'verify', title: 'Verify', does: 'test, debug, fix errors, fact-check, proofread',
    keywords: ['test', 'tdd!', 'e2e!', 'debug', 'bug', 'fix', 'error', 'resolver', 'verif', 'validat', 'qa!', 'lint', 'proofread',
      'fact-check', 'fact check', 'benchmark', 'eval', 'edit', 'copy-edit', 'type check', 'typecheck', 'diagnos', 'troubleshoot'],
  },
  {
    id: 'review', title: 'Review', does: 'code review, security review, editorial critique, audits',
    keywords: ['review', 'audit', 'critique', 'critic', 'security', 'vulnerab', 'evaluat', 'feedback', 'simplif', 'inspect', 'grader',
      'compliance', 'accessib', 'a11y!', 'quality'],
  },
  {
    id: 'ship', title: 'Ship', does: 'release, deploy, publish, docs, commit/PR, announce',
    keywords: ['release', 'deploy', 'publish', 'ship', 'changelog', 'commit', 'pull request', 'pr!', 'docs!', 'documentation', 'doc-',
      'readme', 'launch', 'branch', 'merg', 'announc', 'post', 'social', 'seo!', 'ci!', 'cd!', 'pipeline', 'handoff', 'hand-off', 'submit', 'distribut'],
  },
];
export const PHASE_IDS = PHASES.map((p) => p.id);
export const phaseById = Object.fromEntries(PHASES.map((p) => [p.id, p]));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RX = PHASES.map((p) => ({
  id: p.id,
  rx: p.keywords.map((k) => (k.endsWith('!') ? new RegExp(`(^|[^a-z0-9])${esc(k.slice(0, -1))}([^a-z0-9]|$)`, 'i') : new RegExp(`(^|[^a-z0-9])${esc(k)}`, 'i'))),
}));

// Up to two phases per item. The name counts three times as much as the description.
export function classifyPhases(name, desc = '') {
  const fields = [[String(name).replace(/[-_]/g, ' '), 3], [desc, 1]];
  const scores = {};
  for (const p of RX) {
    let s = 0;
    for (const rx of p.rx) for (const [text, w] of fields) if (rx.test(text)) s += w;
    if (s) scores[p.id] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { phases: [], phaseScore: {} };
  const top = ranked[0][1];
  const phases = ranked.filter(([, s]) => s >= Math.max(2, top * 0.6)).slice(0, 2).map(([id]) => id);
  return { phases: phases.length ? phases : [ranked[0][0]], phaseScore: Object.fromEntries(ranked) };
}
