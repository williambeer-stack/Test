// Scraper for WordPress sites running the SportsPress plugin
// (Sydney Social Basketball, the older theuleague.org.au site).
// Tries the SportsPress REST API first, then falls back to crawling HTML
// player-list / player-profile pages.

import * as cheerio from 'cheerio';
import { getJson, getText, mapLimit } from './http.mjs';
import { extractTables, fieldForHeader, toNumber, normaliseLine, pageTitle, clean } from './parse.mjs';

const stripHtml = (s) => clean(cheerio.load(`<div>${s ?? ''}</div>`)('div').text());

async function paginate(url, log, maxPages = 200) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const { json, headers } = await getJson(`${url}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(json)) break;
    items.push(...json);
    const total = Number(headers.get('x-wp-totalpages') || 1);
    if (page >= total || json.length === 0) break;
    if (page % 10 === 0) log(`  …${items.length} records`);
  }
  return items;
}

async function termNames(base, type) {
  try {
    const items = await paginate(`${base}/wp-json/sportspress/v2/${type}?_fields=id,name,title`, () => {}, 20);
    return new Map(items.map((t) => [String(t.id), stripHtml(t.name ?? t.title?.rendered)]));
  } catch {
    return new Map();
  }
}

// SportsPress REST "statistics" field: { [leagueId]: { [seasonId]: { name, team, <stat>: value } } }
// Season key "0" holds column labels and "-1" the career total; both are skipped.
export function linesFromRestPlayer(player, { leagues, seasons, source }) {
  const name = stripHtml(player.title?.rendered ?? player.title);
  const stats = player.statistics;
  if (!name || !stats || typeof stats !== 'object') return [];
  const lines = [];
  for (const [leagueId, bySeason] of Object.entries(stats)) {
    if (!bySeason || typeof bySeason !== 'object') continue;
    const labels = bySeason['0'] || {};
    for (const [seasonId, row] of Object.entries(bySeason)) {
      if (seasonId === '0' || seasonId === '-1' || !row || typeof row !== 'object') continue;
      const line = { name };
      for (const [key, raw] of Object.entries(row)) {
        if (key === 'name' || key === 'team') continue;
        const field = fieldForHeader(key) || fieldForHeader(labels[key] ?? '');
        if (!field || ['name', 'team', 'season', 'number'].includes(field)) continue;
        const n = toNumber(stripHtml(raw));
        if (n != null) line[field] = n;
      }
      if (Object.keys(line).length === 1) continue;
      lines.push(normaliseLine({
        ...line,
        team: stripHtml(row.team),
        competition: leagues.get(String(leagueId)) || source.name,
        season: seasons.get(String(seasonId)) || stripHtml(row.name) || '',
        url: player.link,
        playerUrl: player.link,
      }));
    }
  }
  return lines;
}

async function viaRest(source, log) {
  const base = source.base.replace(/\/$/, '');
  const players = await paginate(
    `${base}/wp-json/sportspress/v2/players?_fields=id,title,link,statistics`,
    log,
    source.maxRestPages ?? 200,
  );
  log(`  REST returned ${players.length} players`);
  const [leagues, seasons] = await Promise.all([termNames(base, 'leagues'), termNames(base, 'seasons')]);
  return players.flatMap((p) => linesFromRestPlayer(p, { leagues, seasons, source }));
}

async function sitemapUrls(base, log) {
  const found = new Set();
  const seen = new Set();
  const queue = [`${base}/wp-sitemap.xml`, `${base}/sitemap_index.xml`, `${base}/sitemap.xml`];
  while (queue.length && seen.size < 60) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let text;
    try { ({ text } = await getText(url)); } catch { continue; }
    const $ = cheerio.load(text, { xmlMode: true });
    $('sitemap > loc').each((_, el) => {
      const loc = clean($(el).text());
      if (/(sp_player|sp_list|player|list)/i.test(loc)) queue.push(loc);
    });
    $('url > loc').each((_, el) => found.add(clean($(el).text())));
  }
  log(`  sitemaps listed ${found.size} URLs`);
  return [...found];
}

async function linksFrom(pages, pattern) {
  const out = new Set();
  const re = new RegExp(pattern);
  for (const page of pages) {
    try {
      const { text, url } = await getText(page);
      const $ = cheerio.load(text);
      $('a[href]').each((_, a) => {
        try {
          const href = new URL($(a).attr('href'), url);
          href.hash = '';
          if (href.host === new URL(url).host && re.test(href.pathname)) out.add(href.href);
        } catch { /* ignore bad hrefs */ }
      });
    } catch { /* index page unreachable */ }
  }
  return [...out];
}

async function scrapePages(urls, { asPlayerPages, log }) {
  let done = 0;
  const results = await mapLimit(urls, 2, async (url) => {
    try {
      const { text, url: finalUrl } = await getText(url);
      const $ = cheerio.load(text);
      const title = pageTitle($);
      const lines = extractTables($, {
        pageTitle: title,
        pageUrl: finalUrl,
        playerName: asPlayerPages ? title : undefined,
      });
      if (++done % 100 === 0) log(`  …${done}/${urls.length} pages`);
      return lines;
    } catch (err) {
      log(`  ! ${url}: ${err.message}`);
      return [];
    }
  });
  return results.flat();
}

async function viaHtml(source, log) {
  const base = source.base.replace(/\/$/, '');
  const fromSitemap = await sitemapUrls(base, log);
  const fromIndex = await linksFrom(source.indexPages ?? [], source.listLinkPattern ?? '/(list|player-stats)/');
  const all = [...new Set([...fromSitemap, ...fromIndex])];

  const listRe = new RegExp(source.listLinkPattern ?? '/(list|player-stats)/');
  const playerRe = new RegExp(source.playerLinkPattern ?? '/player/[^/]+/?$');
  const lists = all.filter((u) => listRe.test(new URL(u).pathname));
  const players = all.filter((u) => playerRe.test(new URL(u).pathname)).slice(0, source.maxPlayerPages ?? 5000);
  log(`  found ${lists.length} list pages, ${players.length} player pages`);

  // Profile pages carry every season for a player, so prefer them unless the source
  // is configured to use its stat-list pages (avoids counting the same games twice).
  if (players.length && source.prefer !== 'lists') {
    return scrapePages(players, { asPlayerPages: true, log });
  }
  return scrapePages(lists, { asPlayerPages: false, log }).then((lines) =>
    lines.map((l) => ({ ...l, competition: l.competition || source.name })),
  );
}

export async function scrapeSportsPress(source, log) {
  if (source.useRest !== false) {
    try {
      const lines = await viaRest(source, log);
      if (lines.length) return { lines, method: 'SportsPress REST API' };
      log('  REST API gave no statistics; falling back to HTML');
    } catch (err) {
      log(`  REST API unavailable (${err.message}); falling back to HTML`);
    }
  }
  return { lines: await viaHtml(source, log), method: 'HTML pages' };
}
