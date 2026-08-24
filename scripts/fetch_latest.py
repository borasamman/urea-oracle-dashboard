#!/usr/bin/env python3
"""Fetch the newest Urea Oracle dashboard HTML from the public Google Drive
folder, stamp the "Updated ..." chip, and write it to site/index.html.

v2 (14 Aug 2026):
  * --peek  : print the winning Drive file name and exit (no download, no
              write). Used by the workflow to decide whether an off-schedule
              edition needs publishing.
  * same-date edition ranking (lowest to highest priority):
        -watchdog  <  (no suffix)  <  -noon  <  named special  <  -eHHMM
    where -eHHMM is a timed edition (e.g. -e1935) and the highest HHMM wins.
  * chip snaps to 13:00 or 19:00 inside the two scheduled publish windows.

Outputs (appended to $GITHUB_ENV):
  ORACLE_CHANGED = 0/1   site/index.html was modified
  ORACLE_STALE   = 0/1   newest Drive content is NOT dated today (Paris)
  ORACLE_ASOF    = YYYY-MM-DD of the content used
  ORACLE_CHIP    = the exact "updated" string stamped into the page
  ORACLE_SRC     = Drive file name used
Exit codes: 0 = ok (even if stale - the workflow decides how loud to be),
            2 = hard failure (listing unreachable/unparseable, download failed).
"""
import datetime
import os
import re
import sys
import urllib.request
from zoneinfo import ZoneInfo

FOLDER_ID = "1ZUOfloc_TELKDQMpabLJky60KZPNgcBr"  # "Urea Oracle Site"
LISTING_URL = f"https://drive.google.com/embeddedfolderview?id={FOLDER_ID}#list"
NAME_RE = re.compile(
    r"urea-oracle-dashboard-(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9]+))?\.html$"
)
TIMED_RE = re.compile(r"^e([0-2]\d[0-5]\d)$")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) oracle-publisher/2.0"}
PARIS = ZoneInfo("Europe/Paris")
PEEK = "--peek" in sys.argv[1:]

# The Weekly Digest (Dreymoor Central Intelligence) moved from Google Apps Script to
# Netlify on 24 Aug 2026. The dashboard template still carries the old URL, so the
# publisher rewrites it on every edition.
OLD_DIGEST_URL = "https://script.google.com/macros/s/AKfycbxOw2wzVhgvqkATmR9Pz4ItWHxb7d-CLZmylZtH5913pMvuSUP8lT5eZ8sqqKsGdMjF/exec"
DIGEST_URL = "https://dreymoor-fertilizer.netlify.app"


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def die(msg):
    if PEEK:
        # A peek must never break the workflow; the caller treats empty
        # output as "no information, skip quietly".
        print(f"::warning::{msg}", file=sys.stderr)
        sys.exit(0)
    print(f"::error::{msg}")
    sys.exit(2)


def list_folder():
    try:
        html = fetch(LISTING_URL).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        die(f"DRIVE LISTING FETCH FAILED: {e!r}")
    entries = []
    # Primary parse: entry blocks in the embedded folder view.
    for block in re.split(r'flip-entry(?:")', html)[1:]:
        m_id = re.search(r"/file/d/([-\w]{20,})", block)
        m_name = re.search(r'flip-entry-title">([^<]+)<', block)
        if m_id and m_name:
            entries.append((m_id.group(1), m_name.group(1).strip()))
    if not entries:
        # Secondary parse: pair every file id with the nearest following title.
        pat = re.compile(
            r"/file/d/([-\w]{20,})[\s\S]{0,3000}?>([^<>]*urea-oracle-dashboard-"
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}[^<>\"]*?\.html)<"
        )
        entries = [(i, n.strip()) for i, n in pat.findall(html)]
    # De-duplicate keeping first occurrence.
    seen, uniq = set(), []
    for fid, name in entries:
        if (fid, name) not in seen:
            seen.add((fid, name))
            uniq.append((fid, name))
    return uniq


def rank(suffix):
    """Same-date ordering key: higher tuple wins."""
    s = (suffix or "").lower()
    if s == "watchdog":
        return (0, 0)
    if s == "":
        return (1, 0)
    if s == "noon":
        return (2, 0)
    m = TIMED_RE.match(s)
    if m:
        return (4, int(m.group(1)))  # timed edition; latest HHMM wins
    return (3, 0)  # named special: evening, night, fix2, ...


def pick(entries):
    best = None
    for fid, name in entries:
        m = NAME_RE.search(name)
        if not m:
            continue
        date, suffix = m.group(1), m.group(2)
        key = (date,) + rank(suffix)
        if best is None or key > best[0]:
            best = (key, fid, name, date)
    if best is None:
        die(
            "NO DASHBOARD FILE FOUND in Drive folder listing "
            f"({len(entries)} entries seen). Folder or naming may have changed."
        )
    return best[1], best[2], best[3]


def download(fid, name):
    urls = [
        f"https://drive.usercontent.google.com/download?id={fid}&export=download",
        f"https://drive.google.com/uc?export=download&id={fid}",
    ]
    last = None
    for url in urls:
        try:
            body = fetch(url).decode("utf-8", "replace")
            if "oracle-data" in body and "</html>" in body:
                return body
            last = f"content sanity check failed for {url} (len={len(body)})"
        except Exception as e:  # noqa: BLE001
            last = f"{url} -> {e!r}"
    die(f"DOWNLOAD FAILED for {name} ({fid}): {last}")


def publish_chip(now):
    """13:00 / 19:00 inside the scheduled windows, real clock time otherwise."""
    mins = now.hour * 60 + now.minute
    for target in (13 * 60, 19 * 60):
        if target - 5 <= mins <= target + 5:
            return f"{target // 60:02d}:00"
    return now.strftime("%H:%M")


def main():
    entries = list_folder()
    fid, name, file_date = pick(entries)
    if PEEK:
        print(name)
        return
    print(f"Newest dashboard in Drive: {name} ({fid})")
    html = download(fid, name)
    html = html.replace(OLD_DIGEST_URL, DIGEST_URL)

    m = re.search(r'"asof"\s*:\s*"(\d{4}-\d{2}-\d{2})"', html)
    asof = m.group(1) if m else file_date
    now = datetime.datetime.now(PARIS)
    today = now.strftime("%Y-%m-%d")
    stale = asof != today

    chip = ""
    if not stale:
        chip = f"{now.strftime('%b')} {now.day} at {publish_chip(now)} Paris time"
        html, n = re.subn(
            r'("updated"\s*:\s*")[^"]*(")', rf"\g<1>{chip}\g<2>", html, count=1
        )
        if n != 1:
            print("::warning::could not stamp the updated chip (pattern miss)")
            chip = ""
    else:
        print(
            f"::warning::Newest Drive content is dated {asof}, not {today} - "
            "content pipeline did not produce today's edition."
        )

    target = os.path.join("site", "index.html")
    old = ""
    if os.path.exists(target):
        with open(target, encoding="utf-8") as f:
            old = f.read()
    changed = old != html
    if changed:
        os.makedirs("site", exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            f.write(html)

    env = os.environ.get("GITHUB_ENV")
    if env:
        with open(env, "a", encoding="utf-8") as f:
            f.write(f"ORACLE_CHANGED={int(changed)}\n")
            f.write(f"ORACLE_STALE={int(stale)}\n")
            f.write(f"ORACLE_ASOF={asof}\n")
            f.write(f"ORACLE_CHIP={chip}\n")
            f.write(f"ORACLE_SRC={name}\n")
    print(f"asof={asof} stale={stale} changed={changed} chip='{chip}'")


if __name__ == "__main__":
    main()
