// Scraper for Cup Manager competition sites (theuleague.au).
// Each competition edition lives under /<year>,<editionId>/ and publishes a
// statistics page at /<year>,<editionId>/result/statistics, which may link on to
// per-category statistics pages.

import * as cheerio from 'cheerio';
import { getText, mapLimit } from './http.mjs';
import { extractTables, pageTitle, clean } from './parse.mjs';

const EDITION_RE = /\/(\d{4}),(\d+)(?:,[^/]*)?(?=\/|$)/;

function editionPath(href) {
  const m = EDITION_RE.exec(href);
  return m ? `/${m[1]},${m[2]}` : null;
}

async function discoverEditions(source, log) {
  const base = source.base.replace(/\/$/, '');
  const editions = new Set((source.editions ?? []).map((e) => `/${e.replace(/^\/|\/$/g, '')}`));
  for (const page of source.indexPages ?? [`${base}/`]) {
    try {
      const { text } = await getText(page);
      const $ = cheerio.load(text);
      $('a[href]').each((_, a) => {
        const ed = editionPath($(a).attr('href') || '');
        if (ed) editions.add(ed);
      });
    } catch (err) {
      log(`  ! ${page}: ${err.message}`);
    }
  }
  const minYear = source.minYear ?? 0;
  return [...editions].filter((e) => Number(e.slice(1, 5)) >= minYear);
}

const competitionName = (title) => clean(title).replace(/\s*-\s*(Statistics|Results?)\s*$/i, '');

async function scrapeStatsPage(url, log) {
  const { text, url: finalUrl } = await getText(url);
  const $ = cheerio.load(text);
  const title = competitionName(clean($('title').text()) || pageTitle($));
  const lines = extractTables($, { pageTitle: title, pageUrl: finalUrl }).map((l) => ({
    ...l,
    season: l.season || title,
    competition: l.competition && l.competition !== title ? l.competition : title,
  }));
  const more = new Set();
  $('a[href]').each((_, a) => {
    try {
      const href = new URL($(a).attr('href'), finalUrl);
      href.hash = '';
      if (href.host === new URL(finalUrl).host && /\/result\/statistics\/.+/.test(href.pathname)) more.add(href.href);
    } catch { /* ignore */ }
  });
  return { lines, more: [...more] };
}

export async function scrapeCupManager(source, log) {
  const base = source.base.replace(/\/$/, '');
  const editions = await discoverEditions(source, log);
  log(`  ${editions.length} competition editions`);
  const seen = new Set();
  const lines = [];
  const queue = editions.map((e) => `${base}${e}/result/statistics`);
  const maxPages = source.maxPages ?? 400;
  while (queue.length && seen.size < maxPages) {
    const batch = queue.splice(0, 8).filter((u) => !seen.has(u));
    batch.forEach((u) => seen.add(u));
    const results = await mapLimit(batch, 2, async (url) => {
      try {
        return await scrapeStatsPage(url, log);
      } catch (err) {
        log(`  ! ${url}: ${err.message}`);
        return { lines: [], more: [] };
      }
    });
    for (const r of results) {
      lines.push(...r.lines);
      for (const u of r.more) if (!seen.has(u)) queue.push(u);
    }
  }
  // Category pages repeat rows already shown on the edition page; keep one per player/team/edition.
  const unique = new Map();
  for (const l of lines) {
    const key = [l.name, l.team, l.season].join('|').toLowerCase();
    const prev = unique.get(key);
    if (!prev || (l.pts ?? 0) > (prev.pts ?? 0)) unique.set(key, l);
  }
  return { lines: [...unique.values()], method: 'Cup Manager statistics pages' };
}
