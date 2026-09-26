// Merge stat lines from every source into the files the site reads:
//   index.json         every player's name, teams and per-source totals (search + leaders)
//   players/<n>.json   every player's individual stat lines, sharded by id

import { nameKey, STAT_KEYS, clean } from './parse.mjs';

export const SHARDS = 64;

export function shardOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SHARDS;
}

function toEntry(line, src) {
  const e = { src, comp: clean(line.competition), season: clean(line.season), team: clean(line.team) };
  for (const k of STAT_KEYS) if (line[k] != null) e[k] = line[k];
  if (line.url) e.url = line.url;
  if (line.stale) e.stale = true;
  return e;
}

/**
 * @param results [{ source, ok, method, error, lines, scrapedAt }]
 * @returns { index, shards: Map<number, object> }
 */
export function buildDataset(results, now = new Date().toISOString()) {
  const sources = results.map(({ source, ok, method, error, lines, scrapedAt }) => ({
    id: source.id,
    name: source.name,
    short: source.short ?? null,
    url: source.home ?? source.base,
    ok,
    method: method ?? null,
    error: error ?? null,
    entries: lines.length,
    scrapedAt: scrapedAt ?? null,
  }));

  const byKey = new Map();
  for (const { source, lines } of results) {
    for (const line of lines) {
      const key = nameKey(line.name);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { names: new Map(), entries: [] });
      const p = byKey.get(key);
      p.names.set(line.name, (p.names.get(line.name) ?? 0) + 1);
      p.entries.push(toEntry(line, source.id));
    }
  }

  const players = [];
  const shards = new Map();
  for (const [key, p] of byKey) {
    // Most common spelling wins; ALL-CAPS variants lose ties.
    const score = ([n, count]) => count * 2 + (n === n.toUpperCase() ? 0 : 1);
    const name = [...p.names.entries()].sort((a, b) => score(b) - score(a))[0][0];
    const id = key.replace(/\s+/g, '-');
    const seen = new Set();
    const entries = p.entries.filter((e) => {
      const k = JSON.stringify(e);
      return seen.has(k) ? false : (seen.add(k), true);
    });
    const totals = {};
    const teamCount = new Map();
    for (const e of entries) {
      const t = (totals[e.src] ??= STAT_KEYS.map(() => 0));
      STAT_KEYS.forEach((k, i) => { t[i] += e[k] ?? 0; });
      if (e.team) teamCount.set(e.team, (teamCount.get(e.team) ?? 0) + (e.gp || 1));
    }
    const teams = [...teamCount.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    players.push([id, name, teams.slice(0, 3).join(', ') + (teams.length > 3 ? ` +${teams.length - 3}` : ''), totals]);
    const shard = shardOf(id);
    if (!shards.has(shard)) shards.set(shard, {});
    shards.get(shard)[id] = entries;
  }
  players.sort((a, b) => a[1].localeCompare(b[1]));

  return {
    index: { generatedAt: now, stats: STAT_KEYS, shards: SHARDS, sources, players },
    shards,
  };
}
