#!/usr/bin/env node
// Scrape every source in sources.json and write ../data/players.json.
// Usage: node scrape.mjs [sourceId ...]
// If a source fails, its entries from the previous run are kept and marked stale.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scrapeSportsPress } from './lib/sportspress.mjs';
import { scrapeCupManager } from './lib/cupmanager.mjs';
import { buildDataset } from './lib/dataset.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const OUT = here('../data/players.json');
const SCRAPERS = { sportspress: scrapeSportsPress, cupmanager: scrapeCupManager };

const sources = JSON.parse(await readFile(here('./sources.json'), 'utf8'));
const only = process.argv.slice(2);
let previous = null;
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

const results = [];
for (const source of sources) {
  if (only.length && !only.includes(source.id)) continue;
  let lastProblem = null;
  const log = (msg) => {
    if (/^\s*(!|REST API unavailable)/.test(msg)) lastProblem = msg.trim().replace(/^!\s*/, '');
    console.log(`[${source.id}] ${msg}`);
  };
  log(`scraping ${source.base}`);
  const started = Date.now();
  try {
    const { lines, method } = await SCRAPERS[source.type](source, log);
    if (!lines.length) throw new Error(lastProblem ? `no player stats found; last error: ${lastProblem}` : 'no player stats found (page layout may have changed)');
    log(`${lines.length} stat lines via ${method} in ${Math.round((Date.now() - started) / 1000)}s`);
    results.push({ source, ok: true, method, lines });
  } catch (err) {
    log(`FAILED: ${err.message}`);
    results.push({ source, ok: false, error: err.message, lines: [] });
  }
}

const dataset = buildDataset(results, previous, sources.filter((s) => only.length && !only.includes(s.id)));
await writeFile(OUT, JSON.stringify(dataset) + '\n');
console.log(`wrote ${dataset.players.length} players, ${dataset.sources.filter((s) => s.ok).length}/${dataset.sources.length} sources OK -> ${OUT}`);
if (!dataset.sources.some((s) => s.ok || s.entries)) process.exitCode = 1;
