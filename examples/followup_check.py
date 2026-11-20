#!/usr/bin/env python3
"""Example: a follow-through check an orchestrator runs on every desk poll.

Decisions only help if someone acts on them. This script looks for answers
that were never carried out and work that has quietly stopped. It prints only
problems, one per line, each starting with a tag, and prints nothing when
everything is moving:

  QUEUE-STALLED  PRs are waiting in the merge queue file but no merge runner is running
  APPROVED-IDLE  an item's latest answer picked an "Approve ..." option naming a PR (#123),
                 and that PR is still open and not queued
  UNBLOCKED      an open item whose blockers are all finished now
  AGENT-STALE    an agent's status file has not changed for RD_STALE_MIN minutes

It is an example to adapt, not part of the desk. Every integration point is an
environment variable; leave one unset and that check is skipped.

  RD_URL                 desk URL (default http://127.0.0.1:8471)
  GITHUB_REPOSITORY      org/repo whose PRs the approvals name     [INTEGRATION: GitHub]
  GITHUB_TOKEN           token with read access to its pull requests
  RD_MERGE_QUEUE_FILE    text file, one queued PR number per line   [INTEGRATION: merge queue]
  RD_MERGE_QUEUE_DONE    optional file of PR numbers already handled
  RD_MERGE_RUNNER_MATCH  regex matched against `ps -eo args` to find the queue runner
  RD_AGENT_STATUS_FILES  file listing one agent status file path per line  [INTEGRATION: agents]
  RD_STALE_MIN           minutes before a status file counts as stale (default 75)
  RD_HOLD_FILE           optional "D-12 until=2026-01-31T06:00 reason" lines that mute an
                         item's problems until that UTC time (expired holds stop muting)
"""
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request

DESK = os.environ.get("RD_URL", "http://127.0.0.1:8471").rstrip("/")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
QUEUE_FILE = os.environ.get("RD_MERGE_QUEUE_FILE", "")
QUEUE_DONE = os.environ.get("RD_MERGE_QUEUE_DONE", "")
RUNNER_MATCH = os.environ.get("RD_MERGE_RUNNER_MATCH", "")
STATUS_FILES = os.environ.get("RD_AGENT_STATUS_FILES", "")
STALE_MIN = float(os.environ.get("RD_STALE_MIN", "75"))
HOLD_FILE = os.environ.get("RD_HOLD_FILE", "")
PR_RE = re.compile(r"#(\d+)\b")


def get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"null")


def desk(path):
    return get_json(DESK + path)


_pr_cache = {}


def pr_state(n):
    """'open' / 'closed' for PR n, or None when GitHub is not configured or unreachable.
    [INTEGRATION: GitHub] Swap this for your forge's API if you don't use GitHub."""
    if not REPO:
        return None
    if n not in _pr_cache:
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "reviewdesk-followup-check"}
        if TOKEN:
            headers["Authorization"] = f"Bearer {TOKEN}"
        try:
            _pr_cache[n] = get_json(f"https://api.github.com/repos/{REPO}/pulls/{n}", headers).get("state")
        except (urllib.error.URLError, ValueError):
            _pr_cache[n] = None
    return _pr_cache[n]


def lines(path):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]


def queued_open_prs():
    """[INTEGRATION: merge queue] PR numbers in the queue file that are not done and still open."""
    done = set(lines(QUEUE_DONE))
    out = []
    for n in dict.fromkeys(x for x in lines(QUEUE_FILE) if x.isdigit()):
        if n not in done and pr_state(int(n)) in ("open", None):
            out.append(int(n))
    return out


def runner_alive():
    if not RUNNER_MATCH:
        return True  # not configured: assume it is
    ps = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
    me = str(os.getpid())
    return any(re.search(RUNNER_MATCH, ln) and me not in ln for ln in ps.splitlines()[1:])


def main():
    probs = []
    pending = queued_open_prs()
    if pending and not runner_alive():
        probs.append(f"QUEUE-STALLED queued PRs {pending} but the merge runner is not running")

    for summary in desk("/api/items?status=active")["items"]:
        it = desk(f"/api/items/{summary['id']}")
        iid = it["id"]
        answers = it.get("answers") or []
        if REPO and answers and not it.get("open_blockers"):  # waiting on a blocker is not idle
            labels = {o["key"]: o["label"] for o in it.get("options") or []}
            picked = [labels.get(k, "") for k in answers[-1].get("choices") or []]
            if any(lbl.lower().startswith("approve") for lbl in picked):
                for n in sorted({int(x) for x in PR_RE.findall(" ".join(picked) + " " + it["title"])}):
                    if pr_state(n) == "open" and n not in pending:
                        probs.append(f"APPROVED-IDLE D-{iid} approves #{n}, which is still open and not queued")
        title_prs = {int(x) for x in PR_RE.findall(it["title"])}
        if it.get("blocked_by") and not it.get("open_blockers") and not (title_prs & set(pending)):
            probs.append(f"UNBLOCKED D-{iid} {it['title'][:60]}: all its blockers are finished")

    now = time.time()
    for path in lines(STATUS_FILES):
        if os.path.exists(path):
            age = (now - os.path.getmtime(path)) / 60
            if age > STALE_MIN:
                probs.append(f"AGENT-STALE {path} unchanged for {age:.0f} min")

    nowiso = time.strftime("%Y-%m-%dT%H:%M", time.gmtime())
    held = set()
    for ln in lines(HOLD_FILE):
        m = re.match(r"(D-\d+)\s+until=(\S+)", ln)
        if m and m.group(2) > nowiso:
            held.add(m.group(1))
    probs = [p for p in probs if p.split()[1] not in held]
    if probs:
        print("\n".join(probs))


if __name__ == "__main__":
    main()
