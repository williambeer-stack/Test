// Merge scraped stat lines from every source into one player index.

import { nameKey, STAT_KEYS, clean } from './parse.mjs';

function previousLines(previous, sourceId) {
  if (!previous?.players) return [];
  return previous.players.flatMap((p) =>
    p.entries.filter((e) => e.src === sourceId).map((e) => ({ ...e, name: p.name })),
  );
}

function toEntry(line, src, stale) {
  const e = {
    src,
    comp: clean(line.comp ?? line.competition),
    season: clean(line.season),
    team: clean(line.team),
  };
  for (const k of STAT_KEYS) if (line[k] != null) e[k] = line[k];
  const url = line.playerUrl || line.url;
  if (url) e.url = url;
  if (stale) e.stale = true;
  return e;
}

/**
 * @param results  [{ source, ok, method?, error?, lines }]
 * @param previous last players.json (or null) — used to keep data for failed/skipped sources
 * @param skipped  sources not scraped this run (kept verbatim from previous)
 */
export function buildDataset(results, previous, skipped = []) {
  const now = new Date().toISOString();
  const tagged = [];
  const sources = [];

  for (const { source, ok, method, error, lines } of results) {
    const prevStatus = previous?.sources?.find((s) => s.id === source.id);
    const use = ok ? lines : previousLines(previous, source.id);
    for (const l of use) tagged.push({ name: l.name, entry: toEntry(l, source.id, !ok) });
    sources.push({
      id: source.id,
      name: source.name,
      short: source.short ?? null,
      url: source.home ?? source.base,
      ok,
      method: method ?? prevStatus?.method ?? null,
      error: error ?? null,
      entries: use.length,
      scrapedAt: ok ? now : prevStatus?.scrapedAt ?? null,
    });
  }
  for (const source of skipped) {
    const prevStatus = previous?.sources?.find((s) => s.id === source.id);
    const lines = previousLines(previous, source.id);
    for (const l of lines) tagged.push({ name: l.name, entry: toEntry(l, source.id, l.stale) });
    sources.push(prevStatus ?? { id: source.id, name: source.name, url: source.home ?? source.base, ok: false, error: 'not scraped yet', entries: 0, scrapedAt: null });
  }

  const byKey = new Map();
  for (const { name, entry } of tagged) {
    const key = nameKey(name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { names: new Map(), entries: [] });
    const p = byKey.get(key);
    p.names.set(name, (p.names.get(name) ?? 0) + 1);
    p.entries.push(entry);
  }

  const players = [...byKey.entries()].map(([key, p]) => {
    // Most common spelling wins; ALL-CAPS variants lose ties.
    const score = ([n, count]) => count * 2 + (n === n.toUpperCase() ? 0 : 1);
    const name = [...p.names.entries()].sort((a, b) => score(b) - score(a))[0][0];
    const seen = new Set();
    const entries = p.entries.filter((e) => {
      const k = JSON.stringify(e);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { id: key.replace(/\s+/g, '-'), name, entries };
  });
  players.sort((a, b) => a.name.localeCompare(b.name));

  return { generatedAt: now, sources, players };
}
