// Sydney Social Basketball (WordPress + "TurboLeague" plugin).
//
// Every match is exposed by the WordPress REST API with its box score in the ACF
// field `statistics` (one row per player: points, rebounds, assists, steals, blocks).
// There are ~50k matches, so box scores are cached on disk: the first run backfills
// the whole history (oldest first, resumable), later runs only fetch matches
// modified since the previous run.
//
// Only player IDs, display names, profile slugs and stats are kept. The API exposes
// other user fields; they are never requested via _fields or stored.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson } from './http.mjs';
import { clean, splitSeason, toInt } from './parse.mjs';

const FIELDS = [
  'id', 'date', 'modified', 'link', 'division_name',
  'acf.statistics', 'acf.home_team.ID', 'acf.home_team.post_title', 'acf.away_team.ID', 'acf.away_team.post_title',
].join(',');
const PER_PAGE = 100;
const RECENT_OVERLAP_MS = 3 * 864e5;

// ---------- cache ----------

export async function loadCache(dir) {
  const cache = { meta: { backfillPage: 1, backfillDone: false, lastModified: null }, matches: new Map(), players: new Map() };
  try { cache.meta = { ...cache.meta, ...JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) }; } catch { /* fresh */ }
  try {
    for (const [uid, v] of Object.entries(JSON.parse(await readFile(join(dir, 'players.json'), 'utf8')))) cache.players.set(uid, v);
  } catch { /* fresh */ }
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^matches-\d{4}\.json$/.test(f)); } catch { /* fresh */ }
  for (const f of files) {
    for (const [id, m] of Object.entries(JSON.parse(await readFile(join(dir, f), 'utf8')))) cache.matches.set(id, m);
  }
  return cache;
}

export async function saveCache(dir, cache) {
  await mkdir(dir, { recursive: true });
  const byYear = new Map();
  for (const [id, m] of cache.matches) {
    const year = m[0].slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push([id, m]);
  }
  // One match / player per line keeps files diff- and cache-friendly.
  const lines = (entries) => `{\n${entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n}\n`;
  for (const [year, entries] of byYear) await writeFile(join(dir, `matches-${year}.json`), lines(entries));
  await writeFile(join(dir, 'players.json'), lines([...cache.players]));
  await writeFile(join(dir, 'meta.json'), JSON.stringify(cache.meta, null, 2) + '\n');
}

// Store one API match record in the cache. Returns true if it had a box score.
export function upsertMatch(cache, item) {
  const stats = item?.acf?.statistics;
  if (!Array.isArray(stats) || !stats.length) {
    cache.matches.delete(String(item.id));
    return false;
  }
  const rows = [];
  for (const row of stats) {
    const p = row?.player;
    if (!p || !p.ID) continue;
    const uid = String(p.ID);
    const name = clean(p.display_name) || clean(`${p.user_firstname ?? ''} ${p.user_lastname ?? ''}`);
    if (!name) continue;
    cache.players.set(uid, [name, clean(p.user_nicename)]);
    rows.push([uid, toInt(row.points), toInt(row.rebounds), toInt(row.assists), toInt(row.steals), toInt(row.blocks)]);
  }
  if (!rows.length) return false;
  const home = item.acf.home_team || {};
  const away = item.acf.away_team || {};
  cache.matches.set(String(item.id), [
    String(item.date || '').slice(0, 10),
    clean(item.division_name),
    String(home.ID ?? ''), clean(home.post_title),
    String(away.ID ?? ''), clean(away.post_title),
    item.link || '',
    rows,
  ]);
  return true;
}

// ---------- crawling ----------

async function fetchPage(base, params) {
  const qs = new URLSearchParams({ per_page: String(PER_PAGE), _fields: FIELDS, ...params });
  try {
    const { json, headers } = await getJson(`${base}/wp-json/wp/v2/match?${qs}`);
    return { items: Array.isArray(json) ? json : [], totalPages: Number(headers.get('x-wp-totalpages') || 0) };
  } catch (err) {
    if (err.status === 400) return { items: [], totalPages: 0 }; // page past the end
    throw err;
  }
}

