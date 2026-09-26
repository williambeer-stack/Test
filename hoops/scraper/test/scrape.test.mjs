import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { extractTables, nameKey, cleanName, parseRobots } from '../lib/index.mjs';
import { scrapeSportsPress, linesFromRestPlayer } from '../lib/sportspress.mjs';
import { scrapeCupManager } from '../lib/cupmanager.mjs';
import { buildDataset } from '../lib/dataset.mjs';

process.env.SCRAPE_DELAY_MS = '0';
const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const quiet = () => {};

let server;
let base;
before(async () => {
  const routes = {
    '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /wp-admin/\n'],
    '/sp/': ['text/html', '<a href="/sp/player-stats/mens-div-1/">Div 1</a>'],
    '/sp/player-stats/mens-div-1/': ['text/html', fx('sp-list.html')],
    '/sp/wp-json/sportspress/v2/players': ['text/html', 'not json'],
    '/rest/wp-json/sportspress/v2/players': ['application/json', fx('sp-rest-players.json')],
    '/rest/wp-json/sportspress/v2/leagues': ['application/json', '[{"id":5,"name":"Glebe Tuesday Men\'s"}]'],
    '/rest/wp-json/sportspress/v2/seasons': ['application/json', '[{"id":31,"name":"2025 Season 2"}]'],
    '/pl/': ['text/html', '<a href="/pl/player/jordan-lee/">Jordan</a>'],
    '/pl/player/jordan-lee/': ['text/html', fx('sp-player.html')],
    '/cm/': ['text/html', '<a href="/2026,61202976/result">Season 1</a>'],
    '/2026,61202976/result/statistics': ['text/html', fx('cm-stats.html')],
    '/2026,61202976/result/statistics/category/75845599': ['text/html', fx('cm-category.html')],
  };
  server = http.createServer((req, res) => {
    const route = routes[req.url.split('?')[0]];
    if (!route) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': route[0], 'x-wp-totalpages': '1' });
    res.end(route[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('name helpers', () => {
  assert.equal(cleanName('JORDAN LEE (#7)'), 'JORDAN LEE');
  assert.equal(cleanName('12 Mia Chen'), 'Mia Chen');
  assert.equal(nameKey("Sam O'Brien"), nameKey('sam obrien'));
  assert.equal(nameKey('José  Núñez'), 'jose nunez');
});

test('robots parsing', () => {
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /x\n\nUser-agent: *\nDisallow: /wp-admin/'), ['/wp-admin/']);
});

test('SportsPress player list table', () => {
  const $ = cheerio.load(fx('sp-list.html'));
  const lines = extractTables($, { pageTitle: 'Div 1', pageUrl: 'https://x.test/player-stats/d1/' });
  assert.equal(lines.length, 2, 'total row skipped');
  assert.deepEqual(lines[0], {
    name: 'Jordan Lee', team: 'Airballers', gp: 10, pts: 184, reb: 52, ast: 31, stl: 12, blk: 3, threes: 22,
    competition: "Men's Division 1 – 2024 Season 2",
    url: 'https://x.test/player-stats/d1/', playerUrl: 'https://x.test/player/jordan-lee/',
  });
});

test('SportsPress player profile table', () => {
  const $ = cheerio.load(fx('sp-player.html'));
  const lines = extractTables($, { pageTitle: 'Jordan Lee', pageUrl: 'https://x.test/player/jordan-lee/', playerName: 'Jordan Lee' });
  assert.equal(lines.length, 2);
  assert.equal(lines[1].season, '2025 S2');
  assert.equal(lines[1].pts, 112);
  assert.equal(lines[1].competition, "Glebe Tuesday Men's");
});

test('SportsPress REST statistics', () => {
  const [p] = JSON.parse(fx('sp-rest-players.json'));
  const lines = linesFromRestPlayer(p, { leagues: new Map([['5', 'Glebe']]), seasons: new Map([['31', '2025 S2']]), source: { name: 'SSB' } });
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], url: undefined, playerUrl: undefined }, {
    name: 'Priya Nair', gp: 6, pts: 72, reb: 20, ast: 14, team: 'Swish', competition: 'Glebe', season: '2025 S2', url: undefined, playerUrl: undefined,
  });
});

test('SportsPress site: REST fails, falls back to list pages', async () => {
  const { lines, method } = await scrapeSportsPress(
    { name: 'U', base: `${base}/sp`, indexPages: [`${base}/sp/`], listLinkPattern: '/player-stats/[^/]+/?$', prefer: 'lists' }, quiet);
  assert.equal(method, 'HTML pages');
  assert.equal(lines.length, 2);
});

test('SportsPress site via REST', async () => {
  const { lines, method } = await scrapeSportsPress({ name: 'R', base: `${base}/rest` }, quiet);
  assert.equal(method, 'SportsPress REST API');
  assert.equal(lines[0].competition, "Glebe Tuesday Men's");
  assert.equal(lines[0].season, '2025 Season 2');
});

test('SportsPress site via player profile pages', async () => {
  const { lines } = await scrapeSportsPress({ name: 'P', base: `${base}/pl`, useRest: false, indexPages: [`${base}/pl/`], listLinkPattern: '/player/' }, quiet);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.name === 'Jordan Lee'));
});

test('Cup Manager statistics + category pages, deduped', async () => {
  const { lines } = await scrapeCupManager({ base, indexPages: [`${base}/cm/`] }, quiet);
  const names = lines.map((l) => l.name).sort();
  assert.deepEqual(names, ['JORDAN LEE', 'Mia Chen']);
  assert.equal(lines.find((l) => l.name === 'Mia Chen').season, 'The U League 2026 (Season 1)');
});

test('dataset merges people across sources and keeps stale data on failure', () => {
  const src = (id) => ({ id, name: id, base: `https://${id}.test` });
  const first = buildDataset([
    { source: src('a'), ok: true, method: 'm', lines: [{ name: 'Jordan Lee', team: 'X', competition: 'C', season: 'S', pts: 10, gp: 1 }] },
    { source: src('b'), ok: true, method: 'm', lines: [{ name: 'JORDAN LEE', team: 'Y', competition: 'D', season: 'S', pts: 20 }] },
  ], null);
  assert.equal(first.players.length, 1);
  assert.equal(first.players[0].name, 'Jordan Lee');
  assert.equal(first.players[0].entries.length, 2);

  const second = buildDataset([
    { source: src('a'), ok: true, method: 'm', lines: [] },
    { source: src('b'), ok: false, error: 'HTTP 503', lines: [] },
  ], first);
  assert.equal(second.players.length, 1);
  assert.equal(second.players[0].entries[0].stale, true);
  assert.equal(second.sources[1].error, 'HTTP 503');
});
