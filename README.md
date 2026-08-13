# Dreymoor Urea Oracle — dashboard publisher

Public dashboard: **https://ferts.netlify.app** (redirects to the Netlify deploy target).

## How this repo works (fully automatic)

1. Every weekday, a Claude scheduled task analyses the urea market and uploads the
   finished dashboard HTML to the public Google Drive folder **"Urea Oracle Site"**
   (`1ZUOfloc_TELKDQMpabLJky60KZPNgcBr`) as `urea-oracle-dashboard-YYYY-MM-DD[-suffix].html`.
2. The GitHub Actions workflow [`publish.yml`](.github/workflows/publish.yml) wakes up
   before 13:00 Paris time (DST-proof), sleeps until **12:59 Paris**, fetches the newest
   dashboard file from that Drive folder, stamps the "Updated …" chip, and commits it to
   `site/index.html`.
3. Netlify is linked to this repo and auto-deploys `site/` on every push — the live site
   updates at ~13:00 Paris, every weekday, with no human involvement.

Two later cron slots act as catch-up/verification: if the 13:00 publish was missed
(GitHub delay, transient failure), the next slot publishes immediately.

## Failure behaviour

If the day's content is missing from Drive (the analysis task failed) or the deploy does
not go live, the workflow **fails loudly** — GitHub emails the repo owner. The live site
keeps serving the previous edition; nothing is ever taken down.

## Manual publish

Actions → "Publish Oracle dashboard" → Run workflow → set `force` to true.
This fetches the newest Drive file and deploys immediately.
