#!/usr/bin/env python3
"""End-to-end smoke test for Review Desk.

Starts its own server on a free port with a throwaway data directory, then:
creates items through the rd CLI (options, PNG, link, HTML and Markdown files),
answers and comments as the owner through the browser endpoints, reads them back
with `rd changes`, checks upload sanitising and file headers, reference linking,
blocking links, workstream requests, the review queue and owner TODOs, and
deletes what it created. Stops the server at the end. Exit 0 = pass.

    python3 tests/smoke_test.py
"""

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RD = os.path.join(ROOT, "rd")
SERVER = os.path.join(ROOT, "server.py")
TMP = tempfile.mkdtemp(prefix="rd-smoke-")
DATA = os.path.join(TMP, "data")
BASE = ""
created = []

# Reference linking is off by default; the test turns every kind on.
REF_ENV = {
    "RD_PR_URL_BASE": "https://github.com/example/project/pull/",
    "RD_ISSUE_PREFIXES": "ABC",
    "RD_ISSUE_URL": "https://tracker.example.com/browse/{id}",
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_git_repo():
    """A throwaway repo with one commit, so commit hashes can be recognised. None without git."""
    if not shutil.which("git"):
        return None, None
    d = os.path.join(TMP, "repo")
    os.makedirs(d)
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    for cmd in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "first"]):
        subprocess.run(["git", "-C", d, *cmd], check=True, env=env, capture_output=True)
    sha = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True,
                         check=True).stdout.strip()
    return d, sha


GIT_REPO, GIT_SHA = make_git_repo()
if GIT_REPO:
    REF_ENV["RD_GIT_DIR"] = GIT_REPO


def start_server():
    global BASE
    port = free_port()
    BASE = f"http://127.0.0.1:{port}"
    env = dict(os.environ, RD_DATA_DIR=DATA, **REF_ENV)
    log = open(os.path.join(TMP, "server.log"), "w")
    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(port)], env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(BASE + "/healthz", timeout=1)
            break
        except OSError:
            if proc.poll() is not None:
                break
            time.sleep(0.1)
    else:
        proc.kill()
    if proc.poll() is not None:
        raise SystemExit("server did not start:\n" + open(os.path.join(TMP, "server.log")).read())
    os.environ["RD_URL"] = BASE  # for the rd subprocesses
    return proc


def rd(*args):
    r = subprocess.run([sys.executable, RD, *args], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"rd {' '.join(args)} failed: {r.stderr}")
    return r.stdout


