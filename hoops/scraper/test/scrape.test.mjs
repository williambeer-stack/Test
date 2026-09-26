import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nameKey, cleanName, splitSeason, parseRobots } from '../lib/index.mjs';
import { scrapeSsb, loadCache, upsertMatch, aggregate } from '../lib/ssb.mjs';
import { scrapeCupManager, linesFromTournament, seasonLabel, matchRecord, attachGames, finishedMatchIds } from '../lib/cupmanager.mjs';
import { buildDataset, shardOf, SHARDS } from '../lib/dataset.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const quiet = () => {};
const ssbMatches = JSON.parse(fx('ssb-matches.json'));

let server;
let base;
const requests = [];
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const send = (type, body, headers = {}) => { res.writeHead(200, { 'content-type': type, ...headers }); res.end(body); };
    if (u.pathname === '/wp-json/wp/v2/match') {
      assert.ok(u.searchParams.get('_fields').includes('acf.statistics'));
      assert.ok(!/email/.test(u.searchParams.get('_fields')), 'never request emails');
      const page = Number(u.searchParams.get('page'));
      const sorted = u.searchParams.get('orderby') === 'modified'
        ? [...ssbMatches].sort((a, b) => b.modified.localeCompare(a.modified))
        : ssbMatches;
      if (page > 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"code":"rest_post_invalid_page_number"}'); }
      return send('application/json', JSON.stringify(sorted), { 'x-wp-totalpages': '1' });
    }
    if (u.pathname === '/') return send('text/html', '<a href="/2026,1/result">Season 1</a>');
    if (u.pathname === '/2026,1/result') return send('text/html', "<script>window.cm_results_props = { baseUrl: '/2026,1/result', tournamentId: 900, lang: 'en' };</script>");
    if (u.pathname === '/rest/results_api/call') {
      const q = u.searchParams.get('call');
      if (/editions/.test(q)) return send('text/plain', fx('cm-editions.json'));
      if (/finishedMatches/.test(q)) return send('text/plain', fx('cm-finished.json'));
      if (q.startsWith('Match({id:5001})')) return send('text/plain', fx('cm-match.json'));
      if (q.startsWith('Match({id:5002})')) return send('text/plain', '{"responses":{}}');
      if (u.searchParams.get('tournamentId') === '900') return send('text/plain', fx('cm-players.json'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('name and label helpers', () => {
  assert.equal(cleanName('12 Mia Chen'), 'Mia Chen');
  assert.equal(nameKey("Sam O'Brien"), nameKey('sam obrien'));
  assert.equal(nameKey('José  Núñez'), 'jose nunez');
  assert.deepEqual(splitSeason('Caringbah Monday (Mens) 2025 S1'), { comp: 'Caringbah Monday (Mens)', season: '2025 S1' });
  assert.deepEqual(splitSeason('Arncliffe Thursday C (Mixed)', 2026), { comp: 'Arncliffe Thursday C (Mixed)', season: '2026' });
  assert.equal(seasonLabel('The U League 2026 (Season 1)'), '2026 Season 1');
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /x\n\nUser-agent: *\nDisallow: /wp-admin/'), ['/wp-admin/']);
});

test('SSB: box scores aggregate per player and division, team inferred', async () => {
  const cache = await loadCache(join(await mkdtemp(join(tmpdir(), 'ssb-')), 'none'));
  for (const m of ssbMatches) upsertMatch(cache, m);
  assert.equal(cache.matches.size, 2, 'match without stats is skipped');
  const lines = aggregate(cache, 'https://ssb.test');
  const ava = lines.find((l) => l.name === 'Ava Example');
  assert.deepEqual(ava, {
    name: 'Ava Example', key: 'ssb:101', team: 'Hoop Troop', competition: 'Glebe Tuesday (Mens)', season: '2025 S1',
    gp: 2, pts: 34, reb: 12, ast: 5, stl: 1, blk: 1, url: 'https://ssb.test/player-profile/avaex/',
    games: [
      ['2025-03-01', 'Net Gains', null, 20, 5, 3, 1, 0, null, 10],
      ['2025-03-08', 'Brick Layers', null, 14, 7, 2, 0, 1, null, 11],
    ],
    gameUrl: 'https://ssb.test/?p={id}',
  });
  // One game only: both teams are possible, so both are shown.
  const dee = lines.find((l) => l.name === 'Dee Test');
  assert.equal(dee.team, 'Brick Layers / Hoop Troop');
  assert.equal(dee.games[0][1], 'Brick Layers v Hoop Troop');
  assert.equal(lines.find((l) => l.name === 'Dee Test').blk, 0, 'blank stat counts as zero');
});

test('SSB: backfill, cache round-trip, then incremental run', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ssb-'));
  const source = { id: 'ssb', base };
  const first = await scrapeSsb(source, quiet, { cacheDir });
  assert.equal(first.error, null);
  assert.equal(first.lines.length, 4);
  const meta = JSON.parse(await readFile(join(cacheDir, 'ssb', 'meta.json'), 'utf8'));
  assert.equal(meta.backfillDone, true);
  assert.equal(meta.lastModified, '2025-03-15T09:00:00');
  const cached = await readFile(join(cacheDir, 'ssb', 'players.json'), 'utf8');
  assert.ok(!/@/.test(cached), 'no email-like data in cache');

  requests.length = 0;
  const second = await scrapeSsb(source, quiet, { cacheDir });
  assert.equal(second.lines.length, 4, 'served from cache + recent changes');
  assert.ok(requests.some((r) => r.includes('orderby=modified')), 'second run only asks for recent changes');
  assert.ok(!requests.some((r) => r.includes('orderby=id')), 'no second backfill');
});

test('Cup Manager: normalised response resolves to player lines', () => {
  const lines = linesFromTournament(JSON.parse(fx('cm-players.json')).responses, '900', 'https://ul.test');
  const common = { tid: '900', season: '2026 Season 1', url: 'https://ul.test/2026,1,en/result/statistics/players', gameUrl: 'https://ul.test/2026,1,en/result/match/{id}' };
  assert.deepEqual(lines, [
    { name: 'Ava Example', team: 'Airballers', competition: 'Sydney Uni - Division 1', gp: 7, pts: 141, ast: 20, reb: 40, stl: 9, blk: 3, ...common },
    { name: 'Mia Placeholder', team: 'Swishers', competition: 'Concord Wednesdays', gp: 6, pts: 98, ast: 5, stl: 2, blk: 0, ...common },
  ]);
});

test('Cup Manager: finished matches are found via team match lists', () => {
  assert.deepEqual([...finishedMatchIds(JSON.parse(fx('cm-players.json')).responses)], ['5001'], 'unfinished match skipped');
});

test('Cup Manager: match feed becomes a box score and attaches to season lines', () => {
  const r = matchRecord(JSON.parse(fx('cm-match.json')).responses, '5001');
  assert.deepEqual(r, ['2026-05-24', 'Sydney Uni - Division 1', 'Airballers', 'Swishers', 73, 61, [
    ['home', 'Ava Example', 26, 10, 2, 2, 1, 3],
    ['away', 'Mia Placeholder', 25, 4, 0, 1, 0, 1],
  ]], 'player who did not play is left out');
  const lines = [
    { name: 'Ava Example', tid: '900', team: 'Airballers', competition: 'Sydney Uni - Division 1' },
    { name: 'Mia Placeholder', tid: '900', team: 'Swishers', competition: 'Concord Wednesdays' },
  ];
  attachGames(lines, new Map([['5001', { t: '900', r }]]));
  assert.deepEqual(lines[0].games, [['2026-05-24', 'Swishers', 'W 73–61', 26, 10, 2, 2, 1, 3, '5001']]);
  assert.equal(lines[1].games, undefined, 'different division, so not attached');
});

test('Cup Manager: discovers seasons, fetches and caches box scores', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cm-'));
  const source = { id: 'uleague', base, indexPages: [`${base}/`] };
  const { lines, method } = await scrapeCupManager(source, quiet, { cacheDir });
  assert.equal(method, 'Cup Manager results API');
  assert.equal(lines.length, 2);
  assert.ok(requests.some((r) => r.includes('tournamentId=901')), 'edition found via API was tried');
  assert.equal(lines[0].games.length, 1, 'match found via team list, not the short finished list');
  const cached = JSON.parse(await readFile(join(cacheDir, 'uleague', 'matches.json'), 'utf8'));
  assert.ok(cached['5001'].r, 'box score cached');
  assert.equal(cached['5002'].r, null, 'match without stats remembered');

  requests.length = 0;
  await scrapeCupManager(source, quiet, { cacheDir });
  assert.ok(!requests.some((r) => /Match%28%7Bid%3A500/.test(r)), 'cached matches are not fetched again');
});

test('dataset: merges people across sources into index + shards', () => {
  const src = (id) => ({ id, name: id, base: `https://${id}.test` });
  const { index, shards } = buildDataset([
    { source: src('a'), ok: true, method: 'm', lines: [{ name: 'Ava Example', team: 'X', competition: 'C', season: 'S', gp: 2, pts: 30, reb: 4 }] },
    { source: src('b'), ok: false, error: 'HTTP 503', lines: [{ name: 'AVA EXAMPLE', team: 'Y', competition: 'D', season: 'S', gp: 1, pts: 5, stale: true }] },
  ], '2026-01-01T00:00:00Z');
  assert.equal(index.players.length, 1);
  const [id, name, teams, totals] = index.players[0];
  assert.equal(name, 'Ava Example');
  assert.equal(teams, 'X, Y');
  assert.deepEqual(totals, { a: [2, 30, 4, 0, 0, 0], b: [1, 5, 0, 0, 0, 0] });
  assert.equal(index.sources[1].error, 'HTTP 503');
  const entries = shards.get(shardOf(id))[id];
  assert.equal(entries.length, 2);
  assert.equal(entries[1].stale, true);
  assert.ok(shardOf(id) < SHARDS);
});
