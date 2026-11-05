// Overlaps: skills (or agents) from different sources that do the same job, e.g. three TDD skills
// from three packages. Exact copies are already hidden by the catalog; this finds the look-alikes,
// so the user can pick one winner per job (vault prefer) and the router stops offering the rest.
import { tokenize } from './search.mjs';
import { OFFICIAL_OWNERS } from './core.mjs';

const GENERIC = new Set(['skill', 'agent', 'use', 'user', 'when', 'help', 'task', 'claude', 'code', 'specialist', 'expert', 'proactive', 'proactively',
  'tool', 'tools', 'support', 'guide', 'workflow', 'best', 'practice', 'pattern', 'file', 'files', 'project', 'also', 'mention', 'ask', 'any', 'all', 'new', 'like', 'want', 'work'].map((t) => tokenize(t)[0] || t));

function vectors(items) {
  const toks = items.map((s) => {
    const name = tokenize(s.name.replace(/[-_]/g, ' ')).filter((t) => !GENERIC.has(t));
    const desc = tokenize(`${s.desc} ${s.heads || ''}`).filter((t) => !GENERIC.has(t));
    const tf = {};
    for (const t of name) tf[t] = (tf[t] || 0) + 3;
    for (const t of desc) tf[t] = (tf[t] || 0) + 1;
    return { tf, name: new Set(name) };
  });
  const df = {};
  for (const { tf } of toks) for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
  const N = items.length;
  return toks.map(({ tf, name }) => {
    const v = {}; let norm = 0;
    for (const [t, f] of Object.entries(tf)) { const w = (1 + Math.log(f)) * Math.log(1 + N / df[t]); v[t] = w; norm += w * w; }
    norm = Math.sqrt(norm) || 1;
    for (const t of Object.keys(v)) v[t] /= norm;
    return { v, name };
  });
}
const cos = (a, b) => { let s = 0; const [x, y] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a]; for (const t in x) if (y[t]) s += x[t] * y[t]; return s; };

// Lower = preferred by default: local skills, then official owners, then sources in the order added.
export function sourceRank(cfg) {
  const order = new Map(cfg.sources.map((s, i) => [s.name, i]));
  const own = new Map(cfg.sources.map((s) => [s.name, String(s.owner || '').toLowerCase()]));
  return (name) => (name === 'local' ? -1000 : OFFICIAL_OWNERS.includes(own.get(name)) ? -500 + (order.get(name) ?? 0) : (order.get(name) ?? 999));
}

export function findOverlaps(catalog, cfg, { threshold = 0.3 } = {}) {
  const rank = sourceRank(cfg);
  const groups = [];
  for (const kind of ['skill', 'agent']) {
    const items = (kind === 'skill' ? catalog.skills : catalog.agents || []).filter((s) => !s.dupOf && !s.family);
    if (items.length < 2) continue;
    const vec = vectors(items);
    const sims = new Map(); const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.source === b.source) continue;
        if (!a.domains.some((d) => b.domains.includes(d))) continue;
        const s = cos(vec[i].v, vec[j].v);
        if (s >= threshold) { sims.set(`${i},${j}`, s); pairs.push([s, i, j]); }
      }
    }
    // Complete linkage: an item joins a group only if it resembles every member, so a generic TDD skill
    // never drags in "django-tdd" through a chain of partial matches. At most one item per source.
    const sim = (i, j) => sims.get(i < j ? `${i},${j}` : `${j},${i}`) || 0;
    const groupOf = new Map(); const by = new Map(); let gid = 0;
    for (const [, i, j] of pairs.sort((x, y) => y[0] - x[0])) {
      const gi = groupOf.get(i), gj = groupOf.get(j);
      if (gi === undefined && gj === undefined) { by.set(gid, [i, j]); groupOf.set(i, gid); groupOf.set(j, gid); gid++; continue; }
      if (gi !== undefined && gj !== undefined) continue;
      const [g, k] = gi !== undefined ? [gi, j] : [gj, i];
      const members = by.get(g);
      if (members.every((m) => sim(m, k) >= threshold)) { members.push(k); groupOf.set(k, g); }
    }
    for (const idx of by.values()) {
      if (idx.length < 2) continue;
      const members = idx.map((i) => items[i]);
      if (new Set(members.map((m) => m.source)).size < 2) continue;
      // Shared words make the label: the job these items have in common.
      const counts = {};
      for (const i of idx) for (const t of Object.keys(vec[i].v)) counts[t] = (counts[t] || 0) + 1;
      const label = Object.entries(counts).filter(([, c]) => c >= Math.max(2, Math.ceil(idx.length * 0.6))).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
      let best = 0; for (const [k, s] of sims) { const [i, j] = k.split(',').map(Number); if (idx.includes(i) && idx.includes(j)) best = Math.max(best, s); }
      const preferred = members.find((m) => cfg.prefer?.[m.id]);
      members.sort((a, b) => (b === preferred) - (a === preferred) || rank(a.source) - rank(b.source) || b.desc.length - a.desc.length);
      groups.push({ kind, label: members[0].name.replace(/[-_]+/g, ' '), words: label, members, similarity: +best.toFixed(2), resolved: !!preferred, suggest: members[0].id });
    }
  }
  return groups.sort((a, b) => a.resolved - b.resolved || b.members.length - a.members.length || b.similarity - a.similarity);
}

// cfg.prefer = { "<winner id>": ["<loser id>", …] } → mark losers so index, search and plans use the winner.
export function applyPrefer(catalog, cfg) {
  const all = new Map([...catalog.skills, ...(catalog.agents || [])].map((s) => [s.id, s]));
  for (const [winner, losers] of Object.entries(cfg.prefer || {})) {
    if (!all.has(winner)) continue;
    for (const l of losers) { const x = all.get(l); if (x && l !== winner) x.deferTo = winner; }
  }
}
