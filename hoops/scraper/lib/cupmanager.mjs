// The U League (theuleague.au), hosted on Cup Manager.
//
// Result pages are a JavaScript app backed by a query API:
//   GET /rest/results_api/call?call=<query>&tournamentId=<id>
// Responses are normalised: { responses: { "<href>": { entity } } }, where nested
// objects are references like { href: "Player({id:1})" }. One query per season
// returns every division's players with season totals.

import { getJson, getText } from './http.mjs';
import { clean } from './parse.mjs';

const EDITION_RE = /\/(\d{4}),(\d+)(?:,[^/]*)?(?=\/|$)/;
const PLAYERS_QUERY = (tid) => `Tournament({id:${tid}}){lotCategories:[{topPlayers:[{stats:{},team:{club:{}}}]}]}`;
const EDITIONS_QUERY = (tid) => `Tournament({id:${tid}}){cup:{editions:[{}]}}`;

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
      const team = deref(p.team);
      const teamName = team?.name && typeof team.name === 'object'
        ? team.name.clubName || team.name.fullName
        : team?.name || deref(team?.club)?.name || '';
      lines.push({
        name: clean(p.name),
        team: clean(teamName),
        competition: clean(cat.name || cat.shortName),
        season,
        gp: s.games,
        pts: s.totalPoints ?? 0,
        ast: s.totalAssists ?? 0,
        ...(cat.registerRebounds === false ? {} : { reb: s.rebounds ?? 0 }),
        ...(cat.registerSteals === false ? {} : { stl: s.steals ?? 0 }),
        ...(cat.registerBlocks === false ? {} : { blk: s.blockedShots ?? 0 }),
        url,
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

export async function scrapeCupManager(source, log) {
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
  return { lines, method: 'Cup Manager results API' };
}
