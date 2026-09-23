/* Split Settlement Simulator: a concept model of Hybrid Split Settlement.
 * All money is held in integer cents so every split reconciles exactly:
 *   gross = msf + hq + onseller + storeNet   (for every event)
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
  const aud0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
  const money = c => aud.format(c / 100);
  const money0 = c => aud0.format(c / 100);
  const compact = c => {
    const v = Math.abs(c / 100), s = c < 0 ? '−' : '';
    if (v >= 1e6) return `${s}$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e4) return `${s}$${(v / 1e3).toFixed(1)}k`;
    return s + aud0.format(v);
  };
  const clock = m => {
    const t = 7 * 60 + Math.floor(m);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const toastEl = $('#toast');
  let toastTimer;
  const toast = msg => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  };
  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const poisson = lambda => {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  };

  // ---------------------------------------------------------------- presets
  const PRESETS = {
    qsr: {
      group: 'Grill Bros', hqLabel: 'Franchise HQ', onseller: 'OrderStack POS',
      stores: ['Bondi', 'Parramatta', 'Chatswood', 'Newtown', 'Manly', 'Penrith', 'Hurstville', 'Cronulla'],
      royalty: 6, platformFee: 0.10, markup: 30, msf: 1.0, ticket: 22, volume: 280, refundRate: 1, cbRate: 0.1,
    },
    fitness: {
      group: 'PulseFit', hqLabel: 'Franchise HQ', onseller: 'ClubHub Software',
      stores: ['Fitzroy', 'Richmond', 'St Kilda', 'Box Hill', 'Geelong'],
      royalty: 8, platformFee: 0.25, markup: 40, msf: 1.2, ticket: 65, volume: 60, refundRate: 2, cbRate: 0.4,
    },
    marketplace: {
      group: 'Taskly', hqLabel: 'Marketplace', onseller: 'BookEasy Reseller',
      stores: ['CleanPro', 'FixIt Plumbing', 'Sparky Bros', 'GreenThumb', 'PawWalkers', 'TutorHub', 'MoveMates', 'PaintPerfect', 'KeyCutters', 'SnapPhoto'],
      royalty: 10, platformFee: 0.30, markup: 25, msf: 1.3, ticket: 140, volume: 40, refundRate: 4, cbRate: 0.5,
    },
    pharmacy: {
      group: 'CarePlus', hqLabel: 'Group HQ', onseller: 'ScriptLink POS',
      stores: ['Subiaco', 'Fremantle', 'Joondalup', 'Midland', 'Rockingham', 'Cottesloe'],
      royalty: 4, platformFee: 0.05, markup: 20, msf: 0.9, ticket: 38, volume: 220, refundRate: 1.5, cbRate: 0.1,
    },
  };

  // ---------------------------------------------------------------- state
  const DAY_MIN = 15 * 60; // 07:00 – 22:00
  const hourWeight = m => {
    const h = 7 + m / 60;
    return 0.35 + Math.exp(-((h - 12.5) ** 2) / 2.42) + 0.9 * Math.exp(-((h - 18.5) ** 2) / 3.38);
  };
  const W_TOTAL = (() => { let s = 0; for (let m = 0; m < DAY_MIN; m++) s += hourWeight(m); return s; })();

  const S = {
    presetKey: 'qsr', preset: null, params: {}, net: null,
    cfg: { enabled: true, proRate: true, cbClaw: true, netOff: true, cbFee: 25 },
    day: 1, minute: 0, playing: false, speed: 1,
    live: null, days: [], ledger: [], seq: 0, carry: {},
  };

  function buildNetwork(key) {
    const p = PRESETS[key], rnd = mulberry32(key.length * 7919 + key.charCodeAt(0));
    const digits = n => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');
    const bsb = () => `${7 + Math.floor(rnd() * 2)}${digits(2)}-${digits(3)}`;
    return {
      group: p.group, hqLabel: p.hqLabel,
      hq: { name: `${p.group} ${p.hqLabel === 'Marketplace' ? 'Pty Ltd' : 'HQ'}`, bsb: bsb(), acct: digits(8) },
      onseller: { name: p.onseller, bsb: bsb(), acct: digits(8) },
      stores: p.stores.map((n, i) => ({
        id: i, name: p.hqLabel === 'Marketplace' ? n : `${p.group} ${n}`, short: n,
        mid: `5${digits(7)}`, bsb: bsb(), acct: digits(8), royalty: null, history: [],
      })),
    };
  }

  const emptyAgg = () => ({ count: 0, sales: 0, adj: 0, msf: 0, hq: 0, ons: 0, net: 0, refunds: 0, cbs: 0 });
  function newLive() {
    return { total: emptyAgg(), perStore: S.net.stores.map(emptyAgg) };
  }
  function addAgg(a, e) {
    a.count++;
    if (e.gross >= 0) a.sales += e.gross; else a.adj += e.gross;
    a.msf += e.msf; a.hq += e.hq; a.ons += e.ons; a.net += e.net;
    if (e.type === 'refund') a.refunds++;
    if (e.type === 'chargeback') a.cbs++;
  }

  // ---------------------------------------------------------------- split engine
  const royaltyFor = st => (st.royalty ?? S.params.royalty);

  function splitSale(st, grossC) {
    const P = S.params;
    const msf = Math.round(grossC * P.msf / 100);
    let hq = 0, onsFixed = 0, onsPct = 0;
    if (S.cfg.enabled) {
      hq = Math.round(grossC * royaltyFor(st) / 100);
      onsFixed = Math.round(P.platformFee * 100);
      onsPct = Math.round(grossC * P.markup / 10000);
    }
    const ons = onsFixed + onsPct;
    return { type: 'sale', gross: grossC, msf, hq, ons, onsPct, net: grossC - msf - hq - ons };
  }

  function splitRefund(orig, amountC) {
    const f = amountC / orig.gross;
    const hqBack = S.cfg.proRate ? Math.round(orig.hq * f) : 0;
    const onsBack = S.cfg.proRate ? Math.round(orig.onsPct * f) : 0; // fixed platform fee is retained
    return { type: 'refund', gross: -amountC, msf: 0, hq: -hqBack, ons: -onsBack, net: -amountC + hqBack + onsBack };
  }

  function splitChargeback(orig) {
    const fee = Math.round(S.cfg.cbFee * 100);
    const hqBack = S.cfg.cbClaw ? orig.hq : 0;
    const onsBack = S.cfg.cbClaw ? orig.ons : 0;
    return { type: 'chargeback', gross: -orig.gross, msf: fee, hq: -hqBack, ons: -onsBack, net: -orig.gross - fee + hqBack + onsBack };
  }

  function record(st, e, visual) {
    e.id = ++S.seq; e.store = st.id; e.day = S.day; e.time = clock(S.minute);
    addAgg(S.live.total, e);
    addAgg(S.live.perStore[st.id], e);
    S.ledger.unshift(e);
    if (S.ledger.length > 40) S.ledger.length = 40;
    if (visual) animate(st, e);
    return e;
  }

  function doSale(st, grossC, visual) {
    const e = record(st, splitSale(st, grossC), visual);
    st.history.push(e);
    if (st.history.length > 400) st.history.shift();
    return e;
  }
  function pickOriginal(st) {
    const open = st.history.filter(h => !h.reversed);
    return open.length ? open[Math.floor(Math.random() * open.length)] : null;
  }
  function doRefund(st, visual) {
    const orig = pickOriginal(st);
    if (!orig) return null;
    const pct = Math.random() < 0.5 ? 1 : 0.3 + Math.random() * 0.6;
    const amt = Math.max(100, Math.round(orig.gross * pct / 5) * 5);
    orig.reversed = true;
    const e = record(st, splitRefund(orig, Math.min(amt, orig.gross)), visual);
    e.ref = orig.id;
    return e;
  }
  function doChargeback(st, visual) {
    const orig = pickOriginal(st);
    if (!orig) return null;
    orig.reversed = true;
    const e = record(st, splitChargeback(orig), visual);
    e.ref = orig.id;
    return e;
  }
  const ticketC = () => Math.max(300, Math.round(S.params.ticket * 100 * Math.exp(0.45 * gauss() - 0.1)));

  // Advance simulated time by `mins`; returns number of events generated.
  let lastVisual = 0;
  function simulate(mins, withVisuals) {
    const P = S.params;
    let events = 0;
    const end = Math.min(DAY_MIN, S.minute + mins);
    while (S.minute < end) {
      const step = Math.min(1, end - S.minute);
      const w = hourWeight(S.minute) / W_TOTAL * step;
      for (const st of S.net.stores) {
        const n = poisson(P.volume * w);
        for (let i = 0; i < n; i++) {
          const now = performance.now();
          const vis = withVisuals && now - lastVisual > 140 / Math.sqrt(S.speed);
          if (vis) lastVisual = now;
          doSale(st, ticketC(), vis);
          if (Math.random() < P.refundRate / 100) doRefund(st, withVisuals);
          if (Math.random() < P.cbRate / 100) doChargeback(st, withVisuals);
          events++;
        }
      }
      S.minute += step;
    }
    if (S.minute >= DAY_MIN) settleDay();
    return events;
  }

  function settleDay() {
    const L = S.live, rows = [];
    const ref = `SPLIT D${S.day}`;
    S.net.stores.forEach((st, i) => {
      const owed = L.perStore[i].net + (S.carry[i] || 0);
      let amount = owed, note = '';
      if (owed < 0 && S.cfg.netOff) { amount = 0; S.carry[i] = owed; note = `carry fwd ${money(owed)}`; }
      else S.carry[i] = 0;
      rows.push({ payee: st.name, role: 'Store net', bsb: st.bsb, acct: st.acct, amount, ref: `${ref} MID${st.mid}`, note });
    });
    rows.push({ payee: S.net.hq.name, role: 'HQ royalty', bsb: S.net.hq.bsb, acct: S.net.hq.acct, amount: L.total.hq, ref: `${ref} ROYALTY` });
    rows.push({ payee: S.net.onseller.name, role: 'Onseller fees', bsb: S.net.onseller.bsb, acct: S.net.onseller.acct, amount: L.total.ons, ref: `${ref} PLATFORM` });
    S.days.push({ day: S.day, total: L.total, perStore: L.perStore, rows });
    toast(`Day ${S.day} closed · ${rows.length} payouts queued for T+1 · ${money(L.total.sales)} gross`);
    S.day++; S.minute = 0; S.live = newLive();
    renderOutputs(); renderCompare();
  }

  // ---------------------------------------------------------------- flow diagram
  const flow = $('#flow');
  const F = { paths: {}, chips: [], vals: {}, engine: null, particles: [] };

  function node(g, x, y, w, h, title, sub, cls = '') {
    const n = svgEl('g', { class: `node ${cls}`, transform: `translate(${x},${y})` }, g);
    svgEl('rect', { width: w, height: h, rx: 12 }, n);
    svgEl('text', { x: 14, y: 24 }, n).textContent = title;
    svgEl('text', { x: 14, y: 41, class: 'sub-t' }, n).textContent = sub;
    const v = svgEl('text', { x: 14, y: h - 14, class: 'val' }, n);
    return { g: n, val: v };
  }

  function buildFlow() {
    flow.innerHTML = '';
    F.paths = {}; F.chips = []; F.vals = {}; F.particles = [];
    const pathLayer = svgEl('g', {}, flow);
    const nodeLayer = svgEl('g', {}, flow);
    F.dotLayer = svgEl('g', {}, flow);

    const stores = S.net.stores;
    const chipH = 26, gap = Math.min(10, (380 - stores.length * chipH) / Math.max(1, stores.length - 1));
    const top = 30 + (380 - (stores.length * chipH + (stores.length - 1) * gap)) / 2;
    svgEl('text', { x: 20, y: 20, class: 'lane-label' }, nodeLayer).textContent = S.net.hqLabel === 'Marketplace' ? 'Sellers · own MIDs' : 'Stores · own MIDs';
    svgEl('text', { x: 820, y: 20, class: 'lane-label' }, nodeLayer).textContent = 'Destination BSBs · T+1';

    const acq = { x: 250, y: 160, w: 170, h: 100 };
    const eng = { x: 500, y: 150, w: 190, h: 120 };
    const out = {
      store: { x: 800, y: 40, w: 185, h: 88, title: 'Store accounts', sub: `${stores.length} × net deposit` },
      hq: { x: 800, y: 176, w: 185, h: 88, title: S.net.hqLabel, sub: `${S.net.group} royalty` },
      ons: { x: 800, y: 312, w: 185, h: 88, title: 'Onseller', sub: S.net.onseller.name },
    };
    const msfN = { x: 250, y: 330, w: 170, h: 70 };

    stores.forEach((st, i) => {
      const y = top + i * (chipH + gap);
      const g = svgEl('g', { class: 'store-chip', transform: `translate(20,${y})` }, nodeLayer);
      svgEl('rect', { width: 170, height: chipH, rx: 7 }, g);
      const t = svgEl('text', { x: 10, y: 17 }, g);
      t.textContent = `${st.short.slice(0, 13)} · …${st.mid.slice(-4)}`;
      F.chips.push(g);
      const sy = y + chipH / 2, ey = acq.y + acq.h / 2;
      F.paths['in' + i] = svgEl('path', { class: 'path', d: `M190,${sy} C220,${sy} 220,${ey} ${acq.x},${ey}` }, pathLayer);
    });

    const mid = (n) => n.y + n.h / 2;
    F.paths.ae = svgEl('path', { class: 'path', d: `M${acq.x + acq.w},${mid(acq)} L${eng.x},${mid(eng)}` }, pathLayer);
    F.paths.msf = svgEl('path', { class: 'path', d: `M${acq.x + acq.w / 2},${acq.y + acq.h} L${msfN.x + msfN.w / 2},${msfN.y}` }, pathLayer);
    for (const k of ['store', 'hq', 'ons']) {
      const o = out[k], sx = eng.x + eng.w, sy = mid(eng), ey = mid(o);
      F.paths[k] = svgEl('path', { class: 'path', d: `M${sx},${sy} C${sx + 60},${sy} ${o.x - 60},${ey} ${o.x},${ey}` }, pathLayer);
    }

    const a = node(nodeLayer, acq.x, acq.y, acq.w, acq.h, 'Bank acquirer', 'Authorise · clear · MSF');
    F.vals.acq = a.val;
    const e = node(nodeLayer, eng.x, eng.y, eng.w, eng.h, 'Split engine', 'Rules · clawbacks · batching', 'engine');
    F.engine = e.g; F.vals.eng = e.val;
    const m = node(nodeLayer, msfN.x, msfN.y, msfN.w, msfN.h, 'MSF retained', 'IC++ · scheme fees');
    F.vals.msf = m.val;
    for (const k of ['store', 'hq', 'ons']) {
      const o = out[k], n = node(nodeLayer, o.x, o.y, o.w, o.h, o.title, o.sub);
      const colorVar = { store: '--s-store', hq: '--s-hq', ons: '--s-onseller' }[k];
      svgEl('rect', { x: 0, y: 12, width: 4, height: o.h - 24, rx: 2, style: `fill:var(${colorVar})` }, n.g);
      F.vals[k] = n.val;
    }
    for (const k in F.paths) F.paths[k].len = F.paths[k].getTotalLength();
    updateFlowValues();
  }

  function particle(path, color, delay, dur, r, reverse = false, claw = false) {
    if (F.particles.length > 220) return;
    const c = svgEl('circle', { r, class: claw ? 'dot claw' : 'dot', opacity: 0 }, F.dotLayer);
    if (!claw) c.style.fill = color;
    F.particles.push({ c, path, t0: performance.now() + delay, dur, reverse });
  }

  function animate(st, e) {
    if (document.hidden || !F.dotLayer) return;
    const sp = 1 / Math.min(3, Math.max(0.6, Math.sqrt(S.speed)));
    const T = 650 * sp;
    const r = Math.min(9, 3.5 + Math.sqrt(Math.abs(e.gross) / 100) / 2.2);
    const inPath = F.paths['in' + st.id];
    const chip = F.chips[st.id];
    if (e.type === 'sale') {
      chip.classList.add('flash');
      setTimeout(() => chip.classList.remove('flash'), 400);
      particle(inPath, 'var(--text-2)', 0, T, r);
      particle(F.paths.ae, 'var(--text-2)', T, T * 0.8, r);
      if (e.msf) particle(F.paths.msf, 'var(--s-msf)', T, T * 0.8, Math.max(3, r * 0.45));
      particle(F.paths.store, 'var(--s-store)', T * 1.8, T, Math.max(3, r * 0.85));
      if (e.hq) particle(F.paths.hq, 'var(--s-hq)', T * 1.8, T, Math.max(3, r * 0.45));
      if (e.ons) particle(F.paths.ons, 'var(--s-onseller)', T * 1.8, T, 3);
      setTimeout(() => { F.engine.classList.remove('pulse'); void F.engine.getBBox(); F.engine.classList.add('pulse'); }, T * 1.8);
    } else {
      // clawbacks travel back from payees; refund funds return to the cardholder
      if (e.hq) particle(F.paths.hq, '', 0, T, 5, true, true);
      if (e.ons) particle(F.paths.ons, '', 0, T, 4, true, true);
      particle(F.paths.store, '', 0, T, 7, true, true);
      particle(F.paths.ae, '', T, T * 0.8, 7, true, true);
      particle(inPath, '', T * 1.8, T, 7, true, true);
    }
  }

  function tickParticles(now) {
    for (let i = F.particles.length - 1; i >= 0; i--) {
      const p = F.particles[i];
      const t = (now - p.t0) / p.dur;
      if (t < 0) continue;
      if (t >= 1) { p.c.remove(); F.particles.splice(i, 1); continue; }
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const pt = p.path.getPointAtLength((p.reverse ? 1 - ease : ease) * p.path.len);
      p.c.setAttribute('cx', pt.x); p.c.setAttribute('cy', pt.y);
      p.c.setAttribute('opacity', t > 0.9 ? (1 - t) * 10 : 1);
    }
  }

  function updateFlowValues() {
    const T = S.live.total;
    F.vals.acq.textContent = `${T.count.toLocaleString()} events · ${compact(T.sales + T.adj)}`;
    F.vals.eng.textContent = S.cfg.enabled ? `${T.count.toLocaleString()} splits applied` : 'Split routing OFF';
    F.vals.msf.textContent = money(T.msf);
    F.vals.store.textContent = money(T.net);
    F.vals.hq.textContent = money(T.hq);
    F.vals.ons.textContent = money(T.ons);
  }

  // ---------------------------------------------------------------- simulate tab rendering
  function renderTotals() {
    const T = S.live.total;
    const base = Math.max(1, T.msf + T.hq + T.ons + Math.max(0, T.net));
    const seg = (v, c) => `<i style="flex-grow:${Math.max(0, v) / base};background:var(${c})"></i>`;
    $('#splitBar').innerHTML = T.count ? seg(T.net, '--s-store') + seg(T.hq, '--s-hq') + seg(T.ons, '--s-onseller') + seg(T.msf, '--s-msf') : '';
    const row = (label, v, c, cls = '') => `<dt>${c ? `<i class="sw" style="background:var(${c})"></i>` : ''}${label}</dt><dd class="${cls}">${money(v)}</dd>`;
    $('#totals').innerHTML =
      row('Gross card sales', T.sales, null) +
      row(`Refunds &amp; chargebacks (${T.refunds + T.cbs})`, T.adj, null, T.adj < 0 ? 'neg' : '') +
      '<div class="sep"></div>' +
      row('Acquirer MSF', T.msf, '--s-msf') +
      row(`${esc(S.net.hqLabel)} royalty`, T.hq, '--s-hq') +
      row('Onseller fees', T.ons, '--s-onseller') +
      row('Store net deposits', T.net, '--s-store', 'big');
    const held = 0;
    $('#guarantee').innerHTML = T.count
      ? `✓ <b>Reconciled.</b> ${money(T.sales + T.adj)} net gross = MSF + royalty + onseller + store net, to the cent. Merchant funds held by ${esc(S.net.hqLabel)}: <b>${money(held)}</b>.`
      : `Each store keeps its own MID and its own credit profile. The split engine sends every party its share straight to its own BSB.`;
    $('#clockLine').textContent = `Day ${S.day} · ${clock(S.minute)} · ${S.minute >= DAY_MIN ? 'closed' : S.playing ? 'trading' : 'paused'} · ${S.days.length} day${S.days.length === 1 ? '' : 's'} settled`;
  }

  let ledgerTopId = 0;
  function renderLedger() {
    if (!S.ledger.length) return;
    const body = $('#ledgerBody');
    const cell = (v, neg) => `<td class="num${v < 0 || neg ? ' neg' : ''}">${v ? money(v) : '—'}</td>`;
    body.innerHTML = S.ledger.map(e => {
      const st = S.net.stores[e.store];
      return `<tr class="${e.id > ledgerTopId ? 'new' : ''}"><td class="mono">D${e.day} ${e.time}</td><td>${esc(st.short)} <span class="muted mono">…${st.mid.slice(-4)}</span></td>` +
        `<td><span class="type ${e.type}">${e.type}${e.ref ? ` #${e.ref}` : ''}</span></td>` +
        cell(e.gross) + cell(e.msf) + cell(e.hq) + cell(e.ons) + `<td class="num${e.net < 0 ? ' neg' : ''}"><b>${money(e.net)}</b></td></tr>`;
    }).join('');
    ledgerTopId = S.ledger[0].id;
  }

  function renderHero() {
    $('#heroStats').innerHTML = [
      ['$28.5B', 'AU franchise + marketplace ecommerce TTV'],
      ['T+1', 'net settlement straight to every BSB'],
      ['$0', 'merchant funds held by HQ or processor'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  }

  // ---------------------------------------------------------------- controls
  const SLIDERS = {
    royalty: v => `${(+v).toFixed(2)}%`,
    platformFee: v => `$${(+v).toFixed(2)}`,
    markup: v => `${v} bps`,
    msf: v => `${(+v).toFixed(2)}%`,
    ticket: v => `$${v}`,
    volume: v => `${v}`,
    refundRate: v => `${v}%`,
    cbRate: v => `${(+v).toFixed(2)}%`,
  };
  function bindSliders() {
    for (const k in SLIDERS) {
      const inp = $('#' + k), out = $('#' + k + 'Out');
      inp.addEventListener('input', () => {
        S.params[k] = +inp.value;
        out.textContent = SLIDERS[k](inp.value);
        if (k === 'royalty') renderRules();
        renderCompare(); renderConfig();
      });
    }
  }
  function applyPreset(key) {
    S.presetKey = key; S.preset = PRESETS[key];
    S.net = buildNetwork(key);
    for (const k in SLIDERS) {
      S.params[k] = S.preset[k];
      $('#' + k).value = S.preset[k];
      $('#' + k + 'Out').textContent = SLIDERS[k](S.preset[k]);
    }
    resetSim();
  }
  function resetSim() {
    setPlaying(false);
    S.day = 1; S.minute = 0; S.days = []; S.ledger = []; S.seq = 0; S.carry = {}; ledgerTopId = 0;
    S.net.stores.forEach(s => { s.history = []; });
    S.live = newLive();
    $('#ledgerBody').innerHTML = '<tr><td colspan="8" class="empty">Press <b>Start trading</b> to run a trading day.</td></tr>';
    buildFlow(); renderTotals(); renderRules(); renderOutputs(); renderCompare(); renderConfig();
  }
  function setPlaying(on) {
    S.playing = on;
    $('#playBtn').setAttribute('aria-pressed', on);
    $('#playIcon').textContent = on ? '❚❚' : '▶';
    $('#playLabel').textContent = on ? 'Pause' : (S.seq ? 'Resume' : 'Start trading');
    lastFrame = performance.now();
  }

  // ---------------------------------------------------------------- main loop
  let lastFrame = performance.now(), uiAccum = 0;
  function loop(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (S.playing) {
      simulate(dt * 15 * S.speed, true); // 1× = 15 simulated minutes per second → a day in 60s
      uiAccum += dt;
      if (uiAccum > 0.2) { uiAccum = 0; renderLive(); }
    }
    tickParticles(now);
    requestAnimationFrame(loop);
  }
  let compareAccum = 0;
  function renderLive() {
    renderTotals(); renderLedger(); updateFlowValues();
    if (++compareAccum % 10 === 0) { renderCompare(); if (activeTab === 'outputs') renderOutputs(); }
  }

  // ---------------------------------------------------------------- compare tab
  const HOURLY_COST = 65;
  function monthly() {
    const elapsed = S.days.length + S.minute / DAY_MIN;
    const P = S.params, n = S.net.stores.length;
    if (elapsed < 0.05) {
      // no trading yet: expected values from the current parameters
      const txns = P.volume * n * 30, gross = txns * P.ticket * 100;
      const avgRoy = S.net.stores.reduce((a, s) => a + royaltyFor(s), 0) / n;
      const hq = gross * avgRoy / 100, ons = txns * P.platformFee * 100 + gross * P.markup / 10000, msf = gross * P.msf / 100;
      return { gross, hq, ons, msf, net: gross - hq - ons - msf, simulated: false, elapsed };
    }
    const agg = emptyAgg();
    for (const d of S.days) for (const k in agg) agg[k] += d.total[k];
    for (const k in agg) agg[k] += S.live.total[k];
    const f = 30 / elapsed;
    return { gross: (agg.sales + agg.adj) * f, hq: agg.hq * f, ons: agg.ons * f, msf: agg.msf * f, net: agg.net * f, simulated: true, elapsed };
  }

  function renderCompare() {
    const box = $('#models');
    if (!box || !S.net) return;
    const M = monthly(), n = S.net.stores.length;
    const dish = +$('#dishonour').value, pool = +$('#poolDays').value, hrs = +$('#adminHrs').value;
    const fees = M.hq + M.ons;
    const dailyNet = M.net / 30;
    const flag = (cls, t) => `<span class="flag ${cls}">${cls === 'good' ? '✓' : cls === 'warn' ? '!' : '✕'} ${t}</span>`;
    const models = [
      {
        kicker: 'Workaround A', name: 'Post-facto invoicing', flow: ['Acquirer', 'Store 100%', 'HQ invoices / BECS debit'],
        desc: 'The full gross settles to each store. HQ and the onseller then invoice or direct-debit their fees back each month.',
        metrics: [
          ['Store receives funds', 'T+1 (overpaid)'],
          ['Fees HQ must chase / month', compact(fees)],
          ['Expected dishonours & bad debt', compact(fees * dish / 100)],
          ['Debits / invoices per month', `${n * 2}`],
          ['Finance admin cost / month', compact(n * hrs * HOURLY_COST * 100)],
          ['Merchant funds held by HQ', '$0'],
        ],
        flags: [flag('bad', 'Collections & dishonour risk'), flag('warn', 'Multiple debits confuse stores')],
        pains: ['HQ is stuck in the invoicing and collections business', 'Spreadsheets and system upkeep', 'Stores reconcile several statements a month'],
      },
      {
        kicker: 'Workaround B', name: 'Master account pooling', flow: ['Acquirer', 'HQ master acct', `BECS every ${pool}d`, 'Stores'],
        desc: 'All volume settles to one HQ master account. HQ works out each store\'s net share and pays it out by BECS batch.',
        metrics: [
          ['Store receives funds', `~T+${(1 + pool / 2 + 1).toFixed(1)} avg`],
          ['Fees HQ must chase / month', '$0'],
          ['Peak merchant funds held by HQ', compact(dailyNet * (pool + 1))],
          ['Payout batches per month', `${Math.ceil(30 / pool) * n}`],
          ['Finance admin cost / month', compact(n * hrs * 0.8 * HOURLY_COST * 100)],
          ['Stores keep own MID', 'No'],
        ],
        flags: [flag('bad', 'HQ acts as funds distributor'), flag('bad', 'Regulatory scrutiny for acquirer')],
        pains: ['HQ has to act like a bank', 'Cash-flow-sensitive stores wait days for funds', 'Stores lose their own MID and credit profile'],
      },
      {
        kicker: 'Hybrid model', name: 'Hybrid Split Settlement', flow: ['Acquirer (store MID)', 'Split engine', 'Store · HQ · Onseller BSBs'], best: true,
        desc: 'The acquirer\'s payout batch is split before settlement. Each party gets its share on T+1, and clawbacks are automated.',
        metrics: [
          ['Store receives funds', 'T+1 (net)'],
          ['Fees HQ must chase / month', '$0'],
          ['Expected dishonours & bad debt', '$0'],
          ['Fees collected automatically', compact(fees)],
          ['Finance admin cost / month', compact(n * 0.25 * HOURLY_COST * 100)],
          ['Merchant funds held by HQ', '$0'],
        ],
        flags: [flag('good', 'No one holds merchant funds'), flag('good', 'One consolidated statement')],
        pains: ['Stores keep their MIDs, KYB and credit profiles', 'Direct IC++ rates are kept', 'Refund and chargeback clawbacks need no manual work'],
      },
    ];
    box.innerHTML = models.map(m => `
      <article class="card model${m.best ? ' best' : ''}">
        <p class="kicker">${m.kicker}${m.best ? ' <span class="pill">Proposed</span>' : ''}</p>
        <h2>${m.name}</h2>
        <p class="desc">${m.desc}</p>
        <div class="mini-flow">${m.flow.map((s, i) => `${i ? '<i>→</i>' : ''}<span class="${m.best && i === 1 ? 'hot' : ''}">${esc(s)}</span>`).join('')}</div>
        <ul class="metrics">${m.metrics.map(([l, v]) => `<li><span>${l}</span><b>${v}</b></li>`).join('')}</ul>
        <div class="row-gap" style="flex-wrap:wrap;margin-top:12px">${m.flags.join('')}</div>
        <ul class="pains">${m.pains.map(p => `<li>${p}</li>`).join('')}</ul>
      </article>`).join('') +
      `<p class="muted small" style="grid-column:1/-1;margin:-6px 0 0">${M.simulated
        ? `Projected to 30 days from ${M.elapsed.toFixed(2)} simulated day(s): ${compact(M.gross)} net gross card volume per month across ${n} ${S.net.hqLabel === 'Marketplace' ? 'sellers' : 'stores'}.`
        : `No trading simulated yet, so these figures are the expected values from the current settings (${compact(M.gross)} per month). Run the simulator to use real simulated trading.`} Finance time is costed at $${HOURLY_COST}/hr.</p>`;
  }

  // ---------------------------------------------------------------- outputs tab
  function renderRules() {
    const P = S.params;
    $('#rulesBody').innerHTML = S.net.stores.map(st => `<tr>
      <td>${S.cfg.enabled ? '<span class="flag good">✓ On</span>' : '<span class="flag warn">Off</span>'}</td>
      <td>${esc(st.name)}</td><td class="mono">${st.mid}</td><td class="mono">${st.bsb} / ${st.acct}</td>
      <td class="mono">${S.net.hq.bsb}</td><td class="mono">${S.net.onseller.bsb}</td>
      <td class="num"><input type="number" min="0" max="20" step="0.25" data-store="${st.id}" value="${royaltyFor(st)}" aria-label="Royalty percent for ${esc(st.name)}"></td>
      <td class="num">$${P.platformFee.toFixed(2)}</td><td class="num">${P.markup}</td></tr>`).join('');
  }
  $('#rulesBody').addEventListener('change', e => {
    const inp = e.target.closest('input[data-store]');
    if (!inp) return;
    const st = S.net.stores[+inp.dataset.store];
    const v = Math.max(0, Math.min(20, +inp.value || 0));
    st.royalty = v === S.params.royalty ? null : v;
    toast(`${st.name}: royalty set to ${v}%`);
    renderConfig(); renderCompare();
  });

  function selectedBatch() {
    const v = $('#batchDay').value;
    if (v === 'live' || !S.days.length) return null;
    return S.days.find(d => d.day === +v) || null;
  }
  function renderOutputs() {
    const sel = $('#batchDay'), prev = sel.value;
    sel.innerHTML = S.days.map(d => `<option value="${d.day}">Day ${d.day} batch (T+1)</option>`).reverse().join('') +
      '<option value="live">Today (live, not settled)</option>';
    if (prev && [...sel.options].some(o => o.value === prev) && prev !== 'live') sel.value = prev;
    else sel.value = S.days.length ? String(S.days[S.days.length - 1].day) : 'live';
    renderPayout(); renderRecon();
  }
  function payoutRows() {
    const b = selectedBatch();
    if (b) return b.rows;
    const L = S.live;
    return [
      ...S.net.stores.map((st, i) => ({ payee: st.name, role: 'Store net', bsb: st.bsb, acct: st.acct, amount: L.perStore[i].net, ref: `PENDING MID${st.mid}`, note: 'pending close' })),
      { payee: S.net.hq.name, role: 'HQ royalty', bsb: S.net.hq.bsb, acct: S.net.hq.acct, amount: L.total.hq, ref: 'PENDING ROYALTY', note: 'pending close' },
      { payee: S.net.onseller.name, role: 'Onseller fees', bsb: S.net.onseller.bsb, acct: S.net.onseller.acct, amount: L.total.ons, ref: 'PENDING PLATFORM', note: 'pending close' },
    ];
  }
  function renderPayout() {
    const rows = payoutRows();
    const total = rows.reduce((a, r) => a + r.amount, 0);
    $('#payoutBody').innerHTML = rows.map(r => `<tr><td>${esc(r.payee)}</td><td><span class="type">${r.role}</span></td><td class="mono">${r.bsb}</td><td class="mono">${r.acct}</td>
      <td class="num${r.amount < 0 ? ' neg' : ''}">${money(r.amount)}${r.note ? `<br><span class="muted small">${esc(r.note)}</span>` : ''}</td><td class="mono">${esc(r.ref)}</td></tr>`).join('') +
      `<tr class="total"><td colspan="4"><b>Batch total</b></td><td class="num"><b>${money(total)}</b></td><td></td></tr>`;
  }
  function reconData() {
    const b = selectedBatch();
    return b ? { perStore: b.perStore, total: b.total } : S.live;
  }
  function renderRecon() {
    const d = reconData();
    const tr = (name, a) => `<td class="num">${money(a.sales)}</td><td class="num${a.adj < 0 ? ' neg' : ''}">${money(a.adj)}</td><td class="num">${money(a.msf)}</td><td class="num">${money(a.hq)}</td><td class="num">${money(a.ons)}</td><td class="num${a.net < 0 ? ' neg' : ''}">${money(a.net)}</td>`;
    $('#reconBody').innerHTML = S.net.stores.map((st, i) => `<tr><td>${esc(st.short)}</td>${tr(st.name, d.perStore[i])}</tr>`).join('');
    $('#reconFoot').innerHTML = `<tr><td>Total</td>${tr('Total', d.total)}</tr>`;
  }
  $('#batchDay').addEventListener('change', () => { renderPayout(); renderRecon(); });

  function download(name, rows) {
    const csv = rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const dayTag = () => { const b = selectedBatch(); return b ? `day${b.day}` : 'live'; };
  $('#dlPayout').addEventListener('click', () => download(`split-payout-${dayTag()}.csv`,
    [['payee', 'role', 'bsb', 'account', 'amount', 'reference', 'note'], ...payoutRows().map(r => [r.payee, r.role, r.bsb, r.acct, (r.amount / 100).toFixed(2), r.ref, r.note || ''])]));
  $('#dlRecon').addEventListener('click', () => {
    const d = reconData(), f = c => (c / 100).toFixed(2);
    const line = (n, a) => [n, f(a.sales), f(a.adj), f(a.msf), f(a.hq), f(a.ons), f(a.net)];
    download(`hq-reconciliation-${dayTag()}.csv`, [['store', 'gross_sales', 'refunds_chargebacks', 'msf', 'royalty', 'onseller_fees', 'net_deposit'],
      ...S.net.stores.map((st, i) => line(st.name, d.perStore[i])), line('TOTAL', d.total)]);
  });

  function renderConfig() {
    if (!S.net) return;
    const P = S.params;
    $('#cfgJson').textContent = JSON.stringify({
      merchant_group: S.net.group,
      split_routing_enabled: S.cfg.enabled,
      payout: { schedule: 'T+1', rail: 'BECS', net_off_negative_balances: S.cfg.netOff },
      default_rules: {
        hq_royalty_pct: P.royalty,
        onseller_fixed_fee_aud: +P.platformFee.toFixed(2),
        onseller_markup_bps: P.markup,
      },
      clawback: { refund: S.cfg.proRate ? 'pro_rata_percentage_fees' : 'none', chargeback: S.cfg.cbClaw ? 'full_fee_reversal' : 'none', chargeback_fee_aud: S.cfg.cbFee },
      store_overrides: S.net.stores.filter(s => s.royalty != null).map(s => ({ mid: s.mid, hq_royalty_pct: s.royalty })),
      destinations: { hq: `${S.net.hq.bsb} ${S.net.hq.acct}`, onseller: `${S.net.onseller.bsb} ${S.net.onseller.acct}` },
    }, null, 2);
  }
  const cfgMap = { cfgEnabled: 'enabled', cfgProRate: 'proRate', cfgCbClaw: 'cbClaw', cfgNetOff: 'netOff' };
  for (const id in cfgMap) $('#' + id).addEventListener('change', e => {
    S.cfg[cfgMap[id]] = e.target.checked;
    renderConfig(); renderRules(); updateFlowValues();
    if (id === 'cfgEnabled') toast(e.target.checked ? 'Split routing enabled' : 'Split routing off: stores receive gross less MSF (legacy 1 MID = 1 BSB)');
  });
  $('#cfgCbFee').addEventListener('change', e => { S.cfg.cbFee = Math.max(0, +e.target.value || 0); renderConfig(); });

  // ---------------------------------------------------------------- business case
  const BIZ = {
    bNewTtv: v => `$${(+v).toLocaleString()}M`,
    bNewBps: v => `${v} bps`,
    bExTtv: v => `$${(+v).toLocaleString()}M`,
    bExBps: v => `${v} bps`,
    bRev: v => `$${v}M`,
    bChurn: v => `${(+v).toFixed(2)}%`,
    bFte: v => `${v} FTE`,
    bComp: v => `$${v}k`,
    bOps: v => `$${v}k`,
  };
  const FTE_COST = 140000, INFRA = 20000;
  function renderBusiness() {
    const v = {};
    for (const k in BIZ) { v[k] = +$('#' + k).value; $('#' + k + 'Out').textContent = BIZ[k](v[k]); }
    const rNew = v.bNewTtv * 1e6 * v.bNewBps / 1e4;
    const rEx = v.bExTtv * 1e6 * v.bExBps / 1e4;
    const rChurn = v.bRev * 1e6 * v.bChurn / 100;
    const cEng = v.bFte * FTE_COST, cComp = v.bComp * 1e3, cOps = v.bOps * 1e3;
    const rev = rNew + rEx + rChurn, cost = cEng + cComp + cOps + INFRA, net = rev - cost;
    const $M = x => `${x < 0 ? '−' : ''}$${Math.abs(x / 1e6).toFixed(2)}M`;
    $('#kpis').innerHTML = [
      ['Revenue p.a.', $M(rev)], ['Ongoing cost p.a.', $M(cost)], ['Net position p.a.', $M(net), 'kpi-hero'], ['Revenue : cost', `${(rev / cost).toFixed(1)}×`],
    ].map(([l, b, c]) => `<div class="kpi ${c || ''}"><span>${l}</span><b>${b}</b></div>`).join('');

    drawBars([
      { label: 'New business', v: rNew, kind: 'rev', note: `${v.bNewTtv.toLocaleString()}M TTV × ${v.bNewBps} bps` },
      { label: 'Backbook uplift', v: rEx, kind: 'rev', note: `${v.bExTtv}M TTV × ${v.bExBps} bps` },
      { label: 'Churn reduction', v: rChurn, kind: 'rev', note: `${v.bChurn}% of $${v.bRev}M revenue retained` },
      { label: 'Engineering', v: -cEng, kind: 'cost', note: `${v.bFte} FTE × $${FTE_COST / 1e3}k` },
      { label: 'Compliance & ops', v: -(cComp + cOps), kind: 'cost', note: `Compliance $${v.bComp}k + ops $${v.bOps}k` },
      { label: 'Infra & payout rails', v: -INFRA, kind: 'cost', note: 'Cloud compute and BECS/NPP fees (small)' },
      { label: 'Net position', v: net, kind: 'net', note: 'Revenue less ongoing cost' },
    ]);
    drawHeat(v.bNewTtv, v.bNewBps);
  }

  const fmtK = v => `${v < 0 ? '−' : ''}$${Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(2) + 'M' : Math.round(Math.abs(v) / 1e3) + 'k'}`;
  window.addEventListener('resize', () => { if (activeTab === 'business') renderBusiness(); });
  function drawBars(items) {
    const box = $('#waterfall');
    const W = Math.max(320, Math.round(box.clientWidth || 640)), rowH = 34, padL = W < 480 ? 120 : 150, padR = 80, top = 26, H = top + items.length * rowH + 8;
    const max = Math.max(...items.map(i => Math.abs(i.v)), 1);
    const min = Math.min(0, ...items.map(i => i.v));
    const lo = min < 0 ? -max : 0;
    const x = val => padL + (val - lo) / (max - lo) * (W - padL - padR);
    const color = { rev: 'var(--s-store)', cost: 'var(--s-hq)', net: 'var(--accent)' };
    let s = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const tv = lo + (max - lo) * i / ticks, tx = x(tv);
      s += `<line class="grid" x1="${tx}" x2="${tx}" y1="${top - 6}" y2="${H - 6}"/><text class="axis-t" x="${tx}" y="${top - 12}" text-anchor="middle">${tv < 0 ? '−' : ''}$${Math.abs(tv / 1e6).toFixed(2)}M</text>`;
    }
    items.forEach((it, i) => {
      const y = top + i * rowH, x0 = x(0), x1 = x(it.v), bx = Math.min(x0, x1), bw = Math.max(2, Math.abs(x1 - x0));
      const r = Math.min(4, bw / 2);
      const d = it.v >= 0
        ? `M${bx},${y + 6} H${bx + bw - r} a${r},${r} 0 0 1 ${r},${r} V${y + rowH - 8 - r} a${r},${r} 0 0 1 -${r},${r} H${bx} Z`
        : `M${bx + bw},${y + 6} H${bx + r} a${r},${r} 0 0 0 -${r},${r} V${y + rowH - 8 - r} a${r},${r} 0 0 0 ${r},${r} H${bx + bw} Z`;
      const lblX = it.v >= 0 ? x1 + 6 : x1 - 6;
      s += `<text class="lbl" x="${padL - 10}" y="${y + rowH / 2 + 3}" text-anchor="end"${it.kind === 'net' ? ' font-weight="700"' : ''}>${it.label}</text>`;
      s += `<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent" data-i="${i}"/>`;
      s += `<path class="bar" d="${d}" fill="${color[it.kind]}" data-i="${i}"/>`;
      s += `<text class="val-t" x="${lblX}" y="${y + rowH / 2 + 3}" text-anchor="${it.v >= 0 ? 'start' : 'end'}">${fmtK(it.v)}</text>`;
    });
    s += `<line x1="${x(0)}" x2="${x(0)}" y1="${top - 6}" y2="${H - 6}" stroke="var(--text-2)" stroke-width="1"/></svg>`;
    s += `<div class="legend" style="margin-top:4px"><span><i class="sw" style="background:var(--s-store)"></i>Revenue</span><span><i class="sw" style="background:var(--s-hq)"></i>Cost</span><span><i class="sw" style="background:var(--accent)"></i>Net position</span></div><div class="tip" id="barTip"></div>`;
    box.innerHTML = s;
    const tip = $('#barTip', box), svg = $('svg', box);
    svg.addEventListener('mousemove', e => {
      const t = e.target.closest('[data-i]');
      if (!t) { tip.style.opacity = 0; return; }
      const it = items[+t.dataset.i], rb = box.getBoundingClientRect();
      tip.innerHTML = `<b>${it.label}</b>: ${it.v < 0 ? '−' : ''}$${Math.round(Math.abs(it.v)).toLocaleString()}<br>${esc(it.note)}`;
      tip.style.left = `${e.clientX - rb.left}px`; tip.style.top = `${e.clientY - rb.top}px`; tip.style.opacity = 1;
    });
    svg.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  }

  const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
  function drawHeat(selTtv, selBps) {
    const ttvs = [...new Set([50, 100, 500, 1000, 4000, selTtv])].sort((a, b) => a - b);
    const bpss = [...new Set([5, 10, 15, selBps])].sort((a, b) => a - b);
    const maxV = ttvs[ttvs.length - 1] * bpss[bpss.length - 1] / 1e4;
    const tamNote = { 1000: '~2.5% TAM', 4000: '~10% TAM' };
    let h = `<thead><tr><th>Margin \\ TTV</th>${ttvs.map(t => `<th class="num">$${t.toLocaleString()}M${tamNote[t] ? `<br><span class="muted">${tamNote[t]}</span>` : ''}</th>`).join('')}</tr></thead><tbody>`;
    for (const b of bpss) {
      h += `<tr><th scope="row">${b} bps (${(b / 100).toFixed(2)}%)</th>`;
      for (const t of ttvs) {
        const val = t * b / 1e4;
        const idx = Math.min(RAMP.length - 1, Math.round(Math.sqrt(val / maxV) * (RAMP.length - 1)));
        h += `<td class="${t === selTtv && b === selBps ? 'sel' : ''}" style="background:${RAMP[idx]};color:${idx >= 6 ? '#fff' : '#0b0b0b'}" title="$${t}M TTV at ${b} bps = $${val.toFixed(3)}M p.a.">${val < 0.1 ? val.toFixed(3) : val.toFixed(2)}</td>`;
      }
      h += '</tr>';
    }
    $('#heat').innerHTML = h + '</tbody>';
  }

  // ---------------------------------------------------------------- roadmap
  const STAGES = [
    {
      n: 1, t: 'Pre-build discovery', groups: [
        ['Risk, compliance & legal', ['Confirm multi-MID split routing follows Visa/Mastercard scheme rules', 'Review the work needed to amend acquirer agreements to allow split settlement instructions', 'Confirm primary AML/KYB regulatory obligations', 'Review tax and accounting compliance']],
        ['Growth, sales & BD', ['Validate the customer problem in more detail with friendly clients', 'Review how hard it is to add fee-deduction clauses to store and HQ agreements', 'Include automatic fee recovery from HQ for post-settlement chargebacks and refunds', 'Test the commercial model']],
        ['Engineering', ['High-level design, worked out with the acquirer and customers', 'Size the capability and high-level effort (POC)']],
        ['Product & finance', ['Assess current capabilities and strategic fit', 'Validate commercials and market size']],
      ],
    },
    {
      n: 2, t: 'Proof of concept', groups: [
        ['Engineering deliverables', ['Rule mapping table: store MID → store BSB, HQ BSB and fee split rules', 'Orchestration split output file: daily intended payouts by transaction', 'Daily reconciliation CSV for HQ: gross, fee cuts, net deposits', 'Pilot setup config: back-end flag to turn on split routing']],
        ['Goal', ['Working model to demo to prospective and existing clients']],
      ],
    },
    {
      n: 3, t: 'MVP build', groups: [
        ['Commitments', ['Pilot agreement signed with an anchor franchise network (e.g. QSR or multi-site retail)', 'Test plan agreed']],
        ['Scope', ['Simple solution: no complex splitting logic or edge cases', 'Focus on resilience and error handling']],
      ],
    },
    {
      n: 4, t: 'Later stages', groups: [
        ['Potential roadmap', ['Extended split logic, prioritised by customer need', 'Refund and chargeback handling beyond the MVP use cases', 'Productisation: move from back-end config to customer-side config with controls', 'Franchisee / non-HQ MID onboarding and account setup', 'Go-to-market']],
      ],
    },
  ];
  let activeStage = 0;
  const checks = store.get('hss-roadmap') || {};
  function renderStages() {
    $('#stages').innerHTML = STAGES.map((s, i) => {
      const items = s.groups.flatMap(g => g[1]);
      const done = items.filter((_, j) => checks[`${i}-${j}`]).length;
      const pct = Math.round(done / items.length * 100);
      return `<li><button aria-pressed="${i === activeStage}" data-stage="${i}"><span class="n">STAGE ${s.n}</span><span class="t">${s.t}</span>
        <span class="progress"><i style="width:${pct}%"></i></span><span class="pct">${done}/${items.length} done</span></button></li>`;
    }).join('');
    const s = STAGES[activeStage];
    let j = 0;
    $('#stageDetail').innerHTML = `<h2 class="card-title"><span class="step">${s.n}</span> ${s.t}</h2><div class="stage-cols">` +
      s.groups.map(([g, items]) => `<div><h3>${g}</h3>${items.map(it => {
        const key = `${activeStage}-${j++}`;
        return `<label class="check${checks[key] ? ' done' : ''}"><input type="checkbox" data-key="${key}"${checks[key] ? ' checked' : ''}><span>${it}</span></label>`;
      }).join('')}</div>`).join('') + '</div>';
  }
  $('#stages').addEventListener('click', e => {
    const b = e.target.closest('[data-stage]');
    if (b) { activeStage = +b.dataset.stage; renderStages(); }
  });
  $('#stageDetail').addEventListener('change', e => {
    const k = e.target.dataset.key;
    if (!k) return;
    if (e.target.checked) checks[k] = true; else delete checks[k];
    store.set('hss-roadmap', checks);
    renderStages();
  });

  // ---------------------------------------------------------------- tabs & theme
  let activeTab = 'simulate';
  function showTab(name) {
    activeTab = name;
    $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
    $$('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
    if (name === 'outputs') renderOutputs();
    if (name === 'compare') renderCompare();
    if (name === 'business') renderBusiness();
    store.set('hss-tab', name);
    window.scrollTo({ top: 0 });
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  const savedTheme = store.get('hss-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('hss-theme', next);
  });

  // ---------------------------------------------------------------- wire up
  bindSliders();
  $('#preset').addEventListener('change', e => { applyPreset(e.target.value); toast(`Loaded ${PRESETS[e.target.value].group} network`); });
  $('#playBtn').addEventListener('click', () => setPlaying(!S.playing));
  $('#speed').addEventListener('change', e => { S.speed = +e.target.value; });
  $('#resetBtn').addEventListener('click', () => { resetSim(); toast('Simulation reset'); });
  $('#dayBtn').addEventListener('click', () => {
    const was = S.playing;
    setPlaying(false);
    simulate(DAY_MIN - S.minute, false);
    renderLive(); renderCompare(); renderOutputs();
    setPlaying(was);
  });
  const randStore = () => S.net.stores[Math.floor(Math.random() * S.net.stores.length)];
  $('#injectSale').addEventListener('click', () => { doSale(randStore(), 48000, true); renderLive(); });
  const injectReversal = fn => {
    let e = null;
    for (let tries = 0; tries < S.net.stores.length && !e; tries++) e = fn(randStore(), true);
    if (!e) {
      const st = randStore();
      doSale(st, ticketC(), true);
      setTimeout(() => { fn(st, true); renderLive(); }, 1800);
      toast('No sales yet. Making one first, then reversing it.');
    }
    renderLive();
  };
  $('#injectRefund').addEventListener('click', () => injectReversal(doRefund));
  $('#injectCb').addEventListener('click', () => injectReversal(doChargeback));
  ['dishonour', 'poolDays', 'adminHrs'].forEach(id => {
    const inp = $('#' + id), out = $('#' + id + 'Out');
    const fmt = () => { out.textContent = id === 'dishonour' ? `${inp.value}%` : id === 'poolDays' ? `${inp.value} days` : `${inp.value} h`; };
    fmt();
    inp.addEventListener('input', () => { fmt(); renderCompare(); });
  });
  Object.keys(BIZ).forEach(k => $('#' + k).addEventListener('input', renderBusiness));
  document.addEventListener('visibilitychange', () => { lastFrame = performance.now(); });

  renderHero();
  applyPreset('qsr');
  renderBusiness();
  renderStages();
  const savedTab = store.get('hss-tab');
  if (savedTab && $(`#tab-${savedTab}`)) showTab(savedTab);
  requestAnimationFrame(loop);
})();