async function crawl(source, cache, dir, log) {
  const base = source.base.replace(/\/$/, '');
  const maxPages = Number(process.env.SSB_MAX_PAGES ?? source.maxPagesPerRun ?? 700);
  let pages = 0;
  let newest = cache.meta.lastModified;
  const track = (items) => {
    for (const it of items) {
      upsertMatch(cache, it);
      if (it.modified && (!newest || it.modified > newest)) newest = it.modified;
    }
  };

  // 1. Matches changed since the last run (new results, corrections).
  if (cache.meta.lastModified) {
    const cutoff = new Date(Date.parse(cache.meta.lastModified) - RECENT_OVERLAP_MS).toISOString().slice(0, 19);
    for (let page = 1; pages < maxPages; page++) {
      const { items } = await fetchPage(base, { orderby: 'modified', order: 'desc', page: String(page) });
      pages++;
      track(items);
      if (items.length < PER_PAGE || items[items.length - 1].modified < cutoff) break;
    }
    log(`  checked ${pages} page(s) of recently changed matches`);
  }

  // 2. Backfill history, oldest first, resuming where the last run stopped.
  while (!cache.meta.backfillDone && pages < maxPages) {
    const page = cache.meta.backfillPage;
    const { items, totalPages } = await fetchPage(base, { orderby: 'id', order: 'asc', page: String(page) });
    pages++;
    track(items);
    if (items.length < PER_PAGE || (totalPages && page >= totalPages)) cache.meta.backfillDone = true;
    else cache.meta.backfillPage = page + 1;
    if (page % 25 === 0) {
      log(`  backfill page ${page}/${totalPages || '?'} (${cache.matches.size} matches with box scores)`);
      await saveCache(dir, cache);
    }
  }
  if (!cache.meta.backfillDone) log(`  backfill paused at page ${cache.meta.backfillPage}; it continues next run`);
  // Only advance the "changed since" marker once history is complete, so nothing is skipped.
  if (cache.meta.backfillDone) cache.meta.lastModified = newest;
  return pages;
}

// ---------- aggregation ----------

// Box scores don't say which side a player was on, so a player's team in a division is
// the team present in every match they appear in (falling back to the most common one).
export function aggregate(cache, base) {
  const acc = new Map();
  for (const [mid, [date, division, homeId, homeName, awayId, awayName, , rows]] of cache.matches) {
    for (const [uid, pts, reb, ast, stl, blk] of rows) {
      const key = `${uid}|${division}`;
      let a = acc.get(key);
      if (!a) {
        a = { uid, division, year: date.slice(0, 4), gp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, teams: new Map(), games: [] };
        acc.set(key, a);
      }
      a.gp++; a.pts += pts; a.reb += reb; a.ast += ast; a.stl += stl; a.blk += blk;
      a.games.push([date, homeId, awayId, pts, reb, ast, stl, blk, mid]);
      for (const [id, name] of [[homeId, homeName], [awayId, awayName]]) {
        const t = a.teams.get(id) || { name, n: 0 };
        t.n++;
        a.teams.set(id, t);
      }
    }
  }
  const lines = [];
  for (const a of acc.values()) {
    const [name, slug] = cache.players.get(a.uid) || [];
    if (!name) continue;
    const ranked = [...a.teams.values()].sort((x, y) => y.n - x.n);
    const top = ranked.filter((t) => t.n === ranked[0].n);
    const { comp, season } = splitSeason(a.division, a.year);
    const profile = slug ? `${base}/player-profile/${slug}/` : null;
    const mine = new Set([...a.teams].filter(([, t]) => t.n === ranked[0].n).map(([id]) => id));
    const nameOf = (id) => a.teams.get(id)?.name ?? '';
    // Game rows: [date, opponent, result, pts, reb, ast, stl, blk, threes, matchId]. Box scores
    // carry no team scores, so result is null; when the player's team is ambiguous both sides show.
    const games = a.games
      .map(([date, homeId, awayId, pts, reb, ast, stl, blk, mid]) => {
        const opp = mine.size === 1
          ? nameOf(mine.has(homeId) ? awayId : homeId)
          : `${nameOf(homeId)} v ${nameOf(awayId)}`;
        return [date, opp, null, pts, reb, ast, stl, blk, null, Number(mid)];
      })
      .sort((x, y) => x[0].localeCompare(y[0]));
    lines.push({
      name,
      key: `ssb:${a.uid}`,
      team: top.map((t) => t.name).join(' / '),
      competition: comp,
      season,
      gp: a.gp, pts: a.pts, reb: a.reb, ast: a.ast, stl: a.stl, blk: a.blk,
      url: profile,
      games,
      gameUrl: `${base}/?p={id}`,
    });
  }
  return lines;
}

export async function scrapeSsb(source, log, { cacheDir }) {
  const base = source.base.replace(/\/$/, '');
  const dir = join(cacheDir, source.id);
  const cache = await loadCache(dir);
  log(`  cache: ${cache.matches.size} matches, backfill ${cache.meta.backfillDone ? 'complete' : `at page ${cache.meta.backfillPage}`}`);
  let error = null;
  try {
    const pages = await crawl(source, cache, dir, log);
    log(`  fetched ${pages} API page(s); ${cache.matches.size} matches with box scores`);
  } catch (err) {
    error = err.message;
    log(`  ! crawl stopped: ${err.message}`);
  }
  await saveCache(dir, cache);
  const lines = aggregate(cache, base);
  const method = cache.meta.backfillDone ? 'WordPress match API' : `WordPress match API (history still loading: page ${cache.meta.backfillPage})`;
  return { lines, method, error };
}
