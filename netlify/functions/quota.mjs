// netlify/functions/quota.mjs
//
// EU duty-free urea quota tracker — Netlify Scheduled Function (9 Sep 2026).
//
// Council Regulation (EU) 2026/1181 opened a duty-free tariff quota of
// 890,000 t of urea (CN 3102 10 12/15/19/90, all origins except Russia and
// Belarus) for 30 May 2026 – 31 May 2027, order number 09.0173. It is used on
// a first-come, first-served basis and the Commission publishes the running
// balance in its QUOTA database. The Oracle dashboard shows that balance; this
// function keeps it current.
//
// Twice a day (the Commission allocates once per working day, mid-morning):
//   1. fetch the quota details page from the Commission's QUOTA database
//   2. parse initial amount, balance, awaiting allocation, dates, critical flag
//   3. read site/quota.json from the repo, append today's balance to its
//      history if it changed, and commit the new file via the GitHub Contents
//      API — Netlify then deploys as usual and the page fetches /quota.json
//
// Nothing is committed when nothing changed. The dashboard falls back to the
// snapshot embedded in its own JSON block if this file is missing or stale.
//
// Env (Netlify → Site configuration → Environment variables):
//   GITHUB_TOKEN     required — same fine-grained PAT the publisher uses
//   GITHUB_REPO      default borasamman/urea-oracle-dashboard
//   GITHUB_BRANCH    default main
//   QUOTA_ORDER      default 090173
//   QUOTA_START      default 2026-05-30 (the quota period's start date)

const REPO     = process.env.GITHUB_REPO   || 'borasamman/urea-oracle-dashboard';
const BRANCH   = process.env.GITHUB_BRANCH || 'main';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const ORDER    = process.env.QUOTA_ORDER   || '090173';
const START    = process.env.QUOTA_START   || '2026-05-30';

const TARGET = 'site/quota.json';
const UA     = 'oracle-quota/1.0 (netlify scheduled function)';
const SRC    = `https://ec.europa.eu/taxation_customs/dds2/taric/quota_tariff_details.jsp?Lang=en&StartDate=${START}&Code=${ORDER}`;

// ------------------------------------------------------------------ parsing

// The details page is one two-column table: <td class="label">Balance</td>
// followed by a value cell. Grab the value cell's text for a given label.
function field(html, label) {
  const re = new RegExp(
    `<td class="label"[^>]*>\\s*${label}[\\s\\S]*?</td>\\s*(?:<!--[\\s\\S]*?-->\\s*)*<td[^>]*>([\\s\\S]*?)</td>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const kgToT = s => {
  const m = /([\d.]+)/.exec(s || '');
  return m ? Math.round(parseFloat(m[1]) / 1000 * 10) / 10 : null;   // tonnes, 1 decimal
};
// "08-09-2026" -> "2026-09-08"
const isoDate = s => {
  const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

export function parseQuota(html) {
  const validity = field(html, 'Validity period') || '';
  const dates = validity.match(/\d{2}-\d{2}-\d{4}/g) || [];
  const initial = kgToT(field(html, 'Initial amount'));
  const balance = kgToT(field(html, 'Balance'));
  if (initial == null || balance == null) throw new Error('could not parse initial amount / balance');
  const lastUpd = /Last TARIC update:\s*(?:&nbsp;)?\s*(\d{2}-\d{2}-\d{4})/i.exec(html);
  return {
    order: field(html, 'Order number') || ORDER,
    origin: field(html, 'Origin') || 'ERGA OMNES',
    start: isoDate(dates[0]) || START,
    end: isoDate(dates[1]),
    initial_t: initial,
    balance_t: balance,
    used_t: Math.round((initial - balance) * 10) / 10,
    awaiting_t: kgToT(field(html, 'Total awaiting allocation')) || 0,
    critical: /^yes$/i.test(field(html, 'Critical') || ''),
    exhaustion_date: isoDate(field(html, 'Exhaustion date')),
    last_import: isoDate(field(html, 'Last import date')),
    last_allocation: isoDate(field(html, 'Last allocation date')),
    source_update: lastUpd ? isoDate(lastUpd[1]) : null,
    source: SRC
  };
}

// ------------------------------------------------------------------ github

async function gh(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(init.headers || {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function readTarget() {
  try {
    const j = await gh(`/repos/${REPO}/contents/${TARGET}?ref=${BRANCH}`);
    return { sha: j.sha, json: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
  } catch (e) {
    if (String(e.message).includes('-> 404')) return { sha: null, json: null };
    throw e;
  }
}

async function commit(json, sha, message) {
  return gh(`/repos/${REPO}/contents/${TARGET}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(json, null, 1), 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'oracle-quota[bot]', email: 'oracle-quota@users.noreply.github.com' }
    })
  });
}

// -------------------------------------------------------------------- main

export default async () => {
  if (!GH_TOKEN) {
    console.error('[quota] GITHUB_TOKEN is not set');
    return new Response('missing GITHUB_TOKEN', { status: 500 });
  }

  let html;
  try {
    const r = await fetch(SRC, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    html = await r.text();
  } catch (e) {
    console.error('[quota] could not fetch the Commission QUOTA page:', e.message);
    return new Response('fetch failed', { status: 502 });
  }

  let q;
  try { q = parseQuota(html); }
  catch (e) {
    console.error('[quota] parse failed:', e.message);
    return new Response('parse failed', { status: 502 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const { sha, json: prev } = await readTarget();
  const history = (prev && Array.isArray(prev.history)) ? prev.history.slice() : [];
  const pointDate = q.last_allocation || q.source_update || today;

  // one point per allocation date; overwrite if the same date is re-read
  const i = history.findIndex(p => p[0] === pointDate);
  if (i >= 0) history[i] = [pointDate, q.balance_t]; else history.push([pointDate, q.balance_t]);
  history.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const next = { ...q, fetched: today, history };

  const unchanged = prev && prev.balance_t === q.balance_t && prev.awaiting_t === q.awaiting_t &&
    prev.last_allocation === q.last_allocation && prev.critical === q.critical &&
    prev.exhaustion_date === q.exhaustion_date && JSON.stringify(prev.history) === JSON.stringify(history);
  if (unchanged) {
    console.log(`[quota] no change — balance ${q.balance_t} t as of ${q.last_allocation}`);
    return new Response(JSON.stringify({ ok: true, changed: false, balance_t: q.balance_t }), {
      headers: { 'content-type': 'application/json' }
    });
  }

  await commit(next, sha, `[oracle-quota] ${pointDate}: balance ${q.balance_t} t of ${q.initial_t} t (used ${q.used_t} t)`);
  console.log(`[quota] committed ${TARGET}: balance ${q.balance_t} t, used ${q.used_t} t, allocation ${q.last_allocation}`);
  return new Response(JSON.stringify({ ok: true, changed: true, balance_t: q.balance_t }), {
    headers: { 'content-type': 'application/json' }
  });
};

// 06:30 and 11:30 UTC every day: the Commission's daily allocation lands
// mid-morning Brussels time, so the second run catches it the same day and the
// first catches anything posted late the previous day.
export const config = { schedule: '30 6,11 * * *' };
