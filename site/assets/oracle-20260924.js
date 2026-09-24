/* ---- part 1 of 4 (was inline script 1) ---- */
try {

(function () {
  const D = JSON.parse(document.getElementById('oracle-data').textContent);
  document.getElementById('asof-chip').textContent = 'Updated ' + D.updated;

  // Forecast horizons are always DATES, derived here from `asof` so no run can
  // publish a week-count or a stale date: near = asof + 14 days (the core call,
  // scored at the 2-week checkpoint), far = asof + 28 days (the outlook note,
  // scored at the 4-week checkpoint). Shortened from +28/+56 on 28 Aug 2026
  // (Bora): the daily-granularity event study puts the forecastable window at
  // 2-4 weeks; nothing tested supports a 56-day call.
  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }
  function longDate(d) { return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function shortDate(d) { return MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate(); }
  const near = addDays(D.asof, 14), far = addDays(D.asof, 28);
  D.horizon = { near: longDate(near), nearShort: shortDate(near),
                far: longDate(far), farShort: shortDate(far) };
  document.getElementById('bench-heading').textContent = 'Calls to ' + D.horizon.near + ' — where the trend turns';

  // hero
  document.getElementById('hero').innerHTML =
    '<div class="headline">' + D.hero.headline + '</div>' +
    '<div class="body">' + D.hero.body + '</div>' +
    '<div class="tail">' + D.hero.tail + '</div>';

  // ---------------------------------------------------------------------------
  // TURN CALLS (21 Sep 2026, Bora). The calls grid answers WHEN the trend is
  // expected to turn, not where the price lands: phase, age of the move, the
  // dated turn window and a 0-100 turn-risk reading with its change since the
  // previous assessed day. The page computes the phase, the age and the risk
  // from D.ta.series and the factor states; the run supplies only the judgement
  // part, in the top-level "turns" key — see "_turns_note" in the JSON block.
  // The 14-day price target, its confidence and the "prev" block stay in
  // "benchmarks" and are still written every edition (the scoring rules test
  // them) — they are simply no longer displayed, like "vintage" and "unit".
  // ---------------------------------------------------------------------------
  const TU = D.turns || {};
  const TSER = (D.ta && D.ta.series) || {};
  const _mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const _sd = a => { const m = _mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); };
  const _ema = (a, n) => { const k = 2 / (n + 1); const o = []; a.forEach((v, i) => o.push(i ? o[i - 1] + k * (v - o[i - 1]) : v)); return o; };
  const _dayGap = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const _clip = v => Math.max(0, Math.min(100, v));

  // ta.series rows -> {date, lo, hi, last, src, deals}, carrying the last traded
  // price on days with no reported trade exactly as the Technical View does.
  function taRows(name) {
    const rows = TSER[name];
    if (!rows || rows.length < 30) return null;
    const out = []; let prev = null;
    rows.forEach(r => {
      const lo = +r[1], hi = +r[2]; let last = r[3] == null ? null : +r[3]; let src = r[4] || 'trade';
      if (last == null) { last = prev == null ? lo : Math.min(Math.max(prev, lo), hi); src = (prev != null && last !== prev) ? 'snap' : 'carry'; }
      out.push({ date: r[0], lo: lo, hi: hi, last: last, src: src, deals: r[5] == null ? 0 : +r[5] });
      prev = last;
    });
    return out;
  }
  // Turning points: a reversal of 5% or more in the last traded price from its
  // running extreme. The same definition is used to call a turn, to date the
  // current move and to score it.
  function pivots(rows, thr) {
    const p = []; let dirn = 0, hi = rows[0].last, lo = rows[0].last, hii = 0, loi = 0;
    rows.forEach((r, i) => {
      const v = r.last;
      if (v > hi) { hi = v; hii = i; }
      if (v < lo) { lo = v; loi = i; }
      if (dirn >= 0 && v <= hi * (1 - thr)) { p.push({ kind: 'high', i: hii, date: rows[hii].date, px: hi }); dirn = -1; hi = v; hii = i; lo = v; loi = i; }
      else if (dirn <= 0 && v >= lo * (1 + thr)) { p.push({ kind: 'low', i: loi, date: rows[loi].date, px: lo }); dirn = 1; hi = v; hii = i; lo = v; loi = i; }
    });
    return p;
  }
  function factorState(code) { const f = (D.factors || []).find(x => x.code === code); return f ? f.state : null; }
  // A factor read as a TURN signal: 0 = the move's driver is still pushing,
  // 100 = it has reversed. Polarity follows the direction of the move.
  function turnFromState(st, up) {
    if (!st) return null;
    if (st === 'watch') return 75;
    if (st === 'quiet') return 50;
    return up ? (st === 'bull' ? 0 : 100) : (st === 'bear' ? 0 : 100);
  }

  // The eight components. Weights renormalise over whatever applies to the
  // benchmark, so a missing component never inflates or deflates the score.
  const RW = { age: 20, stretch: 15, fade: 15, deals: 10, ladder: 10, fwd: 10, driver: 15, event: 5 };
  function turnRisk(rows, cfg, noDeals) {
    const p = rows.map(r => r.last), n = p.length, L = p[n - 1];
    const pv = pivots(rows, 0.05);
    const last = pv.length ? pv[pv.length - 1] : null;
    const up = last ? last.kind === 'low' : true;
    const legs = []; for (let i = 1; i < pv.length; i++) legs.push(_dayGap(pv[i - 1].date, pv[i].date));
    legs.sort((a, b) => a - b);
    const med = legs.length ? legs[Math.floor(legs.length / 2)] : 40;
    const age = last ? _dayGap(last.date, rows[n - 1].date) : null;
    const e12 = _ema(p, 12), e26 = _ema(p, 26), macd = e12.map((v, i) => v - e26[i]), sig = _ema(macd, 9);
    const hist = macd.map((v, i) => v - sig[i]);
    let fade = 0;
    for (let i = n - 1; i > 0; i--) { const d = hist[i] - hist[i - 1]; if (up ? d < 0 : d > 0) fade++; else break; }
    const w20 = p.slice(-20), m20 = _mean(w20), s20 = _sd(w20);
    const pb = s20 > 0 ? (L - (m20 - 2 * s20)) / (4 * s20) : 0.5;
    const dl = rows.map(r => r.deals);
    const a5 = dl.slice(-5).reduce((s, v) => s + v, 0);
    const a30 = dl.slice(-30).reduce((s, v) => s + v, 0) / Math.min(30, dl.length) * 5;
    const ratio = a30 > 0 ? a5 / a30 : (a5 > 0 ? 2 : 0);
    const level = (a30 === 0 && a5 === 0) ? 'light' : (ratio > 1.2 ? 'heavy' : (ratio < 0.8 ? 'light' : 'normal'));
    const c = {
      age: age == null ? null : _clip(age / (med || 40) * 100),
      stretch: _clip(up ? pb * 100 : (1 - pb) * 100),
      fade: _clip(fade * 25),
      deals: noDeals ? null : (level === 'heavy' ? 100 : level === 'light' ? 0 : 50),
      ladder: cfg.ladder != null ? cfg.ladder : turnFromState(factorState('F9'), up),
      fwd: cfg.fwd == null ? null : (cfg.fwd ? 100 : 0),
      driver: cfg.driver != null ? cfg.driver : turnFromState(factorState('G1'), up),
      event: cfg.event == null ? null : (cfg.event ? 100 : 0)
    };
    let num = 0, den = 0;
    Object.keys(RW).forEach(k => { if (c[k] != null) { num += RW[k] * c[k]; den += RW[k]; } });
    return { score: den ? Math.round(num / den) : null, parts: c, up: up, pivot: last, age: age, med: med, level: level, fade: fade };
  }
  const BANDS = [[75, 'b4', 'Turning'], [55, 'b3', 'Elevated'], [30, 'b2', 'Building'], [0, '', 'Low']];
  const bandOf = v => BANDS.find(b => v >= b[0]);
  const PH = { up: ['ph-up', 'RISING'], down: ['ph-down', 'FALLING'], stalling: ['ph-stall', 'RISING, STALLING'],
               'stalling-down': ['ph-stall', 'FALLING, STALLING'], turning: ['ph-turn', 'TURNING'],
               turned: ['ph-turn', 'TURNED'], flat: ['ph-flat', 'NO CLEAR TREND'] };
  const MTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dLong = iso => { const d = new Date(iso + 'T00:00:00Z'); return MTH[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
  const dShort = iso => { const d = new Date(iso + 'T00:00:00Z'); return MTH[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate(); };
  const money = (v, st) => '$' + (v % 1 ? v.toFixed(1) : v) + (st ? '/st' : '');

  const SCALE = ['Low', 'Building', 'Elevated', 'Turning'];

  document.getElementById('bench').innerHTML = D.benchmarks.map(b => {
    const cfg = TU[b.name] || {};
    const rows = taRows(b.name);
    let out = '<div class="card bench"><div class="name">' + b.name + '</div>' +
              '<div class="now">' + b.now + '</div>';
    if (!rows) {
      return out + (cfg.call ? '<div class="turn ' + (cfg.tone || 'soon') + '">' + cfg.call + '</div>' : '') +
             (cfg.why ? '<div class="turnsub">' + cfg.why + '</div>' : '') + '</div>';
    }
    const st = /US Gulf/.test(b.name);
    const cur = rows[rows.length - 1];
    const r = turnRisk(rows, cfg, /Middle East/i.test(b.name));
    // The assessment date appears ONLY when the price on the card is older than the
    // edition itself. On any other day it just repeats the "Updated" chip at the top
    // of the page (Bora, 21 Sep 2026); when it is stale it is the most useful line here.
    if (cur.date !== D.asof) out += '<div class="nowsub">assessed ' + dShort(cur.date) + ', not re-marked since</div>';
    // phase: derived from the pivots, overridden when the run calls a turn the
    // 5% test has not yet confirmed.
    let key = cfg.phase;
    if (!key) {
      if (!r.pivot) key = 'flat';
      else if (r.age != null && r.age <= 10) key = 'turned';
      else if (r.score >= 75) key = r.up ? 'stalling' : 'stalling-down';
      else key = r.up ? 'up' : 'down';
    }
    const ph = PH[key] || PH.flat;
    out += '<span class="phase ' + ph[0] + '">' + ph[1] + '</span>';
    if (r.pivot) {
      const mv = (cur.last / r.pivot.px - 1) * 100;
      out += '<div class="phage">Day ' + r.age + ' of the ' + (r.up ? 'rise' : 'fall') + ' · ' +
             money(r.pivot.px, false) + ' → ' + money(cur.last, st) + ', ' +
             (mv >= 0 ? 'up ' : 'down ') + Math.abs(mv).toFixed(0) + '% since ' + dLong(r.pivot.date) + '</div>';
    }
    if (cfg.call) out += '<div class="turn ' + (cfg.tone || 'soon') + '">' + cfg.call + '</div>';
    if (cfg.why) out += '<div class="turnsub">' + cfg.why + '</div>';
    if (r.score != null) {
      const bd = bandOf(r.score);
      out += '<div class="risk"><div class="risk-top"><span class="lab">Turn risk</span>' +
             '<span class="risk-word rw-' + bd[1] + '">' + bd[2].toUpperCase() + '</span></div>' +
             '<div class="risk-bar" role="img" aria-label="Turn risk ' + r.score + ' out of 100"><i class="' + bd[1] + '" style="width:' + r.score + '%"></i></div>' +
             '<div class="risk-scale">' + SCALE.map(w => '<span class="' + (w.toUpperCase() === bd[2].toUpperCase() ? 'on rw-' + bd[1] : '') + '">' + w + '</span>').join('') + '</div></div>';
    }
    return out + '</div>';
  }).join('');
  document.getElementById('bench').insertAdjacentHTML('afterend',
  '<div class="bench-foot"><b>Turn risk</b> is how close a market looks to the end of its current move, from Low to Turning. ' +
  'It weighs how long the move has run against how long moves in that market usually run, how far the last traded price sits above its recent range, ' +
  'whether momentum is fading, how much business is being reported against the normal rate, and whether the reasons behind the move are reversing. ' +
  'A turn means a reversal of 5% or more in the last traded price. Past patterns and stated judgement, not a guarantee; these calls have not yet been scored.</div>');

  // factors
  const stCls = { bull: ['st-bull', 'BULLISH'], bear: ['st-bear', 'BEARISH'], watch: ['st-watch', 'WATCH'], quiet: ['st-quiet', 'NEUTRAL'] };
  document.getElementById('factors').innerHTML = D.factors.map(f => {
    const s = stCls[f.state] || stCls.quiet;
    const items = f.note.split(/;\s+|(?<=[.!?])(?<!(?:est|approx|vs|ca|no)\.)\s+(?=[A-Z€$~<(])/).map(x => x.trim()).filter(Boolean)
      .map(x => { let y = x.charAt(0).toUpperCase() + x.slice(1); if (!/[.!?]$/.test(y)) y += '.'; return y; });
    const note = '<ul class="note">' + items.map(x => '<li>' + x + '</li>').join('') + '</ul>';
    return '<div class="card fact"><div class="top"><span><span class="code">' + f.code + '</span> <span class="fname">' + f.name + '</span></span>' +
      '<span class="state ' + s[0] + '">' + s[1] + '</span></div>' + note + '</div>';
  }).join('');

  // drivers
  const chgCls = { up: 'up', down: 'down', flat: 'flat' };
  // 52-week graph (7 Sep 2026): D.history[name] = [[ISO date, close], ...] oldest first.
  // Matched by name (falls back to a keyword so a renamed tile still finds its series).
  const H = D.history || {};
  const findHist = name => {
    if (H[name]) return H[name];
    const n = name.toLowerCase();
    const key = Object.keys(H).find(k => { const kk = k.toLowerCase();
      return ['ttf', 'brent', 'henry', 'corn', 'wheat', 'soy'].some(w => n.includes(w) && kk.includes(w)); });
    return key ? H[key] : null;
  };
  const fmtN = v => v >= 100 ? Math.round(v).toString() : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
  const fmtD = iso => { const dt = new Date(iso + 'T00:00:00Z'); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const drawSparks = () => {
    document.querySelectorAll('#drivers .spark52').forEach(box => {
      const pts = (findHist(box.dataset.name) || []).filter(p => p && p[1] != null);
      if (pts.length < 2) { box.innerHTML = ''; return; }
      const W = Math.max(80, Math.round(box.getBoundingClientRect().width)) || 200, Hh = 44, padT = 5, padB = 3;
      const vals = pts.map(p => p[1]);
      const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
      const x = i => (i / (pts.length - 1)) * W;
      const y = v => padT + (1 - (v - lo) / span) * (Hh - padT - padB);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
      const area = line + ' L' + W + ' ' + Hh + ' L0 ' + Hh + ' Z';
      const last = pts[pts.length - 1];
      const step = W / (pts.length - 1);
      const hits = pts.map((p, i) => {
        const cx = x(i), cy = y(p[1]);
        const lbl = fmtD(p[0]) + ' · ' + fmtN(p[1]);
        const anchor = cx < W * 0.3 ? 'start' : (cx > W * 0.7 ? 'end' : 'middle');
        return '<rect class="hit" x="' + (cx - step / 2).toFixed(1) + '" y="0" width="' + step.toFixed(1) + '" height="' + Hh + '"><title>' + lbl + '</title></rect>' +
          '<g class="pt"><circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="2.5"></circle>' +
          '<text x="' + cx.toFixed(1) + '" y="' + (cy < 16 ? cy + 12 : cy - 6).toFixed(1) + '" font-size="9.5" text-anchor="' + anchor + '">' + lbl + '</text></g>';
      }).join('');
      box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" width="' + W + '" height="' + Hh + '" role="img" aria-label="52-week price history, low ' + fmtN(lo) + ', high ' + fmtN(hi) + '">' +
        '<path class="area" d="' + area + '"></path>' +
        '<line class="base" x1="0" y1="' + Hh + '" x2="' + W + '" y2="' + Hh + '"></line>' +
        '<path class="line" d="' + line + '"></path>' +
        '<circle class="dot" cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(last[1]).toFixed(1) + '" r="2.5"></circle>' +
        hits + '</svg>';
    });
  };
  const range52 = (d) => {
    const pts = (findHist(d.name) || []).filter(p => p && p[1] != null);
    if (pts.length < 2) return '';
    const vals = pts.map(p => p[1]);
    return '<div class="spark52" data-name="' + d.name.replace(/"/g, '&quot;') + '"></div>' +
      '<div class="range">52-wk range <b>' + fmtN(Math.min(...vals)) + '</b> – <b>' + fmtN(Math.max(...vals)) + '</b></div>';
  };
  document.getElementById('drivers').innerHTML = D.drivers.map(d =>
    '<div class="card drv"><div class="name">' + d.name + '</div><div class="val">' + d.val + '</div>' +
    '<div class="chg ' + (chgCls[d.dir] || 'flat') + '">' + d.chg + '</div>' + range52(d) + '<div class="sub">' + d.sub + '</div></div>'
  ).join('');
  drawSparks();
  let sparkT; window.addEventListener('resize', () => { clearTimeout(sparkT); sparkT = setTimeout(drawSparks, 120); });

  // EU duty-free urea quota (9 Sep 2026): D.eu_quota is the embedded snapshot;
  // /quota.json (rewritten daily by the Netlify function) overrides it when newer.
  const fmtT = v => Math.round(v).toLocaleString('en-GB');
  const longISO = iso => { const d = new Date(iso + 'T00:00:00Z'); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); };
  const shortISO = iso => { const d = new Date(iso + 'T00:00:00Z'); return MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate(); };
  const mdISO = iso => { const d = new Date(iso + 'T00:00:00Z'); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  function renderQuota(q) {
    const box = document.getElementById('quota');
    if (!box || !q || !q.initial_t) return;
    const used = q.used_t != null ? q.used_t : q.initial_t - q.balance_t;
    const pct = Math.max(0, Math.min(100, used / q.initial_t * 100));
    const asof = q.last_allocation || q.source_update || q.fetched;
    const cls = pct >= 90 ? 'crit' : (pct >= 70 ? 'hot' : '');
    // Seasonal projection (9 Sep 2026, Bora): the quota is drawn at customs
    // clearance, and European arrivals are seasonal — light June–September,
    // heavy October–February. SEASON = share of the year's urea imports cleared
    // in each month by the five tracked EU importers (France, Italy, Spain,
    // Poland, Romania), average of 2016–2024 (Global Trade Tracker, HS 310210).
    const SEASON = [10.4, 10.8, 9.3, 8.4, 8.3, 5.7, 6.0, 6.4, 8.1, 8.7, 8.7, 9.3];
    const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    const wday = d => SEASON[d.getUTCMonth()] / 100 / dim(d.getUTCFullYear(), d.getUTCMonth() + 1);
    function seasonal(startISO, asofISO, usedT, quotaT, endISO) {
      const start = new Date(startISO + 'T00:00:00Z'), a = new Date(asofISO + 'T00:00:00Z'), end = new Date(endISO + 'T00:00:00Z');
      let sw = 0; for (let d = new Date(start); d <= a; d.setUTCDate(d.getUTCDate() + 1)) sw += wday(d);
      if (sw <= 0) return null;
      const annual = usedT / sw, marks = {};
      let cum = usedT, d = new Date(a);
      while (cum < quotaT && d < end) { d.setUTCDate(d.getUTCDate() + 1); cum += annual * wday(d); [50, 75, 90].forEach(p => { if (!marks[p] && cum >= quotaT * p / 100) marks[p] = d.toISOString().slice(0, 10); }); }
      return { annual, windowShare: sw * 100, out: cum >= quotaT ? d.toISOString().slice(0, 10) : null, marks };
    }
    let pace = '';
    if (q.exhaustion_date) {
      pace = '<b>The quota is used up.</b> The Commission recorded it as exhausted on ' + longISO(q.exhaustion_date) + ', so urea from the origins it covered pays the 6.5% duty again until a new quota opens.';
    } else if (asof && q.start) {
      const days = daysBetween(q.start, asof);
      if (days >= 14 && used > 0) {
        const perDay = used / days;
        const left = Math.round(q.balance_t / perDay);
        const out = new Date(asof + 'T00:00:00Z'); out.setUTCDate(out.getUTCDate() + left);
        const outISO = out.toISOString().slice(0, 10);
        const s = q.end ? seasonal(q.start, asof, used, q.initial_t, q.end) : null;
        if (s && s.out) {
          const gap = daysBetween(s.out, q.end);
          pace = 'European urea imports are seasonal: the five tracked EU importers clear only about ' + Math.round(s.windowShare) + '% of their year\'s urea between ' + shortISO(q.start) + ' and ' + shortISO(asof) + ', and about ' + Math.round(SEASON[9] + SEASON[10] + SEASON[11] + SEASON[0] + SEASON[1]) + '% between October and February. Scaling the ' + fmtT(used) + ' t cleared so far by that pattern, the quota is expected to run out around <b>' + longISO(s.out) + '</b>' + (gap > 0 ? ', about ' + Math.round(gap / 7) + ' weeks before it closes on ' + shortISO(q.end) : '') + (s.marks[50] ? ' — half used around ' + shortISO(s.marks[50]) : '') + (s.marks[90] ? ', 90% used around ' + shortISO(s.marks[90]) : '') + '. A straight-line average (about ' + fmtT(perDay) + ' t a day) would put it at ' + longISO(outISO) + ', but that ignores the autumn and winter buying season.';
        } else if (s && !s.out) {
          pace = 'European urea imports are seasonal. Scaling the ' + fmtT(used) + ' t cleared so far by the usual monthly pattern of the five tracked EU importers, the quota is not expected to run out before it closes on ' + longISO(q.end) + '.';
        } else {
          const endGap = q.end ? daysBetween(outISO, q.end) : null;
          pace = 'Since the quota opened on ' + shortISO(q.start) + ', about <b>' + fmtT(perDay) + ' t a day</b> has cleared duty-free. At that pace the remaining <b>' + fmtT(q.balance_t) + ' t</b> would last about ' + Math.round(left / 7) + ' weeks and run out around <b>' + longISO(outISO) + '</b>' + (endGap != null && endGap > 0 ? ', about ' + Math.round(endGap / 7) + ' weeks before the quota closes on ' + shortISO(q.end) + '.' : '.') ;
        }
        const h = (q.history || []).filter(p => p && p[1] != null).sort((a, b) => a[0] < b[0] ? -1 : 1);
        if (h.length >= 2) {
          const last = h[h.length - 1];
          let j = h.length - 2; while (j > 0 && daysBetween(h[j][0], last[0]) < 28) j--;
          const span = daysBetween(h[j][0], last[0]);
          if (span >= 14) {
            const recent = (h[j][1] - last[1]) / span;
            if (recent > 0) pace += ' Over the last ' + span + ' days about <b>' + fmtT(recent) + ' t a day</b> has cleared, against ' + fmtT(perDay) + ' t a day since the start.';
          }
        }
        pace += ' These dates follow past patterns, not a forecast of demand — a few large clearances, or a change in which origins pay the duty, can move them by weeks.';
      }
    }
    box.innerHTML =
      (asof ? '<div class="qupdated">Updated on ' + mdISO(asof) + '</div>' : '') +
      '<div class="quota-grid">' +
        '<div><div class="qname">Still available duty-free</div><div class="qval">' + fmtT(q.balance_t) + ' t</div><div class="qsub">' + Math.round(100 - pct) + '% of the quota, as of the Commission\'s allocation of ' + (asof ? shortISO(asof) : '—') + '</div></div>' +
        '<div><div class="qname">Already cleared duty-free</div><div class="qval">' + fmtT(used) + ' t</div><div class="qsub">' + Math.round(pct) + '% used' + (q.awaiting_t ? ' · ' + fmtT(q.awaiting_t) + ' t of claims waiting to be allocated' : '') + '</div></div>' +
        '<div><div class="qname">Total quota</div><div class="qval">' + fmtT(q.initial_t) + ' t</div><div class="qsub">' + (q.start ? shortISO(q.start) : '') + ' – ' + (q.end ? longISO(q.end) : '') + ' · first come, first served</div></div>' +
      '</div>' +
      '<div class="bar" role="img" aria-label="' + Math.round(pct) + '% of the quota used"><i class="' + cls + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="ticks"><span>0 t</span><span>' + Math.round(pct) + '% used</span><span>' + fmtT(q.initial_t) + ' t</span></div>' +
      (pace ? '<div class="pace">' + pace + '</div>' : '') +
      (q.critical && !q.exhaustion_date ? '<div class="pace" style="margin-top:6px">The Commission has flagged this quota as <b>critical</b>, so customs may ask importers for a guarantee covering the duty until each entry is confirmed against the balance.</div>' : '') +
      '<div class="qnote">Council Regulation (EU) 2026/1181 lets 890,000 t of urea into the EU without the 6.5% import duty between May 30, 2026 and May 31, 2027, from any origin except Russia and Belarus, which stay excluded and also pay the extra €60/t tariff. It matters for the origins that would otherwise pay the duty, such as the Gulf producers and the United States; Egypt, Algeria and Uzbekistan already ship duty-free under trade agreements and do not draw on it. Once the quota is used up, the 6.5% duty applies again. Source: the European Commission\'s <a href="' + (q.source || 'https://ec.europa.eu/taxation_customs/dds2/taric/quota_consultation.jsp') + '" target="_blank" rel="noopener">QUOTA database, order number 09.0173</a>' + (q.source_update ? ', last updated ' + shortISO(q.source_update) : '') + '.</div>';
  }
  renderQuota(D.eu_quota);
  (function () {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    fetch('/quota.json?d=' + stamp, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(q => {
        if (!q || !q.initial_t) return;
        const cur = D.eu_quota || {};
        const newer = !cur.fetched || (q.fetched || '') >= cur.fetched || (q.last_allocation || '') > (cur.last_allocation || '');
        if (newer) renderQuota(q);
      })
      .catch(() => {});
  })();

  // geo
  document.getElementById('geo').innerHTML = D.geo.map(g => '<li>' + g + '</li>').join('');

  // ---------------------------------------------------------------------------
  // Technical View (14 Sep 2026, Bora). KEEP ON EVERY EDITION. Three technical
  // tools on the "last done" price of each benchmark, computed HERE from
  // D.ta.series — runs only append the day's row, never compute a tool by hand.
  // Reference implementation and backtest: claude/urea-technical-view.md.
  // ---------------------------------------------------------------------------
  (function () {
    const box = document.getElementById('technicals');
    const T = D.ta; if (!box) return;
    if (!T || !T.series) { box.hidden = true; const sec = box.closest('details.sec');
      if (sec) sec.hidden = true; else if (box.previousElementSibling) box.previousElementSibling.hidden = true; return; }
    // Historical hit rates of the composite (all four benchmarks, Sep 2021 -
    // Sep 2026, unchanged prices count as misses) by |score| bucket: [hit %, median % move].
    const CONF = { strong: { 5: [71, 3.4], 10: [69, 4.9], 15: [65, 6.1], 20: [58, 5.6] },   // three agree, business not heavy
                   lean:   { 5: [63, 1.8], 10: [62, 3.1], 15: [62, 4.7], 20: [57, 4.2] },   // two agree, or three on heavy business
                   weak:   { 5: [50, 0.0], 10: [56, 2.3], 15: [57, 3.4], 20: [51, 1.3] } };  // two agree on heavy business
    const ema = (a, n) => { const k = 2 / (n + 1); const o = []; a.forEach((v, i) => o.push(i ? o[i - 1] + k * (v - o[i - 1]) : v)); return o; };
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); };
    const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
    const fmtPct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
    const shortD = iso => { const d = new Date(iso + 'T00:00:00Z'); return MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate(); };
    const frac = h => h >= 66 ? 'about two of three past cases' : h >= 62 ? 'more than six of ten past cases' : h >= 58 ? 'about six of ten past cases' : h >= 54 ? 'a little over half of past cases' : 'about half of past cases';

    function prepare(rows) {
      // rows: [[date, low, high, last|null, src], ...] oldest first. A null last = no trade reported
      // that day: carry the previous last-done price, snapped into the day's assessed range.
      const out = []; let prev = null;
      rows.forEach(r => {
        const lo = +r[1], hi = +r[2]; let last = r[3] == null ? null : +r[3]; let src = r[4] || (last == null ? 'carry' : 'trade');
        if (last == null) { last = prev == null ? lo : Math.min(Math.max(prev, lo), hi); src = prev != null && last !== prev ? 'snap' : 'carry'; }
        out.push({ date: r[0], lo, hi, last, src, deals: r[5] == null ? 0 : +r[5], dealsAll: r[6] == null ? null : +r[6] }); prev = last;
      });
      return out;
    }
    // noDeals (Bora, 14 Sep 2026): the deal-activity gauge is NOT applied to Middle East fob —
    // most Gulf sales are long-term formula-priced offtake contracts and spot business is very
    // limited, so a spot trade count there says little about the trend.
    function tools(rows, noDeals) {
      const p = rows.map(r => r.last), n = p.length, L = p[n - 1];
      const t = [];
      // 1 MACD histogram (12, 26, 9): medium-term trend and its acceleration
      const e12 = ema(p, 12), e26 = ema(p, 26); const macd = e12.map((v, i) => v - e26[i]); const sig = ema(macd, 9);
      const histA = macd.map((v, i) => v - sig[i]); const hist = histA[n - 1];
      t.push({ key: 'macd', name: 'Trend (MACD)', vote: sign(hist), value: (hist > 0 ? '+' : '') + hist.toFixed(1),
        text: hist > 0 ? 'the 12-day average is pulling away above the 26-day average' : hist < 0 ? 'the 12-day average is falling away below the 26-day average' : 'the two averages are together',
        series: { e12, e26, hist: histA } });
      // 2 10-day rate of change: short-term momentum
      const rocA = p.map((v, i) => i >= 10 ? (v / p[i - 10] - 1) * 100 : null); const roc = rocA[n - 1] == null ? 0 : rocA[n - 1];
      t.push({ key: 'roc', name: 'Momentum (10-day change)', vote: roc > 1 ? 1 : roc < -1 ? -1 : 0, value: fmtPct(roc),
        text: 'last done is ' + fmtPct(roc) + ' against ten trading days ago', series: { roc: rocA } });
      // 3 Bollinger band position (20, 2): price pressing on a band = strong trend
      const up = [], lo = [], mid = [];
      for (let i = 0; i < n; i++) { if (i < 19) { up.push(null); lo.push(null); mid.push(null); continue; } const w = p.slice(i - 19, i + 1); const m = mean(w), s = sd(w); mid.push(m); up.push(m + 2 * s); lo.push(m - 2 * s); }
      const w20 = p.slice(-20); const m20 = mean(w20), s20 = sd(w20); const pb = s20 > 0 ? (L - (m20 - 2 * s20)) / (4 * s20) : 0.5;
      t.push({ key: 'boll', name: 'Band position (Bollinger)', vote: pb > 0.8 ? 1 : pb < 0.2 ? -1 : 0, value: Math.round(pb * 100) + '%',
        text: pb > 0.8 ? 'price is pressing on the upper band of its 20-day range' : pb < 0.2 ? 'price is pressing on the lower band of its 20-day range' : 'price sits inside its 20-day band',
        series: { up, lo, mid } });
      // 4 Move streak: urea moves in runs — count consecutive same-direction changes
      let cnt = 0, last = 0; const runA = [0];
      for (let i = 1; i < n; i++) { const c = sign(p[i] - p[i - 1]); if (c) { if (c === last) cnt++; else { cnt = 1; last = c; } } runA.push(cnt * last); }
      const run = runA[n - 1];
      t.push({ key: 'streak', name: 'Run of moves', vote: run >= 2 ? 1 : run <= -2 ? -1 : 0, value: (run > 0 ? '+' : '') + run,
        text: Math.abs(run) >= 2 ? Math.abs(run) + ' consecutive ' + (run > 0 ? 'rises' : 'falls') + ' in last done' : 'no run of moves in one direction',
        series: { run: runA } });
      // 5 Range widening + direction: the assessed low-high spread blowing out while last done moves
      const widths = rows.map(r => r.hi - r.lo); const wavgA = widths.map((v, i) => i >= 9 ? mean(widths.slice(i - 9, i + 1)) * 1.5 : null);
      const wavg = mean(widths.slice(-10)); const wnow = widths[n - 1];
      const d3 = n > 3 ? L - p[n - 4] : 0; const wide = wnow > wavg * 1.5;
      t.push({ key: 'range', name: 'Range widening', vote: wide && d3 > 0 ? 1 : wide && d3 < 0 ? -1 : 0, value: '$' + wnow.toFixed(0),
        text: wide ? 'the assessed range has widened to $' + wnow.toFixed(0) + ' while last done ' + (d3 > 0 ? 'rose' : d3 < 0 ? 'fell' : 'held') : 'the assessed range ($' + wnow.toFixed(0) + ' wide) is not unusually wide',
        series: { width: widths, thresh: wavgA } });
      // 6 Deal activity: distinct trades reported over the last 5 assessment days against the benchmark's own 30-day norm.
      //   Not a direction vote. Tested 2021-26: a trend reading on LIGHT reported business keeps going more reliably
      //   than one on HEAVY business (the move is largely done once a lot of tonnage has cleared at the new level).
      // Source of the count: Profercy only (the tested series) until the last 30 rows all carry the
      //   all-publications count (Profercy + Argus + Fertecon, each deal counted once); then that count,
      //   compared with its own 30-day norm.
      const allReady = rows.length >= 30 && rows.slice(-30).every(r => r.dealsAll != null);
      const dl = rows.map(r => allReady && r.dealsAll != null ? r.dealsAll : r.deals); const a5 = dl.slice(-5).reduce((s, v) => s + v, 0); const a30 = dl.slice(-30).reduce((s, v) => s + v, 0) / Math.min(30, dl.length) * 5;
      const ratio = a30 > 0 ? a5 / a30 : (a5 > 0 ? 2 : 0); const level = a30 === 0 && a5 === 0 ? 'light' : ratio > 1.2 ? 'heavy' : ratio < 0.8 ? 'light' : 'normal';
      t.push({ key: 'deals', name: 'Deal activity', vote: 0, modifier: level, allReady, value: a5 + '/5',
        text: a30 === 0 && a5 === 0 ? 'no concluded business reported in 30 days — prices are moving on bids and offers alone; in past years moves like this tended to keep going' : level === 'heavy' ? 'reported business is running heavy against its 30-day norm (' + a30.toFixed(1) + ' per 5 days) — when this many deals are done, buyers and sellers have usually already agreed the new price level, so in past years the rise or fall tended to run out of steam sooner' : level === 'light' ? 'reported business is light against its 30-day norm (' + a30.toFixed(1) + ' per 5 days) — with few deals done, the market has not yet settled on a new price level, so in past years the rise or fall tended to keep going' : 'reported business is about normal (' + a30.toFixed(1) + ' per 5 days)',
        series: { deals: dl, norm: dl.map((v, i) => i >= 29 ? dl.slice(i - 29, i + 1).reduce((s, x) => s + x, 0) / 30 : null) } });
      return t.filter(x => x.key === 'macd' || x.key === 'boll' || x.key === 'streak' || (x.key === 'deals' && !noDeals));
    }
    // --- small charts: price on top, the tool's own reading below (or overlaid when it shares the price scale) ---
    const N_SHOW = 60;
    function chart(rows, tool) {
      const n = rows.length, s0 = Math.max(0, n - N_SHOW), R = rows.slice(s0), m = R.length;
      const W = 320, PH = 56, IH = 34, GAP = 6, PADX = 2, PADY = 3;
      const hasLower = tool.key === 'macd' || tool.key === 'roc' || tool.key === 'range' || tool.key === 'deals';
      const H = hasLower ? PH + GAP + IH : PH;
      const x = i => PADX + (i / (m - 1)) * (W - 2 * PADX);
      const f1 = v => Math.round(v * 10) / 10;
      const p = R.map(r => r.last);
      // price-scale extent (include overlays on the price scale)
      let vals = p.slice();
      const sl = k => tool.series[k].slice(s0);
      if (tool.key === 'boll') vals = vals.concat(sl('up').filter(v => v != null), sl('lo').filter(v => v != null));
      if (tool.key === 'macd') vals = vals.concat(sl('e12'), sl('e26'));
      if (tool.key === 'range') vals = vals.concat(R.map(r => r.lo), R.map(r => r.hi));
      const pLo = Math.min(...vals), pHi = Math.max(...vals), pSpan = (pHi - pLo) || 1;
      const y = v => PADY + (1 - (v - pLo) / pSpan) * (PH - 2 * PADY);
      const path = (arr, yf) => { let d = '', pen = false; arr.forEach((v, i) => { if (v == null || isNaN(v)) { pen = false; return; } d += (pen ? 'L' : 'M') + f1(x(i)) + ' ' + f1(yf(v)) + ' '; pen = true; }); return d; };
      let g = '';
      // overlays on the price panel
      if (tool.key === 'boll') {
        const up = sl('up'), lo = sl('lo'), mid = sl('mid');
        let area = '', first = null; up.forEach((v, i) => { if (v == null) return; if (first === null) first = i; area += (area ? 'L' : 'M') + f1(x(i)) + ' ' + f1(y(v)) + ' '; });
        for (let i = m - 1; i >= 0; i--) if (lo[i] != null) area += 'L' + f1(x(i)) + ' ' + f1(y(lo[i])) + ' ';
        g += '<path class="band" d="' + area + 'Z"></path><path class="ind" d="' + path(up, y) + '"></path><path class="ind" d="' + path(lo, y) + '"></path><path class="ind2" d="' + path(mid, y) + '"></path>';
      }
      if (tool.key === 'range') {
        let area = ''; R.forEach((r, i) => { area += (i ? 'L' : 'M') + f1(x(i)) + ' ' + f1(y(r.hi)) + ' '; });
        for (let i = m - 1; i >= 0; i--) area += 'L' + f1(x(i)) + ' ' + f1(y(R[i].lo)) + ' ';
        g += '<path class="band" d="' + area + 'Z"></path>';
      }
      if (tool.key === 'macd') g += '<path class="ind" d="' + path(sl('e12'), y) + '"></path><path class="ind2" d="' + path(sl('e26'), y) + '"></path>';
      // price line; for the streak tool, coloured by run direction
      if (tool.key === 'streak') {
        const run = sl('run');
        for (let i = 1; i < m; i++) { const r = run[i]; const cls = r >= 2 ? 'seg-up' : r <= -2 ? 'seg-down' : 'seg-flat'; g += '<line class="' + cls + '" x1="' + f1(x(i - 1)) + '" y1="' + f1(y(p[i - 1])) + '" x2="' + f1(x(i)) + '" y2="' + f1(y(p[i])) + '"></line>'; }
      } else {
        g += '<path class="price" d="' + path(p, y) + '"></path>';
      }
      g += '<circle class="dot" cx="' + f1(x(m - 1)) + '" cy="' + f1(y(p[m - 1])) + '" r="2.5"></circle>';
      // lower panel
      if (hasLower) {
        const top = PH + GAP; let arr, zero = true, ref = null;
        if (tool.key === 'macd') arr = sl('hist');
        if (tool.key === 'roc') arr = sl('roc');
        if (tool.key === 'range') { arr = sl('width'); ref = sl('thresh'); zero = false; }
        if (tool.key === 'deals') { arr = sl('deals'); ref = sl('norm'); zero = false; }
        const nz = arr.filter(v => v != null).concat(ref ? ref.filter(v => v != null) : []);
        let lo2 = Math.min(...nz), hi2 = Math.max(...nz);
        if (zero) { const a = Math.max(Math.abs(lo2), Math.abs(hi2), tool.key === 'roc' ? 1.5 : 0.01); lo2 = -a; hi2 = a; } else { lo2 = 0; hi2 = hi2 || 1; }
        const y2 = v => top + PADY + (1 - (v - lo2) / ((hi2 - lo2) || 1)) * (IH - 2 * PADY);
        const bw = Math.max(1.5, (W - 2 * PADX) / m - 1);
        g += '<line class="zero" x1="' + PADX + '" y1="' + f1(y2(0)) + '" x2="' + (W - PADX) + '" y2="' + f1(y2(0)) + '"></line>';
        if (tool.key === 'roc') g += '<rect class="dead" x="' + PADX + '" y="' + f1(y2(1)) + '" width="' + (W - 2 * PADX) + '" height="' + f1(y2(-1) - y2(1)) + '"></rect><path class="ind" d="' + path(arr, y2) + '"></path>';
        else arr.forEach((v, i) => { if (v == null) return; const yy = y2(v), y0 = y2(0); g += '<rect class="' + (tool.key === 'deals' ? (v > 0 ? 'bar-deal' : 'bar-flat') : tool.key === 'range' ? (ref[i] != null && v > ref[i] ? 'bar-hot' : 'bar-flat') : v > 0 ? 'bar-up' : v < 0 ? 'bar-down' : 'bar-flat') + '" x="' + f1(x(i) - bw / 2) + '" y="' + f1(Math.min(yy, y0)) + '" width="' + f1(bw) + '" height="' + f1(Math.max(0.8, Math.abs(yy - y0))) + '"></rect>'; });
        if (ref) g += '<path class="ind2" d="' + path(ref, y2) + '"></path>';
      }
      // hover: one hit rect per day with a title tooltip
      const step = (W - 2 * PADX) / (m - 1);
      const lbl = i => { const r = R[i]; let s = shortD(r.date) + ' · last done $' + r.last + ' (assessed ' + r.lo + '–' + r.hi + ')';
        if (tool.key === 'macd') s += ' · MACD ' + f1(sl('hist')[i]); if (tool.key === 'roc' && sl('roc')[i] != null) s += ' · 10-day change ' + fmtPct(sl('roc')[i]);
        if (tool.key === 'boll' && sl('up')[i] != null) s += ' · band ' + f1(sl('lo')[i]) + '–' + f1(sl('up')[i]); if (tool.key === 'streak') s += ' · run ' + sl('run')[i]; if (tool.key === 'range') s += ' · range width $' + f1(sl('width')[i]); if (tool.key === 'deals') s += ' · ' + sl('deals')[i] + ' trade' + (sl('deals')[i] === 1 ? '' : 's') + ' reported';
        return s; };
      g += R.map((r, i) => '<rect class="hit" x="' + f1(x(i) - step / 2) + '" y="0" width="' + f1(step) + '" height="' + H + '"><title>' + lbl(i) + '</title></rect>').join('');
      const legend = { macd: 'price · <i class="k ind"></i>12-day avg · <i class="k ind2"></i>26-day avg · bars: gap between them and its 9-day trend',
                       roc: 'price · below: % change over 10 trading days (grey band = within ±1%, no vote)',
                       boll: 'price · <i class="k ind"></i>20-day band (two standard deviations) · <i class="k ind2"></i>20-day average',
                       streak: 'price coloured by run: <i class="k up"></i>rising run · <i class="k down"></i>falling run · <i class="k flat"></i>no run',
                       deals: 'price · below: distinct concluded trades reported each day' + (tool.allReady ? ' across Profercy, Argus and Fertecon' : ' by Profercy') + ', <i class="k ind2"></i>30-day daily average',
                       range: 'last done inside the <i class="k band"></i>assessed low–high · below: range width, <i class="k ind2"></i>1.5× its 10-day average — bars above it count as widening' }[tool.key];
      return '<div class="ta-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + tool.name + ', last ' + m + ' assessment days">' + g + '</svg><div class="ta-legend">' + legend + '</div></div>';
    }
    function verdict(score, activity) {
      const a = Math.abs(score), dir = score > 0 ? 'up' : 'down', heavy = activity === 'heavy';
      const n = a + ' of 3 trend tools ' + dir;
      const biz = activity === 'heavy' ? 'heavy business' : activity === 'light' ? 'light business' : activity ? 'normal business' : '';
      if (a >= 3 && !heavy) return { cls: 'strong', bucket: 'strong', label: 'Strong ' + dir, dir, sub: n + (biz ? ', ' + biz : '') };
      if (a >= 3) return { cls: 'lean', bucket: 'lean', label: 'Leaning ' + dir, dir, sub: n + ', but ' + biz };
      if (a >= 2 && !heavy) return { cls: 'lean', bucket: 'lean', label: 'Leaning ' + dir, dir, sub: n + (biz ? ', ' + biz : '') };
      if (a >= 2) return { cls: 'weak', bucket: 'weak', label: 'Leaning ' + dir + ', weakly', dir, sub: n + ', but ' + biz };
      return { cls: 'none', bucket: null, label: 'No clear direction', dir: 'flat', sub: '' };
    }
    const arrow = { 1: ['▲', 'ta-up'], '-1': ['▼', 'ta-down'], 0: ['●', 'ta-flat'] };
    const modArrow = { heavy: ['◆', 'ta-down'], light: ['◆', 'ta-up'], normal: ['◆', 'ta-flat'] };
    const cards = Object.keys(T.series).map(name => {
      const rows = prepare(T.series[name]); if (rows.length < 30) return '';
      const noDeals = /Middle East/i.test(name);
      const cur = rows[rows.length - 1]; const t = tools(rows, noDeals); const score = t.reduce((s, x) => s + x.vote, 0); const act = (t.find(x => x.key === 'deals') || {}).modifier; const v = verdict(score, act);
      const unit = /US Gulf/.test(name) ? '/st' : '/t';
      const dirWord = v.dir === 'up' ? 'higher' : 'lower';
      let read;
      if (v.bucket) {
        const c = CONF[v.bucket]; const sg = v.dir === 'up' ? '+' : '−';
        read = '<p><b>Next one to two weeks: ' + dirWord + '.</b> With this reading the price was ' + dirWord + ' five trading days later in ' + frac(c[5][0]) + ' (typical move ' + sg + c[5][1].toFixed(1) + '%) and ten days later in ' + frac(c[10][0]) + ' (' + sg + c[10][1].toFixed(1) + '%).</p>' +
          '<p><b>Three to four weeks:</b> still ' + dirWord + ' in ' + frac(c[15][0]) + ' at fifteen days, ' + frac(c[20][0]).replace(' past cases', '').replace(' of', '') + ' by twenty.</p>';
      } else {
        read = '<p><b>Next one to two weeks: no clear direction.</b> The tools disagree; with readings like this the price was as likely to rise as to fall.</p>';
      }
      const srcTxt = cur.src === 'trade' ? 'traded' : cur.src === 'snap' ? 'carried, moved to the new range edge' : 'carried';
      return '<div class="card ta"><div class="ta-head"><div><div class="name">' + name + '</div>' +
        '<div class="now">$' + (cur.last % 1 ? cur.last.toFixed(1) : cur.last) + ' <span class="ta-last">Last Done</span></div><div class="ta-sub">' + shortD(cur.date) + ' (' + srcTxt + ') · assessed $' + cur.lo + '–' + cur.hi + unit + '</div></div>' +
        '<span class="ta-verdict ' + v.cls + (v.dir === 'down' ? ' d' : '') + '">' + v.label + (v.dir === 'flat' ? '' : ' <small>' + Math.abs(score) + ' of 3 tools point ' + v.dir + '</small>') + '</span></div>' +
        '<ul class="ta-tools">' + t.map(x => { const a = x.modifier ? modArrow[x.modifier] : arrow[x.vote]; return '<li><span class="' + a[1] + '">' + a[0] + '</span> <b>' + x.name + '</b> <span class="ta-val">' + x.value + '</span><span class="ta-why">' + x.text + '</span>' + chart(rows, x) + '</li>'; }).join('') + '</ul></div>';
    }).join('');
    box.innerHTML = '<div class="ta-grid">' + cards + '</div>' +
      '<div class="ta-foot">Price used: the price actually last traded each day, at whichever end of Profercy\'s assessed range it was done; on days with no reported trade the previous traded price is carried. Three trend tools chosen from fourteen tested on the daily Profercy assessments since September 2021 for their record at five to twenty trading days ahead, each voting up, down or neutral, plus a deal-activity gauge that does not vote but weakens the verdict when reported business is running heavy — in the tested years a move on light business kept going far more reliably than one on heavy business. The deal-activity gauge is not applied to the Middle East fob benchmark: most Gulf sales are long-term contracts priced on a formula, so spot business there is very limited and its count says little about the trend. Past record of the verdict: Strong readings were right five trading days later in about seven of ten cases and ten days later in about two of three, fading to a little over half by twenty; Leaning readings in about six of ten. Past record, not a forecast; the US Gulf barge market has been the least predictable of the four. Method and backtest: claude/urea-technical-view.md.</div>';
  })();
})();

} catch (e) { console.error('oracle script part 1', e); }
/* ---- part 2 of 4 (was inline script 2) ---- */
try {

/* iPhone app shell (PWA, 24 Aug 2026) — keep on every edition */
(function () {
  var DIGEST = '/digest/';
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var q = new URLSearchParams(location.search);

  // Home-screen shortcut "Weekly Digest" lands here with ?open=digest;
  // ?open=costs / ?open=cbam open the Production Costs and CBAM pages (9 Sep 2026).
  if (q.get('open') === 'digest') { location.replace(DIGEST); return; }
  if (q.get('open') === 'costs' || q.get('open') === 'cbam') { location.replace(DIGEST + '?page=' + q.get('open')); return; }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  // When the app is brought back to the foreground, check whether a newer
  // edition has been published (13:00 / 19:00 flips) and reload if so.
  var chip = document.getElementById('asof-chip');
  var seen = null;
  function currentChip() {
    try { return JSON.parse(document.getElementById('oracle-data').textContent).updated; } catch (e) { return null; }
  }
  seen = currentChip();
  function checkForNewEdition() {
    if (!standalone || !seen) return;
    fetch('/?v=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (html) {
      var m = html.match(/"updated":\s*"([^"]+)"/);
      if (m && m[1] !== seen) location.reload();
    }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkForNewEdition(); });
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) checkForNewEdition(); });

  // One-time install hint for iPhone Safari users who have not installed yet.
  var isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  var hint = document.getElementById('install-hint');
  var dismissed = false;
  try { dismissed = localStorage.getItem('oracle-install-hint') === '1'; } catch (e) {}
  if (hint && isiOS && !standalone && !dismissed) {
    hint.classList.add('show');
    document.getElementById('install-hint-x').addEventListener('click', function () {
      hint.classList.remove('show');
      try { localStorage.setItem('oracle-install-hint', '1'); } catch (e) {}
    });
  }
})();

} catch (e) { console.error('oracle script part 2', e); }
/* ---- part 3 of 4 (was inline script 3) ---- */
try {

/* Ask the Oracle — panel behaviour (1 Sep 2026). KEEP ON EVERY EDITION. */
(function () {
  var ENDPOINT = 'https://qexbmezexqcitprtdemt.supabase.co/functions/v1/ask';
  var form = document.getElementById('ask-form');
  var input = document.getElementById('ask-input');
  var send = document.getElementById('ask-send');
  var log = document.getElementById('ask-log');
  if (!form) return;

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function paras(s) { return esc(s).split(/\n{2,}|\n/).filter(Boolean).map(function (p) { return '<p>' + p + '</p>'; }).join(''); }
  function add(cls, html) { var d = document.createElement('div'); d.className = cls; d.innerHTML = html; log.appendChild(d); d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return d; }

  function ask(q) {
    if (!q || send.disabled) return;
    add('ask-q', esc(q));
    input.value = '';
    send.disabled = true;
    var wait = add('ask-a', '<span class="ask-think">Reading the reports<i></i><i></i><i></i></span>');
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var html = paras(d.answer || 'No answer came back — try again in a moment.');
        if (d.sources && d.sources.length) {
          var dates = d.sources.map(function (s) { return s.date; }).filter(Boolean);
          if (dates.length) html += '<div class="ask-src">Drawn from Profercy daily reports of ' + esc(dates.slice(0, 4).join(', ')) + '</div>';
        }
        wait.innerHTML = html;
      })
      .catch(function () { wait.innerHTML = '<p>The Oracle could not be reached just now.</p>'; })
      .then(function () { send.disabled = false; input.focus(); });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value.trim()); });
  Array.prototype.forEach.call(document.querySelectorAll('.ask-chip'), function (b) {
    b.addEventListener('click', function () { ask(b.textContent.trim()); });
  });
})();

} catch (e) { console.error('oracle script part 3', e); }
/* ---- part 4 of 4 (was inline script 4) ---- */
try {

  /* Collapsible sections (17 Sep 2026). The 52-week graphs size themselves to the
     tile's real width, which is 0 while the section is collapsed — redraw on expand.
     The main script redraws on window resize, so a resize event is all that is needed. */
  (function () {
    const d = document.getElementById('sec-drivers');
    if (!d) return;
    d.addEventListener('toggle', function () { if (d.open) window.dispatchEvent(new Event('resize')); });
  })();

} catch (e) { console.error('oracle script part 4', e); }
