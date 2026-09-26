#!/usr/bin/env node
// Scrape every source in sources.json and write the site's data files:
//   ../data/index.json, ../data/players/<n>.json
// Per-source caches live in ../data/cache (kept between runs by the GitHub Action).
// If a source fails, its lines from the last successful run are reused and marked stale.
// Usage: node scrape.mjs [sourceId ...]   (other sources are served from cache)

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scrapeSsb } from './lib/ssb.mjs';
import { scrapeCupManager } from './lib/cupmanager.mjs';
import { buildDataset } from './lib/dataset.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const DATA = here('../data/');
const CACHE = here('../data/cache/');
const SCRAPERS = { ssb: scrapeSsb, cupmanager: scrapeCupManager };

const sources = JSON.parse(await readFile(here('./sources.json'), 'utf8'));
const only = process.argv.slice(2);
await mkdir(CACHE, { recursive: true });

async function readLinesCache(id) {
  try { return JSON.parse(await readFile(`${CACHE}${id}-lines.json`, 'utf8')); } catch { return null; }
}

const results = [];
for (const source of sources) {
  const log = (msg) => console.log(`[${source.id}] ${msg}`);
  const cached = await readLinesCache(source.id);
  if (only.length && !only.includes(source.id)) {
    results.push({ source, ok: !!cached, method: cached?.method, error: cached ? null : 'not scraped yet', lines: cached?.lines ?? [], scrapedAt: cached?.scrapedAt });
    continue;
  }
  log(`scraping ${source.base}`);
  const started = Date.now();
  try {
    const { lines, method, error } = await SCRAPERS[source.type](source, log, { cacheDir: CACHE });
    if (!lines.length) throw new Error(error || 'no player stats found (the site may have changed)');
    const scrapedAt = new Date().toISOString();
    log(`${lines.length} stat lines via ${method} in ${Math.round((Date.now() - started) / 1000)}s${error ? ` (with errors: ${error})` : ''}`);
    await writeFile(`${CACHE}${source.id}-lines.json`, JSON.stringify({ scrapedAt, method, lines }));
    results.push({ source, ok: !error, method, error, lines: error ? lines.map((l) => ({ ...l, stale: true })) : lines, scrapedAt });
  } catch (err) {
    log(`FAILED: ${err.message}`);
    results.push({
      source, ok: false, error: err.message, method: cached?.method,
      lines: (cached?.lines ?? []).map((l) => ({ ...l, stale: true })),
      scrapedAt: cached?.scrapedAt,
    });
  }
}

const { index, shards } = buildDataset(results);
await rm(`${DATA}players`, { recursive: true, force: true });
await mkdir(`${DATA}players`, { recursive: true });
for (const [n, data] of shards) await writeFile(`${DATA}players/${n}.json`, JSON.stringify(data));
await writeFile(`${DATA}index.json`, JSON.stringify(index));
console.log(`wrote ${index.players.length} players; sources OK: ${index.sources.filter((s) => s.ok).map((s) => s.id).join(', ') || 'none'}`);
for (const s of index.sources) if (!s.ok) console.log(`  ${s.id}: ${s.error}`);
if (!index.players.length) process.exitCode = 1;
