// Keyword search (BM25) over the catalog. Used by `vault search` and the vault_route MCP tool.
import { P, readJSON } from './core.mjs';
import { domainById } from './domains.mjs';
import { tag } from './permissions.mjs';

const STOP = new Set('a an and are as at be by for from how i in is it its my me of on or so that the this to we with you your want need help please can could should would do does using use make build create work working after before about into some any just get got new few minutes minute set up'.split(' '));
const SYN = {
  esp: ['esp32'], cpp: ['c++'], js: ['javascript'], ts: ['typescript'], ui: ['frontend'], ux: ['design'],
  ppt: ['pptx'], deck: ['pptx', 'slides'], slides: ['pptx'], doc: ['docx'], word: ['docx'], spreadsheet: ['xlsx', 'excel'],
  robotic: ['humanize'], humanlike: ['humanize'], blog: ['article'], tweet: ['twitter'], db: ['database'], ml: ['machine'],
  stall: ['hang', 'debug'], crash: ['debug'], freeze: ['hang', 'debug'], bug: ['debug'], vid: ['video'],
};
// Light stemming so "stalls/stalled/stalling" and "humanize/humanizing" match, without prefix false-positives.
const stem = (t) => t.length <= 4 ? t : t.replace(/(ization|isation|ations|ation|ings|ing|izes|ized|ize|ises|ised|ise|ers|er|ates|ate|ies|es|ed|ly|s)$/, '') || t;
export const tokenize = (s) => String(s || '').toLowerCase().replace(/c\+\+/g, ' cpp ').split(/[^a-z0-9]+/)
  .filter((t) => t.length > 1 && !STOP.has(t)).flatMap((t) => [t, ...(SYN[t] || [])]).map(stem);

const FAMILY_WORDS = new Set(['automation', 'skill', 'integration', 'expert', 'pro'].map(stem));

export function search(query, { limit = 8, catalog = readJSON(P.catalog, null) } = {}) {
  if (!catalog) throw new Error('No catalog yet. Run `vault index`.');
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const docs = catalog.skills.filter((s) => !s.dupOf).map((s) => {
    const name = tokenize(s.name.replace(/[-_]/g, ' '));
    const body = tokenize(`${s.desc} ${s.domains.map((d) => domainById[d]?.title).join(' ')}`);
    return { s, name, body, len: name.length * 3 + body.length };
  });
  const N = docs.length || 1; const avg = docs.reduce((a, d) => a + d.len, 0) / N;
  const df = Object.fromEntries(q.map((t) => [t, docs.filter((d) => d.name.includes(t) || d.body.includes(t)).length]));
  const k1 = 1.2, b = 0.75;
  const scored = docs.map((d) => {
    let score = 0; let matched = 0; const nameMatched = new Set();
    for (const t of q) {
      const nt = d.name.filter((x) => x === t).length;
      const tf = nt * 3 + d.body.filter((x) => x === t).length;
      if (!tf) continue;
      matched++; if (nt) nameMatched.add(t);
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / avg));
    }
    // Family members (e.g. 800 "<app>-automation" skills) surface only when the app itself is named in full.
    const core = d.name.filter((x) => !FAMILY_WORDS.has(x));
    const fullName = core.length > 0 && core.every((x) => nameMatched.has(x));
    if (d.s.family && !fullName) score = 0;
    // One weak word in a description is noise: need a rare/full name hit or two distinct matching words.
    const strongName = fullName || [...nameMatched].some((t) => df[t] <= Math.max(5, N * 0.01));
    if (!strongName && matched < Math.min(2, q.length)) score = 0;
    return { ...d.s, score: +score.toFixed(2) };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 0;
  return scored.filter((r) => r.score >= Math.max(0.3, top * 0.4)).slice(0, limit);
}

export function route(task, cfg, { limit = 5 } = {}) {
  const catalog = readJSON(P.catalog, null);
  if (!catalog) throw new Error('No catalog yet. Run `vault index`.');
  const words = new Set(tokenize(task));
  const lines = [`Vault root: ${catalog.root}`];
  const find = (id) => catalog.skills.find((s) => s.id === id) || catalog.skills.find((s) => s.name.toLowerCase() === String(id).toLowerCase());

  const project = catalog.projects.find((p) => tokenize(p.title).some((t) => words.has(t)) && tokenize(p.title).filter((t) => words.has(t)).length >= Math.min(2, tokenize(p.title).length));
  if (project) lines.push(`Project memory: ${project.file}${project.filled ? '' : ' (still empty — ask the user for context)'}`);

  const hits = search(task, { limit: limit + 4, catalog });
  const pins = (cfg.pins || []).map((p) => ({ p, n: tokenize(p.when).filter((t) => words.has(t)).length }))
    .filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 2).map((x) => x.p);
  const domainVotes = {};
  pins.forEach((p) => p.load.map(find).filter(Boolean).forEach((s) => s.domains.forEach((d) => { domainVotes[d] = (domainVotes[d] || 0) + 10; })));
  hits.slice(0, 5).forEach((h, i) => h.domains.forEach((d) => { domainVotes[d] = (domainVotes[d] || 0) + (5 - i); }));
  const topDomain = Object.entries(domainVotes).sort((a, b) => b[1] - a[1])[0]?.[0];
  const prof = Object.values(cfg.profiles || {}).find((p) => p.domains && p.domains.includes(topDomain)) || cfg.profiles?.default;
  const base = (prof?.load || []).map(find).filter(Boolean);
  if (base.length) lines.push(`Base skills (${prof.label}): ${base.map((s) => s.path).join(' ; ')}`);

  for (const pin of pins) lines.push(`Pinned route "${pin.when}": ${pin.load.map(find).filter(Boolean).map((s) => s.path).join(' ; ')}`);
  const shown = new Set([...base, ...pins.flatMap((p) => p.load.map(find).filter(Boolean))].map((s) => s.id));
  const rest = hits.filter((h) => !shown.has(h.id)).slice(0, limit);
  if (rest.length) {
    lines.push('Candidate skills (pick at most 2, open the path):');
    for (const h of rest) { const t = tag(h.perms); lines.push(`- ${h.id} [${h.domains.join(', ')}]${t ? ` ${t}` : ''} — ${h.desc}\n  ${h.path}`); }
    if (rest.some((h) => tag(h.perms))) lines.push('{…} = approved permissions (network, secrets, publishing…). The full list is at the top of each SKILL.md you open.');
  } else lines.push('No matching skills. Work without one, or browse index/ files listed in dashboard.md.');
  return lines.join('\n');
}
