// netlify/functions/publish.mjs
//
// Urea Oracle publisher — Netlify Scheduled Function.
// Replaces the GitHub Actions cron (best-effort, documented to skip most slots)
// and the Drive folder-page scrape.
//
// Every 5 minutes:
//   1. list the "Urea Oracle Site" Drive folder (Drive API; scrape only as fallback)
//   2. pick the highest-ranked edition that is ELIGIBLE — i.e. whose publish_at
//      has passed, or which carries no publish_at at all (legacy files)
//   3. if its content differs from site/index.html, stamp the "Updated" chip and
//      commit it via the GitHub Contents API — Netlify then deploys as usual
//   4. if a scheduled edition is overdue and today's content never arrived, open
//      a GitHub issue (which emails the repo owner) — once, not every 5 minutes
//
// Nothing sleeps, nothing waits for an exact second. An edition uploaded at 12:25
// stamped publish_at 12:59 simply becomes eligible at 12:59 and goes live on the
// next tick. An edition uploaded late goes live on the next tick after it lands.
//
// Env (Netlify → Site configuration → Environment variables):
//   GITHUB_TOKEN     required — fine-grained PAT, Contents: read/write
//   GITHUB_REPO      default borasamman/urea-oracle-dashboard
//   GITHUB_BRANCH    default main
//   DRIVE_FOLDER_ID  default 1ZUOfloc_TELKDQMpabLJky60KZPNgcBr
//   DRIVE_API_KEY    optional — without it the function falls back to scraping
//   DRY_RUN          optional — "1" logs what it would do and commits nothing

const FOLDER_ID = process.env.DRIVE_FOLDER_ID || '1ZUOfloc_TELKDQMpabLJky60KZPNgcBr';
const REPO      = process.env.GITHUB_REPO     || 'borasamman/urea-oracle-dashboard';
const BRANCH    = process.env.GITHUB_BRANCH   || 'main';
const GH_TOKEN  = process.env.GITHUB_TOKEN;
const DRIVE_KEY = process.env.DRIVE_API_KEY;
const DRY_RUN   = process.env.DRY_RUN === '1';

const TARGET   = 'site/index.html';
const PARIS    = 'Europe/Paris';
const NAME_RE  = /^urea-oracle-dashboard-(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9]+))?\.html$/;
const TIMED_RE = /^e([0-2]\d[0-5]\d)$/;
const UA       = 'oracle-publisher/3.0 (netlify scheduled function)';

// Publish moments, Paris local time, weekdays only.
const SLOTS = [{ hh: 12, mm: 59, label: 'midday' }, { hh: 18, mm: 59, label: 'evening' }];
const GRACE_MIN = 6;   // how late a slot may be before we call it overdue

// ---------------------------------------------------------------- time helpers

function parisParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hh: Number(p.hour), mm: Number(p.minute),
    weekday: p.weekday,                       // Mon, Tue, ...
    isWeekday: !['Sat', 'Sun'].includes(p.weekday)
  };
}

// "Aug 19 at 12:59 Paris time"
function chipFor(d) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: PARIS, month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.month} ${p.day} at ${p.hour}:${p.minute} Paris time`;
}

// Legacy files carry no publish_at: keep the old behaviour of snapping the chip
// to 13:00 / 19:00 when we are within a few minutes of a slot.
function legacyChip(now) {
  const { hh, mm } = parisParts(now);
  const mins = hh * 60 + mm;
  for (const t of [13 * 60, 19 * 60]) {
    if (Math.abs(mins - t) <= 5) {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: PARIS, month: 'short', day: 'numeric' });
      const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
      return `${p.month} ${p.day} at ${String(t / 60 | 0).padStart(2, '0')}:00 Paris time`;
    }
  }
  return chipFor(now);
}

// --------------------------------------------------------------- drive reading

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0]}`);
  return r.text();
}