def req(method, path, data=None, headers=None):
    rq = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(rq, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def multipart(fields, files):
    b = uuid.uuid4().hex
    out = []
    for k, v in fields:
        out.append(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, fn, data, ct in files:
        out.append(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\n"
                   f"Content-Type: {ct}\r\n\r\n".encode() + data + b"\r\n")
    out.append(f"--{b}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={b}"


def png(w=8, h=8):
    rows = b"".join(b"\x00" + b"".join(bytes([x * 32 % 256, y * 32 % 256, 160]) for x in range(w)) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ok:", msg)


def main():
    t0 = json.loads(req("GET", "/healthz")[2])["now"]
    tmp = os.path.join(TMP, "files")
    os.makedirs(tmp)
    p_png = os.path.join(tmp, "smoke chart.png")
    with open(p_png, "wb") as f:
        f.write(png())
    p_md = os.path.join(tmp, "notes.md")
    with open(p_md, "w") as f:
        f.write("# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n")
    p_html = os.path.join(tmp, "evil.html")
    with open(p_html, "w") as f:
        f.write("<script>alert(1)</script>")
    body = os.path.join(tmp, "body.md")
    with open(body, "w") as f:
        f.write("## Smoke\n\n- one\n- two\n\n<b>not html</b>\n")

    print("create item via rd")
    o = rd("new", "--title", "[smoke test] throwaway item", "--body-file", body, "--tag", "smoke",
           "--priority", "blocking", "--option", "Alpha|first choice|recommended",
           "--option", "Beta|second choice", "--attach", p_png,
           "--attach", "https://github.com/example/example/pull/1")
    iid = int(o.split()[1].lstrip("#"))
    created.append(iid)
    rd("attach", str(iid), p_md, "--label", "notes")
    rd("attach", str(iid), p_html)
    rd("comment", str(iid), "--body", "assistant follow-up")
    it = json.loads(rd("show", str(iid), "--json"))
    check(len(it["options"]) == 2 and it["options"][0]["recommended"], "options stored, first recommended")
    atts = {a["filename"] or a["kind"]: a for a in it["attachments"]}
    check("smoke_chart.png" in atts, "png filename sanitised to smoke_chart.png")
    check(any(a["kind"] == "link" for a in it["attachments"]), "link attachment present")

    print("file serving headers")
    st, h, data = req("GET", atts["smoke_chart.png"]["href"])
    check(st == 200 and h["Content-Type"] == "image/png" and data.startswith(b"\x89PNG"), "png served as image/png")
    check(h["Content-Disposition"].startswith("inline"), "png inline")
    check("sandbox" in h.get("Content-Security-Policy", ""), "files carry CSP sandbox")
    st, h, _ = req("GET", atts["evil.html"]["href"])
    check(h["Content-Disposition"].startswith("attachment"), "html served as download by default")
    st, h, _ = req("GET", atts["notes.md"]["href"])
    check(h["Content-Disposition"].startswith("attachment"), "md downloadable")
    st, h, _ = req("GET", atts["notes.md"]["href"] + "?mode=raw")
    check(h["Content-Type"].startswith("text/plain"), "md raw view is text/plain")

    print("pages")
    for path in ("/", f"/item/{iid}", "/static/app.js", "/static/md.js", "/static/app.css"):
        st, h, _ = req("GET", path)
        check(st == 200, f"GET {path} 200")

    print("owner answers + comments (browser endpoints)")
    st, _, _ = req("POST", f"/api/items/{iid}/answer", json.dumps({"choices": ["o1", "o2"]}).encode(),
                   {"Content-Type": "application/json"})
    check(st == 400, "single-select rejects two choices")
    data, ct = multipart([("choice", "o1"), ("text", "Go with alpha.")],
                         [("file", "../../etc/answer.txt", b"owner file", "text/plain")])
    st, _, b = req("POST", f"/api/items/{iid}/answer", data, {"Content-Type": ct})
    check(st == 201, "answer accepted")
    st, _, _ = req("POST", f"/api/items/{iid}/comments",
                   json.dumps({"body": "owner reply", "author": "owner"}).encode(),
                   {"Content-Type": "application/json"})
    check(st == 201, "owner comment accepted")
    st, _, b = req("GET", f"/api/items/{iid}?view=owner")
    it = json.loads(b)
    check(it["status"] == "answered", "status -> answered")
    check("prev_owner_seen" in it, "owner view reports the previous visit")
    it2 = json.loads(req("GET", f"/api/items/{iid}")[2])
    check(it2["owner_seen"] is not None, "owner_seen recorded by owner view")
    ans_file = [a for a in it["attachments"] if a["answer_id"]]
    check(ans_file and ans_file[0]["filename"] == "answer.txt", "answer file stored, path stripped")

    print("rd changes")
    ch = json.loads(rd("changes", "--since", t0))
    check(any(a["item_id"] == iid and a["choice_labels"] == ["Alpha"] and a["text"] == "Go with alpha."
              for a in ch["answers"]), "changes lists the answer with labels")
    check(any(c["item_id"] == iid and c["body"] == "owner reply" for c in ch["comments"]),
          "changes lists the owner comment (not the assistant one)")
    check(not any(c["body"] == "assistant follow-up" for c in ch["comments"]), "assistant comments excluded")
    ch2 = json.loads(rd("changes", "--since", ch["now"]))
    check(not ch2["answers"] and not ch2["comments"], "polling from 'now' returns nothing new")

    print("close / reopen")
    rd("close", str(iid), "--comment", "thanks")
    st, _, _ = req("POST", f"/api/items/{iid}/reopen", b"{}", {"Content-Type": "application/json"})
    ch3 = json.loads(rd("changes", "--since", ch["now"]))
    check(any(e["kind"] == "reopened" and e["item_id"] == iid for e in ch3["events"]), "owner reopen shows in changes")

    print("upload limit")
    big = b"\0" * (25 * 1024 * 1024 + 1)
    st, _, _ = req("POST", f"/api/items/{iid}/attachments?filename=big.bin", big)
    check(st == 413, "26 MB upload rejected with 413")

    print("xss in link url rejected")
    st, _, _ = req("POST", f"/api/items/{iid}/attachments",
                   json.dumps({"url": "javascript:alert(1)"}).encode(), {"Content-Type": "application/json"})
    check(st == 400, "javascript: link rejected")

    v2(iid, t0)


def jpost(path, obj):
    st, _, b = req("POST", path, json.dumps(obj).encode(), {"Content-Type": "application/json"})
    return st, json.loads(b or b"null")


def v2(iid, t0):
    """Projects, blocking links, reference linking, workstream requests."""
    print("reference scanning (pure function, with and without config)")
    import importlib.util

    def load_server(name, env):
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            spec = importlib.util.spec_from_file_location(name, SERVER)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
    text = ("D-3 desk #4 #569 example/project#570 ABC-71 `D-9` "
            "https://github.com/example/project/pull/571 https://tracker.example.com/browse/ABC-72 &#39;")
    srv = load_server("rdserver_on", dict(REF_ENV, RD_GIT_DIR=""))
    refs = srv.scan_refs(text)
    check({("item", "3"), ("item", "4"), ("pr", "569"), ("pr", "570"), ("pr", "571"),
           ("issue", "ABC-71"), ("issue", "ABC-72")} == refs,
          "scan_refs finds D-, desk #, #n, repo#n, issue ids, PR + issue URLs; skips code")
    off = load_server("rdserver_off", {k: "" for k in REF_ENV})
    check(off.scan_refs(text) == {("item", "3"), ("item", "4")},
          "with no RD_* reference config only desk items (D-n) are references")
    check(off.ref_url("pr", "5") is None, "no PR URL base -> no outbound PR link")

    print("projects + tag alias")
    it = json.loads(rd("show", str(iid), "--json"))
    check(it["project"] == "smoke" and it["tag"] == "smoke", "--tag sets project (alias)")
    o = rd("new", "--title", "[smoke test] blocker", "--project", "smoke2", "--priority", "soon")
    a = int(o.split()[1].lstrip("#"))
    created.append(a)
    o = rd("new", "--title", "[smoke test] blocked", "--project", "smoke2", "--blocked-by", f"D-{a}",
           "--body", f"Waits on D-{a} and desk #{iid}; see #569 and ABC-71." + (f" Fixed in {GIT_SHA[:10]}." if GIT_SHA else ""))
    b = int(o.split()[1].lstrip("#"))
    created.append(b)
    lst = json.loads(rd("list", "--project", "smoke2", "--json"))
    row = {x["id"]: x for x in lst["items"]}
    check(row[b]["open_blockers"] == [a] and row[b]["kind"] == "decision", "list: kind + open_blockers")
    check("D-%d" % b in rd("list", "--project", "smoke2"), "rd list prints D-ids and kind")

    print("blocking links")
    it = json.loads(rd("show", str(b), "--json"))
    check([x["id"] for x in it["blocked_by"]] == [a], "--blocked-by made the edge")
    rd("link", f"D-{b}", "blocks", str(iid))
    r = subprocess.run([sys.executable, RD, "link", str(iid), "blocks", str(a)], capture_output=True, text=True)
    check(r.returncode != 0 and "cycle" in r.stderr, "cycle rejected")
    st, _ = jpost("/api/links", {"src": a, "dst": a})
    check(st == 400, "self-link rejected")
    rd("unlink", f"D-{b}", "blocks", str(iid))
    it = json.loads(rd("show", str(iid), "--json"))
    check(not it["blocked_by"], "unlink removed the edge")
    rd("close", str(a))
    lst = json.loads(rd("list", "--project", "smoke2", "--status", "all", "--json"))
    check({x["id"]: x for x in lst["items"]}[b]["open_blockers"] == [], "closing the blocker unblocks")

    print("reference linking + backlinks")
    it = json.loads(rd("show", str(iid), "--json"))
    check(b in [x["id"] for x in it["mentioned_by"]], "desk #N in another item -> Mentioned by")
    it = json.loads(rd("show", str(b), "--json"))
    xr = {(x["type"], x["key"]) for x in it["xrefs"]}
    check(("pr", "569") in xr and ("issue", "ABC-71") in xr, "xrefs: PR + issue")
    check(str(iid) in it["ref_ctx"]["items"], "render context carries referenced item titles")
    ref = json.loads(rd("ref", "pr", "569"))
    check(b in [x["id"] for x in ref["items"]] and ref["url"].endswith("/pull/569"), "/api/refs/pr lists the item")
    ref = json.loads(rd("ref", "issue", "abc-71"))
    check(b in [x["id"] for x in ref["items"]] and ref["url"] == "https://tracker.example.com/browse/ABC-71",
          "/api/refs/issue lists the item, url from the RD_ISSUE_URL template")
    cfg = json.loads(req("GET", "/api/config")[2])
    check(cfg["pr_url_base"] == REF_ENV["RD_PR_URL_BASE"] and cfg["repo"] == "example/project"
          and cfg["issue_prefixes"] == ["ABC"], "/api/config exposes the reference settings")
    if GIT_SHA:
        check(("commit", GIT_SHA) in xr and it["ref_ctx"]["commits"].get(GIT_SHA[:10]) == GIT_SHA,
              "a short hash found in RD_GIT_DIR becomes a commit reference")
        ref = json.loads(rd("ref", "commit", GIT_SHA[:8]))
        check(b in [x["id"] for x in ref["items"]] and ref["url"].endswith("/commit/" + GIT_SHA),
              "/api/refs/commit resolves a short hash; GitHub commit URL derived from the PR base")
    else:
        print("  skip: git not installed, commit references not tested")
    rd("comment", str(a), "--body", f"Unblocks D-{b}.")
    it = json.loads(rd("show", str(b), "--json"))
    check(a in [x["id"] for x in it["mentioned_by"]], "comment text adds a backlink")
    for path in ("/projects", "/new", "/ref/pr/569", "/ref/issue/ABC-71", "/ref/commit/abcdef1"):
        st, _, _ = req("GET", path)
        check(st == 200, f"GET {path} 200")
    proj = json.loads(req("GET", "/api/projects")[2])["projects"]
    check(any(p["project"] == "smoke2" and p["counts"]["closed"] == 1 for p in proj), "projects rollup counts")

    print("workstream requests")
    data, ct = multipart([("title", "[smoke test] request"), ("project", "smoke2"), ("priority", "whenever"),
                          ("body", f"Please do X after D-{b}."), ("blocked_by", f"D-{b}")],
                         [("file", "spec.md", b"# spec", "text/markdown")])
    st, _, body = req("POST", "/api/requests", data, {"Content-Type": ct})
    w = json.loads(body)
    check(st == 201 and w["kind"] == "workstream" and w["author"] == "owner" and w["status"] == "requested",
          "owner request stored as kind=workstream, status=requested")
    created.append(w["id"])
    check(len(w["attachments"]) == 1 and w["open_blockers"] == [b], "request carries file + blocker")
    ch = json.loads(rd("changes", "--since", t0))
    check({"answers", "comments", "events", "now", "requests"} <= set(ch), "changes keeps old keys, adds requests")
    rq = [x for x in ch["requests"] if x["id"] == w["id"]]
    check(rq and rq[0]["project"] == "smoke2" and rq[0]["priority"] == "whenever" and rq[0]["blocked_by"] == [b],
          "changes.requests has id/title/project/body/priority/blocked_by")
    check(not any(e["item_id"] == w["id"] for e in ch["events"]), "request creation is not duplicated in events")
    r = subprocess.run([sys.executable, RD, "claim", str(b)], capture_output=True, text=True)
    check(r.returncode != 0, "claim refuses a decision item")
    rd("claim", f"D-{w['id']}", "--note", "on it")
    it = json.loads(rd("show", str(w["id"]), "--json"))
    check(it["status"] == "in_progress" and it["comments"][-1]["body"] == "on it", "claim -> in_progress + note")
    check("request" in rd("list", "--status", "requests"), "rd list --status requests shows it")
    rd("close", str(w["id"]))
    st, it = jpost(f"/api/items/{w['id']}/reopen", {})
    check(it["status"] == "requested", "owner reopen of a request -> requested")

    print("pasted images on comments / answers")
    t1 = json.loads(req("GET", "/healthz")[2])["now"]
    data, ct = multipart([("body", f"Screenshot for D-{b}"), ("author", "owner")],
                         [("file", "image.png", png(), "image/png"), ("file", "pasted-2.png", png(4, 4), "image/png")])
    st, _, body = req("POST", f"/api/items/{b}/comments", data, {"Content-Type": ct})
    c = json.loads(body)
    check(st == 201 and len(c["attachments"]) == 2 and all(x["comment_id"] == c["id"] for x in c["attachments"]),
          "multipart comment stores its images tied to the comment")
    data, ct = multipart([("author", "owner")], [("file", "only.png", png(), "image/png")])
    st, _, _ = req("POST", f"/api/items/{b}/comments", data, {"Content-Type": ct})
    check(st == 201, "image-only comment accepted")
    data, ct = multipart([("author", "owner")], [("file", f"f{i}.png", png(2, 2), "image/png") for i in range(21)])
    st, _, _ = req("POST", f"/api/items/{b}/comments", data, {"Content-Type": ct})
    check(st == 400, "more than 20 files in one message refused")
    ch = json.loads(rd("changes", "--since", t1))
    cm = [x for x in ch["comments"] if x["id"] == c["id"]]
    check(cm and [a["filename"] for a in cm[0]["attachments"]] == ["image.png", "pasted-2.png"]
          and all(a["href"].startswith("/files/") and os.path.isfile(a["path"]) for a in cm[0]["attachments"]),
          "rd changes: comment.attachments with href + local path")
    st, _, d = req("GET", cm[0]["attachments"][0]["href"])
    check(st == 200 and d.startswith(b"\x89PNG"), "comment image served")
    it = json.loads(rd("show", str(b), "--json"))
    check(len([x for x in it["comments"] if x["id"] == c["id"]][0]["attachments"]) == 2,
          "item JSON: comment carries its attachments")
    data, ct = multipart([("text", "two files")], [("file", "a.png", png(), "image/png"),
                                                   ("file", "b.txt", b"hi", "text/plain")])
    st, _, _ = req("POST", f"/api/items/{b}/answer", data, {"Content-Type": ct})
    it = json.loads(rd("show", str(b), "--json"))
    check(st == 201 and len([x for x in it["attachments"] if x["answer_id"]]) == 2, "answer keeps every file")

    queue_tests()


def queue_tests():
    """Review queue: membership, order, blockers, snooze, retract (undo)."""
    print("review queue")
    proj = "smokeq"
    mk = lambda title, **kw: jpost("/api/items", dict(title=title, project=proj, **kw))[1]  # noqa: E731
    a = mk("[smoke] q soon old", priority="soon", options=[{"label": "A", "recommended": True}, {"label": "B"}])
    created.append(a["id"])
    w = mk("[smoke] q whenever", priority="whenever")
    created.append(w["id"])
    bl = mk("[smoke] q blocking new", priority="blocking", options=[{"label": "X"}])
    created.append(bl["id"])
    held = mk("[smoke] q held", priority="blocking", blocked_by=[w["id"]])
    created.append(held["id"])
    q = json.loads(req("GET", f"/api/queue?project={proj}")[2])
    check([x["id"] for x in q["items"]] == [bl["id"], a["id"], w["id"]], "queue order: priority, then oldest")
    check([x["id"] for x in q["waiting"]] == [held["id"]], "item with an open blocker is in `waiting`, not the queue")
    check(all(x["reason"] == "answer" for x in q["items"]), "reason=answer for unanswered decisions")
    st, s1 = jpost(f"/api/items/{bl['id']}/snooze", {})
    q = json.loads(req("GET", f"/api/queue?project={proj}")[2])
    check(q["items"][-1]["id"] == bl["id"] and q["items"][-1]["snoozed_at"], "snoozed item moves to the back")
    jpost(f"/api/items/{a['id']}/snooze", {})
    q = json.loads(req("GET", f"/api/queue?project={proj}")[2])
    check([x["id"] for x in q["items"]][-2:] == [bl["id"], a["id"]], "snoozed items ordered by snooze time")
    jpost(f"/api/items/{a['id']}/snooze", {"snoozed_at": None})
    t0 = json.loads(req("GET", "/healthz")[2])["now"]
    st, ans = jpost(f"/api/items/{bl['id']}/answer", {"choices": ["o1"], "text": "go"})
    it = json.loads(rd("show", str(bl["id"]), "--json"))
    check(it["status"] == "answered" and it["snoozed_at"] is None, "answering clears the snooze")
    q = json.loads(req("GET", f"/api/queue?project={proj}")[2])
    check(bl["id"] not in [x["id"] for x in q["items"]], "answered item leaves the queue")
    st, it = jpost(f"/api/answers/{ans['id']}/retract", {"snoozed_at": s1["snoozed_at"]})
    check(st == 200 and it["status"] == "open" and not it["answers"] and it["snoozed_at"], "retract (undo) restores status + snooze")
    ch = json.loads(rd("changes", "--since", t0))
    check(not any(x["id"] == ans["id"] for x in ch["answers"]), "retracted answer is gone from rd changes")
    check(any(e["item_id"] == bl["id"] and e["kind"] == "retracted" for e in ch["events"]), "retraction reported as an event")
    check(not any(e["kind"] in ("snoozed", "answered") for e in ch["events"]), "snooze is not an event")
    st, c = jpost(f"/api/items/{w['id']}/comments", {"body": "note", "author": "owner"})
    st, _ = jpost(f"/api/comments/{c['id']}/retract", {})
    check(st == 200, "owner comment retract")
    st, c2 = jpost(f"/api/items/{w['id']}/comments", {"body": "asst", "author": "assistant"})
    st, _ = jpost(f"/api/comments/{c2['id']}/retract", {})
    check(st == 403, "assistant comments cannot be retracted by the owner endpoint")
    req("GET", f"/api/items/{w['id']}?view=owner")
    q = json.loads(req("GET", f"/api/queue?project={proj}")[2])
    check(w["id"] in [x["id"] for x in q["items"]], "unanswered decision stays queued after being seen")
    cnt = json.loads(req("GET", "/api/queue?count=1")[2])
    check(isinstance(cnt["count"], int) and "waiting" in cnt, "count endpoint for the header badge")
    st, _, _ = req("GET", "/queue")
    check(st == 200, "GET /queue 200")
    # answered, then the assistant is still working on it: stays out of the queue
    pa = mk("[smoke] q processing", priority="soon", options=[{"label": "X"}])
    created.append(pa["id"])
    jpost(f"/api/items/{pa['id']}/answer", {"choices": ["o1"], "text": "go"})
    rd("comment", str(pa["id"]), "--body", "started on it")
    inq = lambda: pa["id"] in [x["id"] for x in json.loads(req("GET", f"/api/queue?project={proj}")[2])["items"]]  # noqa: E731
    check(not inq(), "answered item stays out while the assistant works on it")
    rd("reopen", str(pa["id"]), "--comment", "follow-up question")
    check(inq(), "reopened (follow-up) answered item returns to the queue")
    jpost(f"/api/items/{pa['id']}/comments", {"body": "prose answer", "author": "owner"})
    check(not inq(), "a prose reply also takes it out of the queue")
    todo_tests()


def todo_tests():
    """Owner TODOs: create, due, done/reopen, rd changes, queue, convert, rollup."""
    print("owner TODOs")
    proj = "smoket"
    t0 = json.loads(req("GET", "/healthz")[2])["now"]
    o = rd("todo", "--title", "[smoke] sign in somewhere", "--body", "See D-1 and #569.", "--project", proj,
           "--priority", "soon", "--due", "2030-01-02")
    t1 = int(o.split()[1].lstrip("#"))
    created.append(t1)
    o = rd("new", "--kind", "todo", "--title", "[smoke] later thing", "--project", proj,
           "--priority", "soon", "--due", "2029-06-01")
    t2 = int(o.split()[1].lstrip("#"))
    created.append(t2)
    o = rd("new", "--title", "[smoke] waits on the todo", "--project", proj, "--blocked-by", str(t1))
    dep = int(o.split()[1].lstrip("#"))
    created.append(dep)
    it = json.loads(rd("show", str(t1), "--json"))
    check(it["kind"] == "todo" and it["status"] == "open" and it["due"] == "2030-01-02", "rd todo: kind, status open, due")
    r = subprocess.run([sys.executable, RD, "todo", "--title", "x", "--project", proj, "--due", "2030-02-30"], capture_output=True, text=True)
    check(r.returncode != 0 and "date" in r.stderr, "bad due date rejected")
    lst = rd("list", "--kind", "todo", "--project", proj)
    check(f"D-{t1}" in lst and "todo" in lst and "due 2030-01-02" in lst, "rd list shows todo kind + due")
    q = json.loads(req("GET", f"/api/queue?project={proj}")[2])
    ids = [x["id"] for x in q["items"]]
    check(ids[:2] == [t2, t1] and q["items"][0]["reason"] == "todo", "todos in the queue, sooner due first")
    check(dep in [x["id"] for x in q["waiting"]], "item blocked by an open todo is waiting")
    todos = json.loads(req("GET", f"/api/todos?project={proj}")[2])
    check([x["id"] for x in todos["open"]] == [t2, t1] and todos["count"] == 2, "/api/todos open list, ordered")
    st, _ = jpost(f"/api/items/{dep}/done", {})
    check(st == 400, "done is only for todos")
    st, d = jpost(f"/api/items/{t1}/done", {"comment": "did it"})
    check(st == 200 and d["status"] == "done", "owner marks done (with a note)")
    lst = json.loads(rd("list", "--project", proj, "--status", "all", "--json"))
    check({x["id"]: x for x in lst["items"]}[dep]["open_blockers"] == [], "a done todo no longer blocks")
    ch = json.loads(rd("changes", "--since", t0))
    td = [x for x in ch.get("todos_done", []) if x["id"] == t1]
    check(td and td[0]["note"] == "did it" and td[0]["project"] == proj, "rd changes: todos_done with the note")
    check(not any(e["kind"] == "done" for e in ch["events"]), "done is reported in todos_done, not events")
    t_mid = ch["now"]
    st, d = jpost(f"/api/items/{t1}/reopen", {})
    check(d["status"] == "open", "owner reopens a todo -> open")
    ch = json.loads(rd("changes", "--since", t_mid))
    check(any(e["item_id"] == t1 and e["kind"] == "reopened" and e["item_kind"] == "todo" for e in ch["events"]),
          "reopen of a todo shows in events (item_kind todo)")
    rd("done", str(t2), "--comment", "verified")
    ch = json.loads(rd("changes", "--since", t_mid))
    check(not any(x["id"] == t2 for x in ch["todos_done"]), "assistant `rd done` is not reported back as owner work")
    roll = {p["project"]: p for p in json.loads(req("GET", "/api/projects")[2])["projects"]}
    check(roll[proj]["counts"]["todo"] == 1 and roll[proj]["counts"]["done"] == 1, "rollup counts to do + done")
    st, _, _ = req("GET", "/todo")
    check(st == 200, "GET /todo 200")
    print("convert decision -> todo")
    o = rd("new", "--title", "[smoke] TODO: owner does X", "--project", proj, "--option", "I'll do it|ok|recommended")
    cv = int(o.split()[1].lstrip("#"))
    created.append(cv)
    jpost(f"/api/items/{cv}/answer", {"choices": ["o1"], "text": "will do"})
    rd("comment", str(cv), "--body", "thanks")
    o = rd("convert", str(cv), "--kind", "todo", "--title", "[smoke] Do X")
    it = json.loads(rd("show", str(cv), "--json"))
    check(it["kind"] == "todo" and it["status"] == "open" and it["title"] == "[smoke] Do X"
          and len(it["answers"]) == 1 and len(it["comments"]) == 1, "convert keeps answers + comments, sets open")
    check(any(e["kind"] == "converted" and "decision -> todo" in e["detail"] for e in it["events"]), "conversion event")
    logs = [f for f in os.listdir(DATA) if f.startswith("conversions-")]
    check(bool(logs), "conversion log written (<data>/conversions-<date>.log)")


if __name__ == "__main__":
    server = start_server()
    print(f"server {BASE}, data {DATA}")
    ok = False
    try:
        main()
        for iid in created:
            rd("delete", str(iid))
        items = json.loads(req("GET", "/api/items?status=all")[2])["items"]
        check(not items, "everything the test created was deleted")
        ok = True
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        if ok:
            shutil.rmtree(TMP, ignore_errors=True)
            print("PASS")
        else:
            print(f"FAIL (server log and data kept in {TMP})")
