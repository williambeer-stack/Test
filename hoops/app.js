(() => {
  'use strict';

  const STATS = ['gp', 'pts', 'reb', 'ast', 'stl', 'blk', 'threes'];
  const LABELS = { gp: 'GP', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', threes: '3PM' };
  const PER_GAME = { pts: 'PPG', reb: 'RPG', ast: 'APG', stl: 'SPG', blk: 'BPG' };
  const MIN_GAMES = 3;

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const norm = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : n.toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d }));

  // ---------- theme ----------
  const savedTheme = store.get('hoops-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('hoops-theme', next);
  });

  // ---------- data ----------
  const demo = new URLSearchParams(location.search).has('demo');
  let data = { sources: [], players: [] };
  let sourceById = new Map();
  let playerById = new Map();
  let enabled = new Set();

  const TOTAL_KEYS = ['gp', 'pts', 'reb', 'ast', 'stl', 'blk'];

  // Per-source totals for a list of stat lines, in the same shape as index.json.
  function sourceTotals(entries) {
    const out = {};
    for (const e of entries) {
      const t = (out[e.src] ??= TOTAL_KEYS.map(() => 0));
      TOTAL_KEYS.forEach((k, i) => { t[i] += e[k] ?? 0; });
    }
    return out;
  }

  // index.json: { sources, shards, players: [[id, name, teams, {src: [gp, pts, reb, ast, stl, blk]}]] }
  // players/<n>.json: { id: [stat lines] }. demo.json carries every player's lines inline.
  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  async function load() {
    $('#demoBanner').hidden = !demo;
    try {
      if (demo) {
        const d = await fetchJson('data/demo.json');
        data = { ...d, players: d.players.map((p) => ({ ...p, teams: [...new Set(p.entries.map((e) => e.team))].slice(0, 3).join(', '), totals: sourceTotals(p.entries) })) };
      } else {
        const d = await fetchJson('data/index.json');
        data = { ...d, players: d.players.map(([id, name, teams, totals]) => ({ id, name, teams, totals })) };
      }
    } catch (err) {
      if (err.status === 404) data = { sources: [], players: [] };
      else {
        $('#view').innerHTML = `<div class="empty-state"><h2>Couldn't load the stats file</h2><p>${esc(err.message)}. If you opened this page straight from disk, serve the folder instead, for example <code>npx serve hoops</code>.</p></div>`;
        return;
      }
    }
    for (const p of data.players) p.key = norm(p.name);
    sourceById = new Map(data.sources.map((s) => [s.id, s]));
    playerById = new Map(data.players.map((p) => [p.id, p]));
    let saved = null;
    try { saved = JSON.parse(store.get('hoops-sources') || 'null'); } catch { /* ignore */ }
    enabled = new Set(data.sources.map((s) => s.id).filter((id) => !saved || saved.includes(id)));
    renderSourceFilter();
    renderSources();
    route();
  }

  const visibleEntries = (p) => p.entries.filter((e) => enabled.has(e.src));
  const visibleSources = (p) => Object.keys(p.totals).filter((src) => enabled.has(src));

  // Career summary over the selected competitions, from the index totals.
  function summary(p) {
    const t = { comps: visibleSources(p).length };
    TOTAL_KEYS.forEach((k, i) => { t[k] = visibleSources(p).reduce((sum, src) => sum + p.totals[src][i], 0); });
    for (const [k, label] of Object.entries(PER_GAME)) t[label] = t.gp ? t[k] / t.gp : null;
    return t;
  }

  const shardCache = new Map();
  function shardOf(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % (data.shards || 64);
  }
  async function loadEntries(p) {
    if (p.entries) return p.entries;
    const n = shardOf(p.id);
    if (!shardCache.has(n)) shardCache.set(n, fetchJson(`data/players/${n}.json`));
    p.entries = (await shardCache.get(n))[p.id] ?? [];
    return p.entries;
  }

  function totals(entries) {
    const t = { comps: new Set(), teams: new Set() };
    for (const k of STATS) t[k] = null;
    // Per-game averages only use lines that report games played.
    const withGp = { gp: 0 };
    for (const e of entries) {
      t.comps.add(e.src);
      if (e.team) t.teams.add(e.team);
      for (const k of STATS) if (e[k] != null) t[k] = (t[k] ?? 0) + e[k];
      if (e.gp) {
        withGp.gp += e.gp;
        for (const k of Object.keys(PER_GAME)) if (e[k] != null) withGp[k] = (withGp[k] ?? 0) + e[k];
      }
    }
    for (const [k, label] of Object.entries(PER_GAME)) t[label] = withGp.gp && withGp[k] != null ? withGp[k] / withGp.gp : null;
    return t;
  }

  // ---------- source chips & list ----------
  function renderSourceFilter() {
    const box = $('#sourceFilter');
    if (data.sources.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = data.sources.map((s) => `
      <label class="chip"><input type="checkbox" value="${esc(s.id)}" ${enabled.has(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');
    box.onchange = (ev) => {
      const id = ev.target.value;
      if (ev.target.checked) enabled.add(id); else enabled.delete(id);
      store.set('hoops-sources', JSON.stringify([...enabled]));
      route();
      if ($('#search').value) suggest();
    };
  }

  function ago(iso) {
    if (!iso) return 'never';
    const days = Math.floor((Date.now() - new Date(iso)) / 864e5);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  function renderSources() {
    $('#sourceList').innerHTML = data.sources.map((s) => {
      const status = s.ok
        ? `<span class="status ok">✓ Updated</span>`
        : `<span class="status bad">✕ Last scrape failed</span>`;
      const meta = [
        `${fmt(s.entries)} stat lines`,
        s.scrapedAt ? `data from ${ago(s.scrapedAt)}` : 'no data yet',
        s.method ? `via ${s.method}` : '',
        !s.ok && s.error ? s.error : '',
      ].filter(Boolean).map(esc).join(' · ');
      return `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> ${status} <span class="meta">${meta}</span></li>`;
    }).join('');
    $('#updated').textContent = data.generatedAt ? `Stats file built ${new Date(data.generatedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  }

  // ---------- search ----------
  const input = $('#search');
  const list = $('#suggestions');
  let matches = [];
  let active = -1;

  function search(q) {
    const nq = norm(q);
    if (!nq) return [];
    const terms = nq.split(' ');
    const out = [];
    for (const p of data.players) {
      if (!visibleSources(p).length) continue;
      const words = p.key.split(' ');
      if (!terms.every((t) => words.some((w) => w.startsWith(t)) || p.key.includes(t))) continue;
      let score = 0;
      if (p.key === nq) score += 100;
      if (p.key.startsWith(nq)) score += 50;
      score += terms.filter((t) => words.some((w) => w.startsWith(t))).length * 10;
      score += Math.min(summary(p).gp, 9);
      out.push([score, p]);
    }
    return out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, 12).map((x) => x[1]);
  }

  function highlight(name, q) {
    const terms = norm(q).split(' ').filter(Boolean);
    return name.split(/(\s+)/).map((word) => {
      const t = terms.find((t) => norm(word).startsWith(t));
      return t ? `<mark>${esc(word.slice(0, t.length))}</mark>${esc(word.slice(t.length))}` : esc(word);
    }).join('');
  }

  function suggest() {
    const q = input.value;
    matches = search(q);
    active = matches.length ? 0 : -1;
    if (!q.trim()) { closeList(); return; }
    list.innerHTML = matches.length
      ? matches.map((p, i) => {
          const teams = p.teams;
          const comps = visibleSources(p).length;
          return `<li role="option" id="opt-${i}" data-id="${esc(p.id)}" aria-selected="${i === active}">
            <span class="s-name">${highlight(p.name, q)}</span>
            <span class="s-meta">${esc(teams)}${teams ? ' · ' : ''}${comps} comp${comps === 1 ? '' : 's'}</span></li>`;
        }).join('')
      : `<li class="empty">No players match “${esc(q)}”</li>`;
    list.hidden = false;
    $('#searchBox').setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
  }

  function closeList() {
    list.hidden = true;
    $('#searchBox').setAttribute('aria-expanded', 'false');
  }

  function setActive(i) {
    active = i;
    list.querySelectorAll('li[role=option]').forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    input.setAttribute('aria-activedescendant', `opt-${i}`);
    list.querySelector(`#opt-${i}`)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(id) {
    closeList();
    input.value = '';
    location.hash = `#/player/${encodeURIComponent(id)}`;
  }

  input.addEventListener('input', suggest);
  input.addEventListener('focus', () => { if (input.value) suggest(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' && matches.length) { ev.preventDefault(); setActive((active + 1) % matches.length); }
    else if (ev.key === 'ArrowUp' && matches.length) { ev.preventDefault(); setActive((active - 1 + matches.length) % matches.length); }
    else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); choose(matches[active].id); }
    else if (ev.key === 'Escape') closeList();
  });
  list.addEventListener('mousedown', (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (li) { ev.preventDefault(); choose(li.dataset.id); }
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('#searchBox')) closeList(); });

  // ---------- routing ----------
  function route() {
    const m = /^#\/player\/(.+)$/.exec(location.hash);
    const player = m && playerById.get(decodeURIComponent(m[1]));
    if (!player) return renderHome();
    if (player.entries) return renderPlayer(player);
    $('#view').innerHTML = `<a class="back" href="#/">← All players</a><div class="card empty-state"><h2>${esc(player.name)}</h2><p>Loading stats…</p></div>`;
    loadEntries(player)
      .then(() => { if (location.hash === m[0]) renderPlayer(player); })
      .catch((err) => { $('#view').innerHTML = `<a class="back" href="#/">← All players</a><div class="card empty-state"><h2>${esc(player.name)}</h2><p>Couldn't load stats: ${esc(err.message)}</p></div>`; });
  }
  window.addEventListener('hashchange', () => { route(); window.scrollTo({ top: 0 }); });

  // ---------- home: leaders ----------
  let leaderSort = 'PPG';

  function renderHome() {
    document.title = 'Sydney Hoops Stats';
    const view = $('#view');
    if (!data.players.length) {
      view.innerHTML = `<div class="card empty-state">
        <h2>No stats scraped yet</h2>
        <p>Nothing has been scraped yet. Run the scraper (<code>cd hoops/scraper && npm install && npm run scrape</code>) or trigger the <strong>Scrape Sydney basketball stats</strong> GitHub Action. Want to look around first? <a href="?demo=1">Open the demo</a>.</p>
      </div>`;
      return;
    }
    const rows = data.players.map((p) => ({ p, t: summary(p) })).filter((r) => r.t.comps);
    const perGameSort = Object.values(PER_GAME).includes(leaderSort);
    const eligible = rows.filter((r) => !perGameSort || (r.t.gp ?? 0) >= MIN_GAMES);
    const val = (r) => r.t[leaderSort] ?? -1;
    eligible.sort((a, b) => val(b) - val(a) || a.p.name.localeCompare(b.p.name));
    const top = eligible.slice(0, 25);
    const cols = ['gp', 'pts', 'PPG', 'RPG', 'APG'];
    const head = (k) => `<th><button data-sort="${k}" ${leaderSort === k ? 'aria-sort="descending"' : ''}>${LABELS[k] ?? k}${leaderSort === k ? ' ↓' : ''}</button></th>`;

    view.innerHTML = `
      <div class="tiles">
        ${tile('Players', fmt(rows.length))}
        ${tile('Leagues', fmt(data.sources.filter((s) => enabled.has(s.id) && s.entries).length))}
        ${tile('Stat lines', fmt(data.sources.filter((s) => enabled.has(s.id)).reduce((sum, s) => sum + (s.entries || 0), 0)))}
      </div>
      <div class="card">
        <h2>Leaders across all selected comps</h2>
        <p class="sub">${perGameSort ? `Per-game leaders need at least ${MIN_GAMES} games played. ` : ''}Click a column to sort, or a name to see that player.</p>
        <div class="table-wrap"><table>
          <thead><tr><th class="l">#</th><th class="l">Player</th><th class="l">Teams</th>${cols.map(head).join('')}</tr></thead>
          <tbody>${top.map((r, i) => `<tr>
            <td class="l">${i + 1}</td>
            <td class="l"><a class="row-link" href="#/player/${encodeURIComponent(r.p.id)}">${esc(r.p.name)}</a></td>
            <td class="l">${esc(r.p.teams)}</td>
            <td>${fmt(r.t.gp)}</td><td>${fmt(r.t.pts)}</td><td>${fmt(r.t.PPG, 1)}</td><td>${fmt(r.t.RPG, 1)}</td><td>${fmt(r.t.APG, 1)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    view.querySelectorAll('th button[data-sort]').forEach((b) => b.addEventListener('click', () => { leaderSort = b.dataset.sort; renderHome(); }));
  }

  const tile = (label, value, note = '') => `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;

  // ---------- player ----------
  function seasonOrder(e) {
    const text = `${e.season} ${e.comp}`;
    const year = Number((/(20\d\d)/.exec(text) || [])[1] || 0);
    const part = Number((/(?:season|s|term|t)\s*(\d)/i.exec(text) || [])[1] || 0);
    return year * 10 + part;
  }

  function renderPlayer(p) {
    document.title = `${p.name} · Sydney Hoops Stats`;
    const entries = visibleEntries(p).slice().sort((a, b) => seasonOrder(a) - seasonOrder(b));
    const t = totals(entries);
    const view = $('#view');
    if (!entries.length) {
      view.innerHTML = `<a class="back" href="#/">← All players</a><div class="card empty-state"><h2>${esc(p.name)}</h2><p>No stats in the competitions you've selected. Tick more competitions above.</p></div>`;
      return;
    }
    const has = (k) => entries.some((e) => e[k] != null);
    const cols = STATS.filter(has);
    const showPpg = entries.some((e) => e.gp && e.pts != null);

    view.innerHTML = `
      <a class="back" href="#/">← All players</a>
      <div class="player-head">
        <div>
          <h2>${esc(p.name)}</h2>
          <div class="teams">${esc([...t.teams].join(' · '))}</div>
        </div>
        <div class="chips">${[...t.comps].map((id) => `<span class="chip static">${esc(sourceById.get(id)?.name ?? id)}</span>`).join('')}</div>
      </div>
      <div class="tiles">
        ${tile('Games', fmt(t.gp), t.gp == null ? 'not recorded' : '')}
        ${tile('Points', fmt(t.pts))}
        ${t.PPG != null ? tile('Points / game', fmt(t.PPG, 1)) : ''}
        ${t.RPG != null ? tile('Rebounds / game', fmt(t.RPG, 1)) : has('reb') ? tile('Rebounds', fmt(t.reb)) : ''}
        ${t.APG != null ? tile('Assists / game', fmt(t.APG, 1)) : has('ast') ? tile('Assists', fmt(t.ast)) : ''}
        ${t.SPG != null ? tile('Steals / game', fmt(t.SPG, 1)) : ''}
        ${t.BPG != null ? tile('Blocks / game', fmt(t.BPG, 1)) : ''}
      </div>
      ${showPpg && entries.filter((e) => e.gp && e.pts != null).length > 1 ? `
      <div class="card">
        <h3>Points per game by season</h3>
        <svg class="chart" id="ppgChart" role="img" aria-label="Points per game for each season and competition"></svg>
      </div>` : ''}
      <div class="card">
        <h3>Every competition</h3>
        <div class="table-wrap"><table>
          <thead><tr><th class="l">Competition</th><th class="l">Season</th><th class="l">Team</th>${cols.map((k) => `<th>${LABELS[k]}</th>`).join('')}${showPpg ? '<th>PPG</th>' : ''}</tr></thead>
          <tbody>${entries.map((e) => `<tr>
            <td class="l"><span class="src-tag">${esc(shortSource(e.src))}</span>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.comp || 'View')}</a>` : esc(e.comp)}${e.stale ? ' <span class="stale" title="The latest scrape of this source failed, so this line is from an earlier run">(older data)</span>' : ''}</td>
            <td class="l">${esc(e.season)}</td>
            <td class="l">${esc(e.team)}</td>
            ${cols.map((k) => `<td>${fmt(e[k])}</td>`).join('')}
            ${showPpg ? `<td>${e.gp && e.pts != null ? fmt(e.pts / e.gp, 1) : '–'}</td>` : ''}
          </tr>`).join('')}
          ${entries.length > 1 ? `<tr><td class="l"><strong>Total</strong></td><td></td><td></td>${cols.map((k) => `<td><strong>${fmt(t[k])}</strong></td>`).join('')}${showPpg ? `<td><strong>${fmt(t.PPG, 1)}</strong></td>` : ''}</tr>` : ''}
          </tbody>
        </table></div>
        <p class="fine">Matched by name. If some of these lines belong to someone else with the same name, the team column is the best clue.</p>
      </div>`;
    drawPpgChart(entries.filter((e) => e.gp && e.pts != null));
  }

  function shortSource(id) {
    const src = sourceById.get(id);
    if (src?.short) return src.short;
    return (src?.name ?? id).replace(/\s*\(.*\)$/, '').split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  }

  // ---------- chart ----------
  const tip = $('#tooltip');
  function showTip(ev, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14;
    let y = ev.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y < 8) y = ev.clientY + 16;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  function drawPpgChart(entries) {
    const svg = $('#ppgChart');
    if (!svg || entries.length < 2) return;
    const W = svg.clientWidth || 600;
    const H = 220;
    const m = { t: 20, r: 8, b: 28, l: 32 };
    const vals = entries.map((e) => e.pts / e.gp);
    const tickStep = Math.max(...vals) > 30 ? 10 : 5;
    const max = Math.max(tickStep, Math.ceil(Math.max(...vals) / tickStep) * tickStep);
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const step = iw / entries.length;
    const bw = Math.max(6, Math.min(48, step - 6));
    const y = (v) => m.t + ih - (v / max) * ih;
    const ticks = Array.from({ length: max / tickStep + 1 }, (_, i) => i * tickStep);
    const best = vals.indexOf(Math.max(...vals));
    const last = vals.length - 1;
    const label = (e) => (e.season || e.comp || '').replace(/^.*?(20\d\d)/, '$1').replace(/[()]/g, '').trim().slice(0, 16);
    const showEvery = Math.ceil(entries.length / Math.max(1, Math.floor(iw / 80)));

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `
      ${ticks.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
      ${entries.map((e, i) => {
        const cx = m.l + step * i + step / 2;
        const h = Math.max(1, y(0) - y(vals[i]));
        const top = y(vals[i]);
        const r = Math.min(4, bw / 2, h);
        const path = `M${cx - bw / 2},${y(0)} V${top + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${y(0)} Z`;
        return `<path class="bar" d="${path}"/>
          ${i === best || i === last ? `<text class="val" x="${cx}" y="${top - 5}" text-anchor="middle">${fmt(vals[i], 1)}</text>` : ''}
          ${i % showEvery === 0 ? `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(label(e))}</text>` : ''}
          <rect class="hit" data-i="${i}" x="${m.l + step * i}" y="${m.t}" width="${step}" height="${ih}"/>`;
      }).join('')}`;
    svg.querySelectorAll('.hit').forEach((rect) => {
      const e = entries[Number(rect.dataset.i)];
      const html = `<strong>${fmt(e.pts / e.gp, 1)} PPG</strong><br>${esc(e.comp)}${e.season ? ` · ${esc(e.season)}` : ''}<br>${esc(e.team)} · ${fmt(e.pts)} pts in ${fmt(e.gp)} games`;
      rect.addEventListener('mousemove', (ev) => showTip(ev, html));
      rect.addEventListener('mouseleave', hideTip);
    });
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (location.hash.startsWith('#/player/')) route(); }, 150); });

  load();
})();
