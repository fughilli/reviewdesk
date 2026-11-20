#!/usr/bin/env python3
"""Fill a Review Desk with generic example items, to try the UI or take screenshots.

    RD_DATA_DIR=/tmp/rd-demo RD_PR_URL_BASE=https://github.com/example/webapp/pull/ ./server.py &
    RD_URL=http://127.0.0.1:8471 scripts/seed_demo.py

Use an empty, throwaway desk: the script only adds items. Everything is made up.
"""
import json
import os
import struct
import sys
import urllib.parse
import urllib.request
import zlib
from datetime import date, timedelta

BASE = os.environ.get("RD_URL", "http://127.0.0.1:8471").rstrip("/")


def call(method, path, body=None, raw=None):
    data, headers = None, {}
    if body is not None:
        data, headers = json.dumps(body).encode(), {"Content-Type": "application/json"}
    elif raw is not None:
        data, headers = raw, {"Content-Type": "application/octet-stream"}
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def bar_chart(values, w=720, h=360, color=(70, 110, 200)):
    """A plain bar chart as a PNG (no dependencies): light grid, one bar per value."""
    px = [[(255, 255, 255)] * w for _ in range(h)]
    top, bottom, left, right = 24, h - 30, 40, w - 20
    for gy in range(top, bottom + 1, (bottom - top) // 4):
        for x in range(left, right):
            px[gy][x] = (225, 228, 235)
    vmax = max(values) * 1.1
    slot = (right - left) / len(values)
    for i, v in enumerate(values):
        x0, x1 = int(left + i * slot + slot * 0.18), int(left + (i + 1) * slot - slot * 0.18)
        y0 = int(bottom - (bottom - top) * v / vmax)
        shade = tuple(min(255, c + (25 if i % 2 else 0)) for c in color)
        for y in range(y0, bottom):
            for x in range(x0, x1):
                px[y][x] = shade
    for x in range(left, right):
        px[bottom][x] = (120, 125, 140)
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def new(**kw):
    kw.setdefault("priority", "soon")
    return call("POST", "/api/items", kw)["id"]


def comment(iid, body, author="assistant"):
    call("POST", f"/api/items/{iid}/comments", {"body": body, "author": author})


def attach_png(iid, name, png, label=""):
    q = urllib.parse.urlencode({"filename": name, "label": label})
    call("POST", f"/api/items/{iid}/attachments?{q}", raw=png)


def main():
    if call("GET", "/api/items?status=all")["items"]:
        sys.exit("seed_demo: this desk already has items; point RD_URL at an empty one")
    today = date.today()

    pag = new(title="API: pick the pagination style for /v2/search", project="api", priority="blocking",
              body="Search results are unbounded today. Clients need stable paging before the 2.4 release.\n\n"
                   "| | Cursor | Offset |\n|---|---|---|\n| Stable under inserts | yes | no |\n"
                   "| Jump to page N | no | yes |\n| p95 at page 50 | 41 ms | 380 ms |\n\n"
                   "Benchmarks on the staging dataset are attached. Draft PR: #412.",
              options=[{"label": "Cursor-based", "description": "Opaque `next` token; what most clients need.",
                        "recommended": True},
                       {"label": "Offset + limit", "description": "Simple, but slow and unstable on deep pages."},
                       {"label": "Both", "description": "Cursor by default, offset for admin tools only."}])
    attach_png(pag, "p95-latency-by-page.png", bar_chart([12, 14, 19, 41, 88, 160, 380]),
               "p95 latency by page depth (offset)")
    attach_png(pag, "p95-cursor.png", bar_chart([11, 12, 12, 13, 13, 14, 15], color=(60, 160, 110)),
               "p95 latency by page depth (cursor)")
    comment(pag, "I can have either version ready for review tomorrow. Cursor tokens would be "
                 "base64 JSON, so no schema change.")

    rel = new(title="Release 2.4: ship Thursday or wait for the migration fix?", project="release",
              body="One known issue: the settings migration is slow on accounts with more than 10k "
                   "projects (about 2 % of users). A fix is in review. Pagination (D-1) has to land first.",
              options=[{"label": "Ship Thursday", "description": "Note the slow migration in the release notes.",
                        "recommended": True},
                       {"label": "Wait a week for the fix"}],
              blocked_by=[pag])

    new(title="CI: which runner upgrades are worth paying for?", project="infra", multi=True,
        body="The test job takes 14 minutes on the median PR. Pick any that apply; the estimated monthly "
             "costs are in the descriptions.",
        options=[{"label": "Larger runners for the test job", "description": "About 6 minutes saved, +$120/month",
                  "recommended": True},
                 {"label": "Dependency cache on a persistent volume", "description": "About 3 minutes saved, +$15/month",
                  "recommended": True},
                 {"label": "Split the end-to-end suite into four shards", "description": "About 5 minutes saved, no cost"}])

    new(kind="todo", title="Approve the staging cloud budget increase", project="infra", priority="blocking",
        due=(today + timedelta(days=2)).isoformat(),
        body="The load tests for D-1 need a bigger database for two days. The request is waiting in the "
             "billing console.")
    new(kind="todo", title="Review the draft privacy notice", project="docs", priority="soon",
        due=(today - timedelta(days=1)).isoformat(), body="Legal asked for an owner sign-off before it goes live.")
    new(kind="todo", title="Try the new onboarding flow on a phone", project="docs", priority="whenever")

    ws = call("POST", "/api/requests", {"title": "Docs: write the upgrade guide for 2.4", "project": "docs",
                                         "priority": "soon",
                                         "body": "Cover the new pagination, the settings migration and the "
                                                 "removed v1 endpoints. Blocks the release.",
                                         "blocks": [rel]})["id"]
    call("POST", f"/api/items/{ws}/claim", {"comment": "Taking this. Outline first, then a draft PR."})
    comment(ws, "Outline is up in #415. Two questions in the PR description.")

    gen = new(title="Docs: which static site generator?", project="docs",
              options=[{"label": "Keep the current one", "recommended": True}, {"label": "Switch to a new one"}])
    call("POST", f"/api/items/{gen}/answer", {"choices": ["o1"], "text": "Keep it. Revisit after 2.4."})
    comment(gen, "Thanks. I'll pin the version and close this.")

    old = new(title="API: rename the `owner_id` field?", project="api", priority="whenever",
              options=[{"label": "Keep the name", "recommended": True}, {"label": "Rename to account_id"}])
    call("POST", f"/api/items/{old}/answer", {"choices": ["o1"], "text": ""})
    call("POST", f"/api/items/{old}/close", {"comment": "Kept as is."})

    n = len(call("GET", "/api/items?status=all")["items"])
    print(f"seed_demo: created {n} items on {BASE}")


if __name__ == "__main__":
    main()