// Preferred: the real Drive API. Needs DRIVE_API_KEY and a link-shared folder.
async function listViaApi() {
  if (!DRIVE_KEY) return null;
  const q = encodeURIComponent(`'${FOLDER_ID}' in parents and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}`
            + `&fields=files(id,name,createdTime)&pageSize=200&key=${DRIVE_KEY}`;
  const body = await fetchText(url);
  const files = JSON.parse(body).files || [];
  return files.map(f => ({ id: f.id, name: f.name, created: f.createdTime }));
}

// Fallback: the folder-page scrape the old publisher relied on. Kept ONLY as a
// backstop — if this is the path being used, the log says so loudly.
async function listViaScrape() {
  const html = await fetchText(`https://drive.google.com/embeddedfolderview?id=${FOLDER_ID}#list`);
  const out = [];
  for (const block of html.split(/flip-entry(?:")/).slice(1)) {
    const id = block.match(/\/file\/d\/([-\w]{20,})/);
    const nm = block.match(/flip-entry-title">([^<]+)</);
    if (id && nm) out.push({ id: id[1], name: nm[1].trim(), created: null });
  }
  return out;
}

async function listFolder() {
  try {
    const viaApi = await listViaApi();
    if (viaApi && viaApi.length) return { files: viaApi, source: 'drive-api' };
    if (viaApi) console.warn('[oracle] Drive API returned an empty folder; trying scrape');
  } catch (e) {
    console.warn('[oracle] Drive API listing failed, falling back to scrape:', e.message);
  }
  const viaScrape = await listViaScrape();
  console.warn('[oracle] using the folder-page SCRAPE — set DRIVE_API_KEY to stop relying on it');
  return { files: viaScrape, source: 'scrape' };
}

async function download(id) {
  const urls = [
    `https://drive.usercontent.google.com/download?id=${id}&export=download`,
    `https://drive.google.com/uc?export=download&id=${id}`
  ];
  let last;
  for (const u of urls) {
    try {
      const body = await fetchText(u);
      if (body.includes('oracle-data') && body.includes('</html>')) return body;
      last = `sanity check failed (len=${body.length})`;
    } catch (e) { last = e.message; }
  }
  throw new Error(`download failed for ${id}: ${last}`);
}

// ------------------------------------------------------------------- selection

// Same-date ordering, unchanged from the old publisher so legacy files behave
// identically: watchdog < plain < noon < named special < -eHHMM (latest wins).
function rank(suffix) {
  const s = (suffix || '').toLowerCase();
  if (s === 'watchdog') return [0, 0];
  if (s === '')         return [1, 0];
  if (s === 'noon')     return [2, 0];
  const m = TIMED_RE.exec(s);
  if (m) return [4, Number(m[1])];
  return [3, 0];
}

function cmp(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const [ar, av] = rank(a.suffix), [br, bv] = rank(b.suffix);
  return ar !== br ? ar - br : av - bv;
}

const grab = (html, key) => {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(html);
  return m ? m[1] : null;
};

// The publish schedule, as a property of the content: an edition is eligible
// once its own publish_at has passed. Files without one are always eligible.
async function pickEligible(files, now, load = download) {
  const candidates = files
    .map(f => { const m = NAME_RE.exec(f.name); return m ? { ...f, date: m[1], suffix: m[2] || '' } : null; })
    .filter(Boolean)
    .sort(cmp)
    .reverse()
    .slice(0, 6);                       // newest few only; we download each one

  for (const c of candidates) {
    let html;
    try { html = await load(c.id); }
    catch (e) { console.warn(`[oracle] skipping ${c.name}: ${e.message}`); continue; }

    const publishAt = grab(html, 'publish_at');
    if (publishAt) {
      const t = Date.parse(publishAt);
      if (Number.isNaN(t)) {
        console.warn(`[oracle] ${c.name}: unparseable publish_at "${publishAt}" — treating as due`);
      } else if (t > now.getTime()) {
        console.log(`[oracle] ${c.name} is embargoed until ${publishAt}; looking further down`);
        continue;                        // not yet due — try the next-best edition
      }
    }
    return { ...c, html, publishAt };
  }
  return null;
}

// ------------------------------------------------------------------ github i/o

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
  if (!r.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function readTarget() {
  try {
    const j = await gh(`/repos/${REPO}/contents/${TARGET}?ref=${BRANCH}`);
    return { sha: j.sha, content: Buffer.from(j.content, 'base64').toString('utf8') };
  } catch (e) {
    if (String(e.message).includes('-> 404')) return { sha: null, content: '' };
    throw e;
  }
}

async function commit(html, sha, message) {
  return gh(`/repos/${REPO}/contents/${TARGET}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(html, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'oracle-publisher[bot]', email: 'oracle-publisher@users.noreply.github.com' }
    })
  });
}

// Does this edition actually satisfy THIS slot? Without the check, the evening
// slot would accept the midday edition as proof it published — the exact
// mistake the old evening watchdog was written to avoid.
function coversSlot(chosen, slotTime, slot) {
  if (!chosen) return false;
  if (chosen.publishAt) {
    const t = Date.parse(chosen.publishAt);
    if (!Number.isNaN(t)) return t >= slotTime.getTime() - 120_000;   // 2 min tolerance
  }
  // Legacy files carry no publish_at: fall back to the naming contract, where
  // only an -eHHMM file is an evening edition.
  return slot.label === 'evening'
    ? TIMED_RE.test((chosen.suffix || '').toLowerCase())
    : true;
}

// The alarm. A GitHub issue emails the repo owner, so this needs no extra
// service — and we dedupe on the title so it fires once per missed edition.
async function raiseStale(title, body) {
  if (DRY_RUN) { console.warn(`[oracle] DRY_RUN: would raise stale alarm — ${title}`); return; }
  const open = await gh(`/repos/${REPO}/issues?state=open&per_page=100`);
  if ((open || []).some(i => i.title === title)) {
    console.log(`[oracle] stale alarm already open: ${title}`);
    return;
  }
  await gh(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) });
  console.error(`[oracle] RAISED STALE ALARM: ${title}`);
}

// ----------------------------------------------------------------------- main

export default async () => {
  const now = new Date();
  const paris = parisParts(now);

  if (!GH_TOKEN) {
    console.error('[oracle] GITHUB_TOKEN is not set — cannot publish');
    return new Response('missing GITHUB_TOKEN', { status: 500 });
  }

  let listed;
  try { listed = await listFolder(); }
  catch (e) {
    console.error('[oracle] could not list the Drive folder at all:', e.message);
    return new Response('drive listing failed', { status: 502 });
  }

  const chosen = await pickEligible(listed.files, now);
  if (!chosen) {
    console.warn(`[oracle] no eligible edition (${listed.files.length} files seen via ${listed.source})`);
  }

  let published = false;

  if (chosen) {
    const asof = grab(chosen.html, 'asof') || chosen.date;
    const chip = chosen.publishAt ? chipFor(new Date(chosen.publishAt)) : legacyChip(now);

    let html = chosen.html;
    const stamped = html.replace(/("updated"\s*:\s*")[^"]*(")/, `$1${chip}$2`);
    if (stamped === html) console.warn('[oracle] could not stamp the updated chip (pattern miss)');
    else html = stamped;

    const target = await readTarget();
    if (target.content === html) {
      console.log(`[oracle] no change — site already serves ${chosen.name}`);
    } else if (DRY_RUN) {
      console.log(`[oracle] DRY_RUN: would publish ${chosen.name} (asof ${asof}, chip "${chip}")`);
    } else {
      await commit(html, target.sha, `[oracle-publish] ${asof} - ${chip} (${chosen.name})`);
      console.log(`[oracle] published ${chosen.name} (asof ${asof}, chip "${chip}") via ${listed.source}`);
      published = true;
    }
  }

  // Overdue check: on a weekday, a few minutes after a slot, today's edition
  // must be the one on the site. Never fires at the weekend, never on a slot
  // that has not yet arrived.
  if (paris.isWeekday) {
    const mins = paris.hh * 60 + paris.mm;
    for (const slot of SLOTS) {
      const slotMins = slot.hh * 60 + slot.mm;
      if (mins < slotMins + GRACE_MIN || mins > slotMins + 60) continue;  // outside the check window
      const slotTime = new Date(now.getTime() + (slotMins - mins) * 60_000);
      const liveAsof = chosen ? (grab(chosen.html, 'asof') || chosen.date) : null;
      if (liveAsof !== paris.date || !coversSlot(chosen, slotTime, slot)) {
        await raiseStale(
          `Oracle publish STALE — ${paris.date} ${slot.label}`,
          `The ${slot.label} edition for ${paris.date} did not reach the publisher.\n\n` +
          `- Newest eligible edition: ${chosen ? chosen.name : 'none'}\n` +
          `- Its asof: ${liveAsof || 'n/a'}\n` +
          `- Its publish_at: ${chosen && chosen.publishAt ? chosen.publishAt : 'none (legacy file)'}\n` +
          `- Covers the ${slot.label} slot: no\n` +
          `- Expected asof: ${paris.date}\n` +
          `- Drive listing source: ${listed.source}\n` +
          `- Files seen in folder: ${listed.files.length}\n\n` +
          `The site is still serving the previous edition — nothing was taken down. ` +
          `Fix: get today's HTML into the Drive folder; the next 5-minute tick publishes it.`
        );
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, published, source: listed.source }), {
    headers: { 'content-type': 'application/json' }
  });
};

export const config = { schedule: '*/5 * * * *' };
