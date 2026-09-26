// Polite HTTP helpers: one request at a time per host, a small delay between
// requests, retries on transient errors, and a basic robots.txt check.

const UA = 'SydneyHoopsStatsBot/1.0 (+https://github.com/williambeer-stack/test; community stats aggregator)';
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS ?? 400);
const TIMEOUT_MS = 20000;

const hostQueues = new Map();
const robotsCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(host, task) {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    try { return await task(); } finally { await sleep(DELAY_MS); }
  });
  hostQueues.set(host, next);
  return next;
}

async function rawFetch(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function disallowedPaths(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let rules = [];
  try {
    const res = await rawFetch(`${origin}/robots.txt`, 'text/plain');
    if (res.ok) rules = parseRobots(await res.text());
  } catch { /* no robots.txt reachable: treat as allowed */ }
  robotsCache.set(origin, rules);
  return rules;
}

export function parseRobots(txt) {
  const rules = [];
  let applies = false;
  let sawAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const [k, ...rest] = line.replace(/#.*/, '').split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      if (sawAgent) { applies = false; sawAgent = false; }
      if (val === '*' || /sydneyhoops/i.test(val)) applies = true;
    } else {
      sawAgent = true;
      if (applies && key === 'disallow' && val) rules.push(val);
    }
  }
  return rules;
}

async function request(url, accept) {
  const u = new URL(url);
  const rules = await disallowedPaths(u.origin);
  if (rules.some((r) => u.pathname.startsWith(r))) {
    throw new Error(`robots.txt disallows ${u.pathname}`);
  }
  return enqueue(u.host, async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await rawFetch(url, accept);
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (err) {
        lastErr = err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  });
}

export async function getText(url) {
  const res = await request(url, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { text: await res.text(), url: res.url || url };
}

export async function getJson(url) {
  const res = await request(url, 'application/json');
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) throw new Error(`Expected JSON from ${url}, got ${type}`);
  return { json: await res.json(), headers: res.headers };
}

// Run fn over items with limited concurrency (per-host serialisation still applies).
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
