// The U League (theuleague.au), hosted on Cup Manager.
//
// Result pages are a JavaScript app backed by a query API:
//   GET /rest/results_api/call?call=<query>&tournamentId=<id>
// Responses are normalised: { responses: { "<href>": { entity } } }, where nested
// objects are references like { href: "Player({id:1})" }. One query per season
// returns every division's players with season totals; per-game box scores come
// from each finished match's feed statistics, cached so each match is fetched once.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson, getText } from './http.mjs';
import { clean, nameKey } from './parse.mjs';

const EDITION_RE = /\/(\d{4}),(\d+)(?:,[^/]*)?(?=\/|$)/;
const PLAYERS_QUERY = (tid) => `Tournament({id:${tid}}){lotCategories:[{topPlayers:[{stats:{},team:{club:{}}}]}]}`;
const EDITIONS_QUERY = (tid) => `Tournament({id:${tid}}){cup:{editions:[{}]}}`;
const MATCHES_QUERY = (tid) => `Tournament({id:${tid}}){finishedMatches:[{}]}`;
const MATCH_QUERY = (mid) => `Match({id:${mid}}){feed:{statistics:{}},home:{team:{}},away:{team:{}},division:{category:{}},result:{}}`;

async function call(base, tid, query) {
  const qs = new URLSearchParams({ call: query, lang: 'en', tournamentId: String(tid) });
  const { json } = await getJson(`${base}/rest/results_api/call?${qs}`);
  if (!json?.responses) throw new Error('unexpected results_api response');
  return json.responses;
}

export function resolver(responses) {
  const deref = (v) => {
    if (Array.isArray(v)) return v.map(deref).filter(Boolean);
    if (v && typeof v === 'object' && typeof v.href === 'string' && Object.keys(v).length === 1) {
      const entity = responses[v.href]?.entity ?? null;
      // A reference to a list resolves to a list of references.
      return Array.isArray(entity) ? deref(entity) : entity;
    }
    return v;
  };
  return deref;
}

// "The U League 2026 (Season 1)" -> "2026 Season 1"
export function seasonLabel(fullname) {
  const m = /((?:19|20)\d\d)\s*\(?([^)]*)\)?\s*$/.exec(clean(fullname));
  return m ? clean(`${m[1]} ${m[2]}`) : clean(fullname);
}

const teamName = (team, deref) => (team?.name && typeof team.name === 'object'
  ? team.name.clubName || team.name.fullName
  : team?.name || deref(team?.club)?.name || '');

// One finished match -> [date, category, home, away, homeScore, awayScore, rows]
// with rows [side, name, pts, reb, ast, stl, blk, threes].
export function matchRecord(responses, mid) {
  const deref = resolver(responses);
  const m = responses[`Match({id:${mid}})`]?.entity;
  if (!m) return null;
  const stats = deref(deref(m.feed)?.statistics);
  if (!stats) return null;
  const side = (s) => clean(teamName(deref(deref(m[s])?.team), deref));
  const result = deref(m.result) || {};
  const rows = [];
  for (const s of ['home', 'away']) {
    for (const p of stats[s]?.players || []) {
      if (!p.name || !(p.matches > 0)) continue;
      rows.push([s, clean(p.name), p.goals ?? 0, p.rebounds ?? 0, p.assists ?? 0, p.steals ?? 0, p.blockedShots ?? 0, p.threePointers ?? 0]);
    }
  }
  if (!rows.length) return null;
  const category = clean(deref(deref(m.division)?.category)?.name);
  const date = m.start ? new Date(m.start).toISOString().slice(0, 10) : '';
  return [date, category, side('home'), side('away'), result.homeGoals ?? null, result.awayGoals ?? null, rows];
}

// Game rows per player: [date, opponent, result, pts, reb, ast, stl, blk, threes, matchId]
export function attachGames(lines, matches) {
  const byKey = new Map(lines.map((l) => [`${l.tid}|${l.competition}|${nameKey(l.name)}|${l.team.toLowerCase()}`, l]));
  for (const [mid, { t, r }] of matches) {
    if (!r) continue;
    const [date, category, home, away, hs, as, rows] = r;
    for (const [s, name, pts, reb, ast, stl, blk, threes] of rows) {
      const team = s === 'home' ? home : away;
      const line = byKey.get(`${t}|${category}|${nameKey(name)}|${team.toLowerCase()}`);
      if (!line) continue;
      const [mine, theirs] = s === 'home' ? [hs, as] : [as, hs];
      const result = mine == null || theirs == null ? null : `${mine > theirs ? 'W' : mine < theirs ? 'L' : 'D'} ${mine}–${theirs}`;
      (line.games ??= []).push([date, s === 'home' ? away : home, result, pts, reb, ast, stl, blk, threes, mid]);
    }
  }
  for (const l of lines) l.games?.sort((a, b) => a[0].localeCompare(b[0]));
}

async function loadMatches(file) {
  try { return new Map(Object.entries(JSON.parse(await readFile(file, 'utf8')))); } catch { return new Map(); }
}

async function saveMatches(file, matches) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `{\n${[...matches].map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n}\n`);
}

