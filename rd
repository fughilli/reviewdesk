#!/usr/bin/env python3
"""rd: the agent-side CLI for Review Desk. See README.md.

Server URL: $RD_URL (default http://127.0.0.1:8471). Python 3.10+, stdlib only.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("RD_URL", "http://127.0.0.1:8471").rstrip("/")


def call(method, path, body=None, raw=None, ctype=None):
    data, headers = None, {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw
        headers["Content-Type"] = ctype or "application/octet-stream"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error")
        except Exception:  # noqa: BLE001
            msg = e.reason
        sys.exit(f"rd: {method} {path}: HTTP {e.code}: {msg}")
    except urllib.error.URLError as e:
        sys.exit(f"rd: cannot reach {BASE} ({e.reason}); is the server running? "
                 f"(start it with {os.path.dirname(os.path.abspath(__file__))}/start.sh, or set RD_URL)")


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def read_text(args, name):
    """--body / --body-file (- = stdin)."""
    inline, path = getattr(args, name, None), getattr(args, name + "_file", None)
    if path:
        return sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    return inline


def parse_options(opts):
    res = []
    for s in opts or []:
        parts = s.split("|")
        o = {"label": parts[0].strip()}
        if len(parts) > 1:
            o["description"] = parts[1].strip()
        if len(parts) > 2 and parts[2].strip().lower() in ("recommended", "rec", "1", "true", "yes", "*"):
            o["recommended"] = True
        res.append(o)
    return res


def cmd_new(a):
    body = {"title": a.title, "body": read_text(a, "body") or "",
            "project": a.project or a.tag or "general",
            "priority": a.priority, "options": parse_options(a.option), "multi": a.multi,
            "blocks": a.blocks or [], "blocked_by": a.blocked_by or [],
            "kind": getattr(a, "kind", None) or "decision"}
    if getattr(a, "due", None):
        body["due"] = a.due
    it = call("POST", "/api/items", body)
    for target in a.attach or []:
        attach(it["id"], target, None)
    # "created #N" kept for scripts that parse it; D-N is the canonical reference.
    print(f"created #{it['id']} (D-{it['id']})  {BASE}/item/{it['id']}")
    if a.json:
        out(call("GET", f"/api/items/{it['id']}"))


def cmd_update(a):
    body = {}
    for k in ("title", "tag", "project", "priority", "status", "due"):
        if getattr(a, k) is not None:
            body[k] = getattr(a, k)
    text = read_text(a, "body")
    if text is not None:
        body["body"] = text
    if a.option is not None:
        body["options"] = parse_options(a.option)
    if a.clear_options:
        body["options"] = []
    if a.multi is not None:
        body["multi"] = a.multi == "yes"
    it = call("PATCH", f"/api/items/{a.id}", body)
    print(f"updated #{it['id']} ({it['status']})")


def attach(iid, target, label):
    if target.startswith(("http://", "https://")):
        return call("POST", f"/api/items/{iid}/attachments", {"url": target, "label": label or ""})
    if not os.path.isfile(target):
        sys.exit(f"rd: no such file: {target}")
    with open(target, "rb") as f:
        raw = f.read()
    q = urllib.parse.urlencode({"filename": os.path.basename(target), "label": label or ""})
    return call("POST", f"/api/items/{iid}/attachments?{q}", raw=raw)


def cmd_attach(a):
    r = attach(a.id, a.target, a.label)
    print(f"attached #{r['id']} to item {a.id}: {r['label']}"
          + (f" ({r['content_type']}, {r['size']} B)" if r["kind"] == "file" else ""))


def cmd_comment(a):
    body = read_text(a, "body")
    if not body:
        sys.exit("rd: --body or --body-file is required")
    c = call("POST", f"/api/items/{a.id}/comments", {"body": body, "author": "assistant"})
    print(f"comment #{c['id']} posted on item {a.id}")


def cmd_close(a):
    it = call("POST", f"/api/items/{a.id}/close", {"comment": a.comment or ""})
    print(f"closed #{it['id']}")


def cmd_todo(a):
    a.kind, a.option, a.multi = "todo", None, False
    cmd_new(a)


def cmd_done(a):
    it = call("POST", f"/api/items/{a.id}/done?author=assistant", {"comment": a.comment or ""})
    print(f"D-{it['id']} marked done")


def cmd_convert(a):
    body = {"kind": a.kind}
    for k in ("title", "status", "due"):
        if getattr(a, k):
            body[k] = getattr(a, k)
    it = call("POST", f"/api/items/{a.id}/convert", body)
    print(f"D-{it['id']} is now a {it['kind']} [{it['status']}]: {it['title']}")


def cmd_claim(a):
    it = call("POST", f"/api/items/{a.id}/claim", {"comment": a.note or ""})
    print(f"claimed D-{it['id']} ({it['status']})")


REL = {"blocks": "blocks", "blocked-by": "blocked_by", "blocked_by": "blocked_by"}


def item_id(s):
    t = s.strip().upper().removeprefix("D-").removeprefix("D").removeprefix("#")
    if not t.isdigit():
        sys.exit(f"rd: not a desk item id: {s!r} (use D-12 or 12)")
    return int(t)


def cmd_link(a):
    r = call("POST", "/api/links", {"src": item_id(a.a), "dst": item_id(a.b), "kind": REL[a.rel]})
    print(f"D-{r['src']} blocks D-{r['dst']}" + ("" if r["created"] else " (already linked)"))


def cmd_unlink(a):
    r = call("DELETE", f"/api/links/{item_id(a.a)}/{REL[a.rel]}/{item_id(a.b)}")
    print(f"D-{r['src']} no longer blocks D-{r['dst']}")


def cmd_projects(a):
    d = call("GET", "/api/projects")
    if a.json:
        return out(d)
    for c in d["projects"]:
        n = c["counts"]
        print(f"{c['project']:<14} open {n['open']:<3} waiting {n['waiting']:<3} blocking {n['blocking']:<3}"
              f" answered {n['answered']:<3} requests {n['requested']:<3} closed {n['closed']}")
        for b in c["blocked"]:
            print(f"    blocked: D-{b['id']} {b['title'][:60]} <- "
                  + ", ".join(f"D-{x}" for x in b["open_blockers"]))


def cmd_ref(a):
    out(call("GET", f"/api/refs/{a.type}/{urllib.parse.quote(a.key)}"))


def cmd_reopen(a):
    it = call("POST", f"/api/items/{a.id}/reopen?author=assistant", {"comment": a.comment or ""})
    print(f"reopened #{it['id']}")


def cmd_delete(a):
    call("DELETE", f"/api/items/{a.id}")
    print(f"deleted #{a.id}")


def cmd_list(a):
    q = {"status": a.status}
    if a.since:
        q["since"] = a.since
    if a.tag or a.project:
        q["project"] = a.project or a.tag
    if a.kind:
        q["kind"] = a.kind
    d = call("GET", "/api/items?" + urllib.parse.urlencode(q))
    if a.json:
        return out(d)
    if not d["items"]:
        print("(no items)")
    for it in d["items"]:
        flags = []
        if it["n_answers"]:
            flags.append(f"{it['n_answers']} ans")
        if it["n_comments"]:
            flags.append(f"{it['n_comments']} cmt")
        if it.get("open_blockers"):
            flags.append("blocked by " + ",".join(f"D-{x}" for x in it["open_blockers"]))
        kind = {"workstream": "request", "todo": "todo"}.get(it.get("kind"), "decision")
        if it.get("due"):
            flags.append(f"due {it['due']}")
        print(f"D-{it['id']:<4} {kind:<8} {it['status']:<11} {it['priority']:<9} {it['project']:<12} "
              f"{it['title'][:70]}  [{it['updated'][:16]}{'; ' + ', '.join(flags) if flags else ''}]")
    c = d["counts"]
    print(f"-- open {c['open']} / answered {c['answered']} / closed {c['closed']}"
          f" / requested {c.get('requested', 0)} / in progress {c.get('in_progress', 0)}"
          f" / done {c.get('done', 0)}")


def cmd_show(a):
    it = call("GET", f"/api/items/{a.id}")
    if a.json:
        return out(it)
    kind = {"workstream": "workstream request from the owner",
            "todo": "owner TODO" + (f", due {it['due']}" if it.get("due") else "")}.get(it.get("kind"), "decision")
    print(f"D-{it['id']} [{it['status']}] [{it['priority']}] [{it['project']}] {it['title']}")
    print(f"{kind}; created {it['created']}  updated {it['updated']}  owner last viewed {it['owner_seen']}")
    for label, key in (("Blocks", "blocks"), ("Blocked by", "blocked_by"), ("Mentions", "mentions"),
                       ("Mentioned by", "mentioned_by")):
        if it.get(key):
            print(f"{label}: " + ", ".join(f"D-{x['id']} ({x['status']})" for x in it[key]))
    if it.get("xrefs"):
        print("References: " + ", ".join(x["label"] + (f" (also D-{', D-'.join(map(str, x['also']))})"
                                                       if x["also"] else "") for x in it["xrefs"]))
    if it["body"]:
        print("\n" + it["body"].rstrip())
    labels = {o["key"]: o["label"] for o in it["options"]}
    if it["options"]:
        print(f"\nOptions ({'multi' if it['multi'] else 'single'}):")
        for o in it["options"]:
            print(f"  {o['key']}: {o['label']}{' (recommended)' if o['recommended'] else ''}"
                  f"{' - ' + o['description'] if o['description'] else ''}")
    if it["attachments"]:
        print("\nAttachments:")
        for x in it["attachments"]:
            src = x.get("url") or x.get("path") or f"{BASE}{x['href']}"
            who = (" [owner, with answer]" if x["answer_id"] else
                   f" [in comment {x['comment_id']}]" if x.get("comment_id") else "")
            print(f"  #{x['id']} {x['label']}: {src}{who}")
    if it["answers"]:
        print("\nAnswers (oldest first):")
        for ans in it["answers"]:
            ch = ", ".join(labels.get(k, k) for k in ans["choices"]) or "-"
            print(f"  [{ans['created']}] choices: {ch}")
            if ans["text"]:
                print("    " + ans["text"].replace("\n", "\n    "))
    if it["comments"]:
        print("\nThread:")
        for c in it["comments"]:
            print(f"  [{c['created']}] {c['author']}: " + c["body"].replace("\n", "\n    "))
            for x in c.get("attachments", []):
                print(f"    [file #{x['id']}] {x['filename']} ({x['content_type']}, {x['size']} B): {x['path']}")


def cmd_changes(a):
    out(call("GET", "/api/changes?" + urllib.parse.urlencode({"since": a.since})))


def main():
    ap = argparse.ArgumentParser(prog="rd", description="Review Desk assistant CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("new", help="create an item")
    p.add_argument("--title", required=True)
    p.add_argument("--body")
    p.add_argument("--body-file", help="markdown file, or - for stdin")
    p.add_argument("--project", help="project name, e.g. docs, backend, release (default: general)")
    p.add_argument("--tag", help="alias of --project (legacy)")
    p.add_argument("--blocks", action="append", metavar="N", help="this item blocks D-N (repeatable)")
    p.add_argument("--blocked-by", action="append", metavar="N", help="D-N blocks this item (repeatable)")
    p.add_argument("--kind", choices=["decision", "todo"], default="decision",
                   help="todo = an action for the owner (see `rd todo`)")
    p.add_argument("--due", metavar="YYYY-MM-DD", help="due date (TODOs)")
    p.add_argument("--priority", default="soon", choices=["blocking", "soon", "whenever"])
    p.add_argument("--option", action="append", metavar="'label|description|recommended'")
    p.add_argument("--multi", action="store_true", help="options are multi-select")
    p.add_argument("--attach", action="append", metavar="PATH|URL")
    p.add_argument("--json", action="store_true", help="print the created item as JSON")
    p.set_defaults(fn=cmd_new)

    p = sub.add_parser("update", help="change fields of an item")
    p.add_argument("id", type=item_id)
    p.add_argument("--title")
    p.add_argument("--body")
    p.add_argument("--body-file")
    p.add_argument("--tag", help="alias of --project")
    p.add_argument("--project")
    p.add_argument("--priority", choices=["blocking", "soon", "whenever"])
    p.add_argument("--status", choices=["open", "answered", "closed", "requested", "in_progress", "done"])
    p.add_argument("--due", metavar="YYYY-MM-DD|none")
    p.add_argument("--option", action="append", help="replaces ALL options")
    p.add_argument("--clear-options", action="store_true")
    p.add_argument("--multi", choices=["yes", "no"])
    p.set_defaults(fn=cmd_update)

    p = sub.add_parser("attach", help="attach a file path or a link URL")
    p.add_argument("id", type=item_id)
    p.add_argument("target")
    p.add_argument("--label")
    p.set_defaults(fn=cmd_attach)

    p = sub.add_parser("comment", help="post an assistant comment")
    p.add_argument("id", type=item_id)
    p.add_argument("--body")
    p.add_argument("--body-file")
    p.set_defaults(fn=cmd_comment)

    p = sub.add_parser("close", help="close an item")
    p.add_argument("id", type=item_id)
    p.add_argument("--comment", help="optional closing comment")
    p.set_defaults(fn=cmd_close)

    p = sub.add_parser("todo", help="file a TODO for the owner (an action, not a decision)")
    p.add_argument("--title", required=True)
    p.add_argument("--body")
    p.add_argument("--body-file", help="markdown file, or - for stdin")
    p.add_argument("--project")
    p.add_argument("--tag", help="alias of --project")
    p.add_argument("--priority", default="soon", choices=["blocking", "soon", "whenever"])
    p.add_argument("--due", metavar="YYYY-MM-DD")
    p.add_argument("--blocks", action="append", metavar="N")
    p.add_argument("--blocked-by", action="append", metavar="N")
    p.add_argument("--attach", action="append", metavar="PATH|URL")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_todo)

    p = sub.add_parser("done", help="mark a TODO done (e.g. you verified the owner did it)")
    p.add_argument("id", type=item_id)
    p.add_argument("--comment")
    p.set_defaults(fn=cmd_done)

    p = sub.add_parser("convert", help="re-file an item as another kind (decision <-> todo)")
    p.add_argument("id", type=item_id)
    p.add_argument("--kind", required=True, choices=["todo", "decision"])
    p.add_argument("--title")
    p.add_argument("--status", help="todo: open|done|closed; decision: open|answered|closed")
    p.add_argument("--due", metavar="YYYY-MM-DD")
    p.set_defaults(fn=cmd_convert)

    p = sub.add_parser("claim", help="claim an owner's workstream request (-> in_progress)")
    p.add_argument("id", type=item_id)
    p.add_argument("--note", help="comment posted with the claim (plan, branch, ETA)")
    p.set_defaults(fn=cmd_claim)

    for name, fn, hlp in (("link", cmd_link, "A blocks B / A blocked-by B"),
                          ("unlink", cmd_unlink, "remove a blocks link")):
        p = sub.add_parser(name, help=hlp)
        p.add_argument("a", metavar="A")
        p.add_argument("rel", choices=["blocks", "blocked-by", "blocked_by"])
        p.add_argument("b", metavar="B")
        p.set_defaults(fn=fn)

    p = sub.add_parser("projects", help="per-project rollup")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_projects)

    p = sub.add_parser("ref", help="desk items that mention a PR / commit / issue (JSON)")
    p.add_argument("type", choices=["pr", "commit", "issue"])
    p.add_argument("key")
    p.set_defaults(fn=cmd_ref)

    p = sub.add_parser("reopen", help="reopen an item (as assistant)")
    p.add_argument("id", type=item_id)
    p.add_argument("--comment")
    p.set_defaults(fn=cmd_reopen)

    p = sub.add_parser("delete", help="permanently delete an item and its files")
    p.add_argument("id", type=item_id)
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser("list", help="list items")
    p.add_argument("--status", default="open",
                   help="open|answered|closed|requested|in_progress|requests|active|all or comma list")
    p.add_argument("--since", help="only items updated after this ISO time")
    p.add_argument("--tag", help="alias of --project")
    p.add_argument("--project")
    p.add_argument("--kind", choices=["decision", "workstream", "todo"])
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("show", help="show an item with answers and comments")
    p.add_argument("id", type=item_id)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("changes", help="owner answers/comments/events, new requests, TODOs done (JSON)")
    p.add_argument("--since", required=True, help="ISO-8601; use the previous result's 'now'")
    p.set_defaults(fn=cmd_changes)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