// Fetch box scores for finished matches not yet cached. Returns the number fetched.
async function crawlMatches(base, tids, matches, file, log) {
  const budget = Number(process.env.UL_MAX_MATCHES ?? 4000);
  let fetched = 0;
  for (const tid of tids) {
    let ids = [];
    try {
      const responses = await call(base, tid, MATCHES_QUERY(tid));
      const deref = resolver(responses);
      ids = (deref(responses[`Tournament({id:${tid}})`]?.entity?.finishedMatches) || []).map((m) => String(m.id)).filter(Boolean);
    } catch (err) {
      log(`  ! match list for ${tid}: ${err.message}`);
      continue;
    }
    // Matches with no box score yet are retried after a week (stats are sometimes entered late).
    const retryBefore = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const todo = ids.filter((id) => !matches.has(id) || (!matches.get(id).r && (matches.get(id).at ?? '') < retryBefore));
    log(`  tournament ${tid}: ${ids.length} finished matches, ${todo.length} to fetch`);
    for (const mid of todo) {
      if (fetched >= budget) return fetched;
      try {
        const r = matchRecord(await call(base, tid, MATCH_QUERY(mid)), mid);
        matches.set(mid, r ? { t: tid, r } : { t: tid, r: null, at: new Date().toISOString().slice(0, 10) });
      } catch (err) {
        log(`  ! match ${mid}: ${err.message}`);
      }
      if (++fetched % 100 === 0) {
        log(`  …${fetched} matches fetched`);
        await saveMatches(file, matches);
      }
    }
  }
  return fetched;
}

export function linesFromTournament(responses, tid, base) {
  const deref = resolver(responses);
  const t = responses[`Tournament({id:${tid}})`]?.entity;
  if (!t) throw new Error(`tournament ${tid} missing from response`);
  const season = seasonLabel(t.fullname || t.name || '');
  const url = t.publicResultsUrl ? `${t.publicResultsUrl.replace(/\/$/, '')}/statistics/players` : `${base}`;
  const lines = [];
  for (const cat of deref(t.lotCategories) || []) {
    if (cat.hidePlayers) continue;
    for (const p of deref(cat.topPlayers) || []) {
      const s = p.stats || {};
      if (!p.name || !(s.games > 0)) continue;
      lines.push({
        name: clean(p.name),
        tid: String(tid),
        team: clean(teamName(deref(p.team), deref)),
        competition: clean(cat.name || cat.shortName),
        season,
        gp: s.games,
        pts: s.totalPoints ?? 0,
        ast: s.totalAssists ?? 0,
        ...(cat.registerRebounds === false ? {} : { reb: s.rebounds ?? 0 }),
        ...(cat.registerSteals === false ? {} : { stl: s.steals ?? 0 }),
        ...(cat.registerBlocks === false ? {} : { blk: s.blockedShots ?? 0 }),
        url,
        gameUrl: t.publicResultsUrl ? `${t.publicResultsUrl.replace(/\/$/, '')}/match/{id}` : null,
      });
    }
  }
  return lines;
}

async function discoverTournaments(source, log) {
  const base = source.base.replace(/\/$/, '');
  const editions = new Set((source.editions ?? []).map((e) => `/${e.replace(/^\/|\/$/g, '')}`));
  for (const page of source.indexPages ?? [`${base}/`]) {
    try {
      const { text } = await getText(page);
      for (const m of text.matchAll(new RegExp(EDITION_RE.source, 'g'))) editions.add(`/${m[1]},${m[2]}`);
    } catch (err) {
      log(`  ! ${page}: ${err.message}`);
    }
  }
  const tids = new Set();
  for (const ed of editions) {
    if (Number(ed.slice(1, 5)) < (source.minYear ?? 0)) continue;
    try {
      const { text } = await getText(`${base}${ed}/result`);
      const m = /tournamentId:\s*(\d+)/.exec(text);
      if (m) tids.add(m[1]);
    } catch (err) {
      log(`  ! ${ed}: ${err.message}`);
    }
  }
  // Ask the API for every edition of the cup, to pick up seasons not linked from the home page.
  const first = [...tids][0];
  if (first) {
    try {
      const json = JSON.stringify(await call(base, first, EDITIONS_QUERY(first)));
      for (const m of json.matchAll(/Tournament\(\{id:(\d+)\}\)/g)) tids.add(m[1]);
    } catch (err) {
      log(`  ! editions lookup: ${err.message}`);
    }
  }
  return [...tids];
}

export async function scrapeCupManager(source, log, { cacheDir } = {}) {
  const base = source.base.replace(/\/$/, '');
  const tids = await discoverTournaments(source, log);
  log(`  ${tids.length} seasons/events found`);
  const lines = [];
  let failures = 0;
  for (const tid of tids) {
    try {
      const got = linesFromTournament(await call(base, tid, PLAYERS_QUERY(tid)), tid, base);
      if (got.length) log(`  ${got[0].season}: ${got.length} player lines`);
      lines.push(...got);
    } catch (err) {
      failures++;
      log(`  ! tournament ${tid}: ${err.message}`);
    }
  }
  if (!lines.length && failures) throw new Error(`all ${failures} season requests failed`);
  if (cacheDir && lines.length) {
    const file = join(cacheDir, source.id, 'matches.json');
    const matches = await loadMatches(file);
    const fetched = await crawlMatches(base, tids, matches, file, log);
    await saveMatches(file, matches);
    attachGames(lines, matches);
    log(`  box scores: ${matches.size} matches cached (${fetched} fetched this run)`);
  }
  return { lines, method: 'Cup Manager results API' };
}
