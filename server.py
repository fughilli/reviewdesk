#!/usr/bin/env python3
"""Review Desk: a human-in-the-loop decision desk for AI agents.

Agents post decision items (with options, attachments and links) and owner
TODOs; the owner answers in the browser; agents poll `rd changes`. The owner
can also open workstream requests for the agents.

Single process, Python 3.10+ standard library only (http.server + sqlite3).
See README.md for configuration, the CLI and the HTTP API.
"""

import argparse
import email.parser
import email.policy
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")


def set_data_dir(path):
    """Point the server at a data directory (SQLite DB + uploaded files)."""
    global DATA, FILES, DB_PATH
    DATA = os.path.abspath(os.path.expanduser(path))
    FILES = os.path.join(DATA, "files")
    DB_PATH = os.path.join(DATA, "reviewdesk.db")


set_data_dir(os.environ.get("RD_DATA_DIR") or os.path.join(HERE, "data"))
MAX_UPLOAD = 25 * 1024 * 1024
MAX_JSON = 2 * 1024 * 1024

PRIORITIES = ("blocking", "soon", "whenever")
# open/answered = decision items (assistant asks, owner answers);
# requested/in_progress = workstream requests (owner asks, assistant claims).
STATUSES = ("open", "answered", "closed", "requested", "in_progress", "done")
# Statuses that resolve an item (a done TODO no longer blocks anything).
FINISHED = ("closed", "done")
FINISHED_SQL = "('closed','done')"
KINDS = ("decision", "workstream", "todo")
DUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUS_ALIASES = {"requests": ["requested", "in_progress"],
                  "active": ["open", "answered", "requested", "in_progress"],
                  "finished": ["closed", "done"]}
SCHEMA_VERSION = 5
RETRACT_WINDOW_S = 600  # owner may undo an answer/comment for 10 minutes
MAX_FILES_PER_MESSAGE = 20

# Optional reference linking (see README "References"). Each kind is off unless
# configured, so a bare "#123" stays plain text until RD_PR_URL_BASE is set.
PR_URL_BASE = os.environ.get("RD_PR_URL_BASE", "").strip()          # https://github.com/org/repo/pull/
_GH = re.match(r"^https?://github\.com/([\w.-]+/[\w.-]+)/pull/?$", PR_URL_BASE, re.I)
GH_REPO = _GH.group(1) if _GH else ""                               # org/repo, when PRs are on GitHub
GIT_DIR = os.environ.get("RD_GIT_DIR", "").strip()                  # local clone: recognise commit hashes
COMMIT_URL_BASE = (os.environ.get("RD_COMMIT_URL_BASE", "").strip()
                   or (f"https://github.com/{GH_REPO}/commit/" if GH_REPO else ""))
ISSUE_URL = os.environ.get("RD_ISSUE_URL", "").strip()              # e.g. https://tracker.example.com/browse/{id}
ISSUE_PREFIXES = [t.strip().upper() for t in os.environ.get("RD_ISSUE_PREFIXES", "").split(",") if t.strip()]
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

# Content types are decided by OUR extension table, never by the uploader.
INLINE_IMAGE = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}
TEXTUAL = {
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
}
OTHER = {".pdf": "application/pdf", ".zip": "application/zip"}

# Every /files response carries this: the browser treats the document as a
# unique opaque origin with scripts disabled, so even an uploaded SVG/HTML that
# is navigated to directly can't run code in the app's origin.
FILE_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"

_write_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def norm_iso(s):
    """Normalise any ISO-8601 timestamp to our UTC string form."""
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def safe_filename(name):
    name = os.path.basename((name or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    if not name:
        name = "file"
    if len(name) > 120:
        root, ext = os.path.splitext(name)
        name = root[: 120 - len(ext)] + ext[:16]
    return name


def classify(filename):
    ext = os.path.splitext(filename)[1].lower()
    if ext in INLINE_IMAGE:
        return INLINE_IMAGE[ext], "image"
    if ext in (".md", ".markdown"):
        return TEXTUAL[ext], "markdown"
    if ext in (".html", ".htm"):
        return TEXTUAL[ext], "html"
    if ext in TEXTUAL:
        return TEXTUAL[ext], "text"
    if ext in OTHER:
        return OTHER[ext], "file"
    return "application/octet-stream", "file"


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


# --------------------------------------------------------------------------
# storage


SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT 'general',     -- legacy alias of project, kept in sync
  project TEXT NOT NULL DEFAULT 'general',
  kind TEXT NOT NULL DEFAULT 'decision',   -- decision | workstream | todo
  author TEXT NOT NULL DEFAULT 'assistant',
  priority TEXT NOT NULL DEFAULT 'soon',
  status TEXT NOT NULL DEFAULT 'open',
  options TEXT NOT NULL DEFAULT '[]',
  multi INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  assistant_activity TEXT NOT NULL,
  owner_seen TEXT,
  snoozed_at TEXT,            -- review queue: snoozed items go to the back
  due TEXT                    -- optional YYYY-MM-DD (owner TODOs)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  answer_id INTEGER,
  comment_id INTEGER,          -- set when the file was sent with a comment
  author TEXT NOT NULL,
  kind TEXT NOT NULL,          -- link | file
  label TEXT NOT NULL DEFAULT '',
  url TEXT,
  filename TEXT,
  stored TEXT,
  content_type TEXT,
  render TEXT,                 -- image | markdown | html | text | file
  size INTEGER,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  choices TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ans_created ON answers(created);
CREATE INDEX IF NOT EXISTS ix_com_created ON comments(created);
CREATE INDEX IF NOT EXISTS ix_evt_created ON events(created);
-- src blocks dst (manual), or src's text mentions desk item dst (automatic).
-- No foreign keys: a mention may name an item that does not exist (yet).
CREATE TABLE IF NOT EXISTS links (
  src INTEGER NOT NULL,
  dst INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- blocks | mentions
  created TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS ix_links_dst ON links(dst, kind);
-- External objects an item's text mentions (automatic, rebuilt on save).
CREATE TABLE IF NOT EXISTS xrefs (
  item_id INTEGER NOT NULL,
  rtype TEXT NOT NULL,         -- pr | commit | issue
  rkey TEXT NOT NULL,          -- PR number, full commit sha, issue id (ABC-12)
  PRIMARY KEY (item_id, rtype, rkey)
);
CREATE INDEX IF NOT EXISTS ix_xrefs_key ON xrefs(rtype, rkey);
"""


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(FILES, exist_ok=True)
    conn = db()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    conn.commit()
    migrate(conn)
    conn.close()


# --------------------------------------------------------------------------
# backup + migration


def backup_data(reason):
    """Copy data/ (consistent DB snapshot + files + logs) to data/backup-<ts>/."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dst = os.path.join(DATA, f"backup-{ts}")
    os.makedirs(dst)
    src = sqlite3.connect(DB_PATH)
    out = sqlite3.connect(os.path.join(dst, "reviewdesk.db"))
    src.backup(out)
    out.close()
    src.close()
    for name in os.listdir(DATA):
        full = os.path.join(DATA, name)
        if name.startswith(("backup-", "reviewdesk.db")):
            continue
        if os.path.isdir(full):
            shutil.copytree(full, os.path.join(dst, name))
        else:
            shutil.copy2(full, os.path.join(dst, name))
    with open(os.path.join(dst, "BACKUP.txt"), "w") as f:
        f.write(f"{now_iso()} {reason}\n")
    print(f"{now_iso()} backup: {dst} ({reason})", flush=True)
    return dst


def migrate(conn):
    v = conn.execute("PRAGMA user_version").fetchone()[0]
    if v >= SCHEMA_VERSION:
        return
    n_items = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    if n_items:
        backup_data(f"before schema migration v{v} -> v{SCHEMA_VERSION}")
    with _write_lock:
        if v < 1:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
            for col, ddl in (("project", "TEXT NOT NULL DEFAULT 'general'"),
                             ("kind", "TEXT NOT NULL DEFAULT 'decision'"),
                             ("author", "TEXT NOT NULL DEFAULT 'assistant'")):
                if col not in cols:
                    conn.execute(f"ALTER TABLE items ADD COLUMN {col} {ddl}")
            conn.execute("UPDATE items SET project=tag")
        if v < 2:
            acols = {r[1] for r in conn.execute("PRAGMA table_info(attachments)")}
            if "comment_id" not in acols:
                conn.execute("ALTER TABLE attachments ADD COLUMN comment_id INTEGER")
        if v < 4:
            icols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
            if "due" not in icols:
                conn.execute("ALTER TABLE items ADD COLUMN due TEXT")
        if v < 3:
            icols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
            if "snoozed_at" not in icols:
                conn.execute("ALTER TABLE items ADD COLUMN snoozed_at TEXT")
        # v5: external references are rebuilt below from the current RD_* config
        # (the issue-tracker reference type is now called "issue").
        conn.execute("CREATE INDEX IF NOT EXISTS ix_items_project ON items(project)")
        for (iid,) in conn.execute("SELECT id FROM items").fetchall():
            reindex(conn, iid)
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        conn.commit()


# --------------------------------------------------------------------------
# references (mirrors static/md.js refs(); keep the two in step)

FENCE_RE = re.compile(r"(?ms)^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?(?:^ {0,3}\1[ \t]*$|\Z)")
CODESPAN_RE = re.compile(r"(`+)[\s\S]*?[^`]\1(?!`)")


def split_code(text):
    """[(is_code, segment)] covering text exactly: fenced blocks and `code` spans."""
    out, pos = [], 0
    spans = []
    for m in FENCE_RE.finditer(text):
        spans.append((m.start(), m.end()))
    # inline code spans outside fences
    i = 0
    for a, b in spans + [(len(text), len(text))]:
        for m in CODESPAN_RE.finditer(text, i, a):
            if m.end() <= a:
                spans.append((m.start(), m.end()))
        i = b
    spans.sort()
    for a, b in spans:
        if a < pos:
            continue
        if a > pos:
            out.append((False, text[pos:a]))
        out.append((True, text[a:b]))
        pos = b
    if pos < len(text):
        out.append((False, text[pos:]))
    return out


MD_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
URL_RE = re.compile(r"https?://[^\s<>()]+[^\s<>().,;:!?'\"]")
NEVER = "(?!)"  # a pattern that matches nothing: used for reference kinds that are off


def _url_prefix_re(base, tail):
    return re.compile("^" + re.escape(base) + tail, re.I) if base else None


PR_URL_RE = _url_prefix_re(PR_URL_BASE, r"(?P<n>\d+)")
COMMIT_URL_RE = _url_prefix_re(COMMIT_URL_BASE, r"(?P<sha>[0-9a-f]{7,40})")
GH_URL_RE = (re.compile(r"^https?://github\.com/" + re.escape(GH_REPO)
                        + r"/(?:(?:pull|issues)/(?P<n>\d+)|commit/(?P<sha>[0-9a-f]{7,40}))", re.I)
             if GH_REPO else None)
_ISSUE_ID = r"(?P<id>[A-Za-z][A-Za-z0-9]*-\d+)"
ISSUE_URL_RE = (re.compile("^" + re.escape(ISSUE_URL).replace(re.escape("{id}"), _ISSUE_ID), re.I)
                if ISSUE_URL and "{id}" in ISSUE_URL else _url_prefix_re(ISSUE_URL, _ISSUE_ID))
_PREFIXES = "|".join(re.escape(t) for t in ISSUE_PREFIXES) or NEVER
REF_RE = re.compile(
    r"(?P<dp>\b(?:[Dd]esk\s+[Ii]tem|[Dd]esk|[Ii]tem)\s+#(?P<dpn>\d{1,6})\b)"
    r"|(?P<rp>" + (r"\b" + re.escape(GH_REPO) if GH_REPO else NEVER) + r"#(?P<rpn>\d{1,6})\b)"
    r"|(?P<d>\bD-?(?P<dn>\d{1,6})\b)"
    r"|(?P<iss>\b(?P<ik>(?:" + _PREFIXES + r"))-(?P<inum>\d{1,6})\b)"
    r"|(?P<pr>" + ("" if PR_URL_BASE else NEVER) + r"(?<![\w&#/])#(?P<pn>\d{1,6})\b)"
    r"|(?P<sha>" + ("" if GIT_DIR else NEVER) + r"\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b)"
)


def url_ref(u):
    """A URL that points at one of the configured PR / commit / issue trackers."""
    for rx in (GH_URL_RE, PR_URL_RE, COMMIT_URL_RE):
        m = rx.match(u) if rx else None
        if m:
            d = m.groupdict()
            if d.get("n"):
                return ("pr", str(int(d["n"]))) if PR_URL_BASE else None
            if d.get("sha"):
                return ("commit", d["sha"].lower()) if GIT_DIR else None
    m = ISSUE_URL_RE.match(u) if ISSUE_URL_RE else None
    if m and m.group("id").split("-")[0].upper() in ISSUE_PREFIXES:
        return ("issue", m.group("id").upper())
    return None


def scan_refs(text):
    """Set of (type, key): item/<n>, pr/<n>, commit/<token>, issue/<ID>.

    Commit tokens are unresolved hex; resolve_commit() decides if they're real."""
    refs = set()
    for is_code, seg in split_code(text or ""):
        if is_code:
            continue

        def url_sub(m):
            u = m.group(1) if m.re is MD_LINK_RE else m.group(0)
            r = url_ref(u)
            if r:
                refs.add(r)
            return " "
        seg = MD_LINK_RE.sub(url_sub, seg)
        seg = URL_RE.sub(url_sub, seg)
        for m in REF_RE.finditer(seg):
            if m.group("dp"):
                refs.add(("item", str(int(m.group("dpn")))))
            elif m.group("d"):
                refs.add(("item", str(int(m.group("dn")))))
            elif m.group("rp"):
                refs.add(("pr", str(int(m.group("rpn")))))
            elif m.group("pr"):
                refs.add(("pr", str(int(m.group("pn")))))
            elif m.group("iss"):
                refs.add(("issue", f"{m.group('ik').upper()}-{int(m.group('inum'))}"))
            elif m.group("sha"):
                refs.add(("commit", m.group("sha")))
    return refs


_commit_cache = {}  # token -> (full sha | None, checked_at)
NEG_TTL = 600


def resolve_commit(tok):
    tok = tok.lower()
    if not GIT_DIR or not re.fullmatch(r"[0-9a-f]{7,40}", tok):
        return None
    hit = _commit_cache.get(tok)
    if hit and (hit[0] or time.time() - hit[1] < NEG_TTL):
        return hit[0]
    sha = None
    try:
        r = subprocess.run(["git", "-C", GIT_DIR, "rev-parse", "--verify", "--quiet",
                            f"{tok}^{{commit}}"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", r.stdout.strip()):
            sha = r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    _commit_cache[tok] = (sha, time.time())
    return sha


def ref_url(rtype, key):
    """Outbound URL for a reference, or None when that tracker has no URL configured."""
    if rtype == "pr" and PR_URL_BASE:
        return PR_URL_BASE + key
    if rtype == "commit" and COMMIT_URL_BASE:
        return COMMIT_URL_BASE + key
    if rtype == "issue" and ISSUE_URL:
        return ISSUE_URL.replace("{id}", key) if "{id}" in ISSUE_URL else ISSUE_URL + key
    return None


def ref_label(rtype, key):
    return {"pr": f"#{key}", "commit": key[:9], "issue": key}.get(rtype, key)


def item_texts(conn, iid):
    r = get_item(conn, iid)
    texts = [r["title"], r["body"]]
    for o in json.loads(r["options"]):
        texts += [o["label"], o["description"]]
    texts += [c[0] for c in conn.execute("SELECT body FROM comments WHERE item_id=?", (iid,))]
    texts += [a[0] for a in conn.execute("SELECT text FROM answers WHERE item_id=?", (iid,))]
    texts += [a[0] for a in conn.execute(
        "SELECT url FROM attachments WHERE item_id=? AND kind='link'", (iid,))]
    return texts


def item_refs(conn, iid):
    refs = set()
    for t in item_texts(conn, iid):
        refs |= scan_refs(t)
    return refs


def reindex(conn, iid):
    """Rebuild iid's automatic edges: mentions (desk items) and xrefs (external)."""
    refs = item_refs(conn, iid)
    ts = now_iso()
    conn.execute("DELETE FROM links WHERE src=? AND kind='mentions'", (iid,))
    conn.execute("DELETE FROM xrefs WHERE item_id=?", (iid,))
    for rtype, key in refs:
        if rtype == "item":
            if int(key) != iid:
                conn.execute("INSERT OR IGNORE INTO links(src, dst, kind, created) VALUES (?,?,?,?)",
                             (iid, int(key), "mentions", ts))
            continue
        if rtype == "commit":
            key = resolve_commit(key)
            if not key:
                continue
        conn.execute("INSERT OR IGNORE INTO xrefs(item_id, rtype, rkey) VALUES (?,?,?)",
                     (iid, rtype, key))


def norm_options(raw):
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ApiError(400, "options must be a list")
    out, seen = [], set()
    for i, o in enumerate(raw):
        if isinstance(o, str):
            o = {"label": o}
        if not isinstance(o, dict) or not str(o.get("label", "")).strip():
            raise ApiError(400, f"option {i} needs a label")
        key = str(o.get("key") or f"o{i + 1}")
        if key in seen:
            raise ApiError(400, f"duplicate option key {key}")
        seen.add(key)
        out.append(
            {
                "key": key,
                "label": str(o["label"]).strip(),
                "description": str(o.get("description") or "").strip(),
                "recommended": bool(o.get("recommended")),
            }
        )
    return out


def item_row(r):
    d = dict(r)
    d["tag"] = d.get("project", d.get("tag"))
    d["options"] = json.loads(d["options"])
    d["multi"] = bool(d["multi"])
    return d


def get_item(conn, iid):
    r = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not r:
        raise ApiError(404, f"no item {iid}")
    return r


def full_item(conn, iid):
    d = item_row(get_item(conn, iid))
    d["attachments"] = [
        att_dict(a)
        for a in conn.execute("SELECT * FROM attachments WHERE item_id=? ORDER BY id", (iid,))
    ]
    d["answers"] = []
    for a in conn.execute("SELECT * FROM answers WHERE item_id=? ORDER BY id", (iid,)):
        ad = dict(a)
        ad["choices"] = json.loads(ad["choices"])
        d["answers"].append(ad)
    by_comment = {}
    for a in d["attachments"]:
        if a.get("comment_id"):
            by_comment.setdefault(a["comment_id"], []).append(a)
    d["comments"] = []
    for c in conn.execute("SELECT * FROM comments WHERE item_id=? ORDER BY id", (iid,)):
        cd = dict(c)
        cd["attachments"] = by_comment.get(cd["id"], [])
        d["comments"].append(cd)
    d["events"] = [
        dict(e) for e in conn.execute("SELECT * FROM events WHERE item_id=? ORDER BY id", (iid,))
    ]
    d.update(relations(conn, iid))
    return d


def summaries(conn, ids):
    ids = sorted(set(int(i) for i in ids))
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in conn.execute(
                "SELECT id, title, status, project, priority, kind FROM items WHERE id IN (%s)"
                % ",".join("?" * len(chunk)), chunk):
            out[r["id"]] = dict(r)
    return out


def open_blockers_map(conn):
    """{blocked item id: [ids of its blockers that are not closed]}"""
    m = {}
    for r in conn.execute(
            "SELECT l.dst, l.src FROM links l JOIN items s ON s.id=l.src"
            " WHERE l.kind='blocks' AND s.status NOT IN " + FINISHED_SQL + " ORDER BY l.src"):
        m.setdefault(r[0], []).append(r[1])
    return m


def relations(conn, iid):
    blocks = [r[0] for r in conn.execute(
        "SELECT dst FROM links WHERE src=? AND kind='blocks' ORDER BY dst", (iid,))]
    blocked_by = [r[0] for r in conn.execute(
        "SELECT src FROM links WHERE dst=? AND kind='blocks' ORDER BY src", (iid,))]
    mentions = [r[0] for r in conn.execute(
        "SELECT dst FROM links WHERE src=? AND kind='mentions' ORDER BY dst", (iid,))]
    mentioned_by = [r[0] for r in conn.execute(
        "SELECT src FROM links WHERE dst=? AND kind='mentions' ORDER BY src", (iid,))]
    refs = item_refs(conn, iid)
    commits = {}
    for t, k in refs:
        if t == "commit":
            sha = resolve_commit(k)
            if sha:
                commits[k] = sha
    ref_items = {int(k) for t, k in refs if t == "item"}
    sm = summaries(conn, set(blocks) | set(blocked_by) | set(mentions) | set(mentioned_by) | ref_items)
    xrefs = []
    for r in conn.execute("SELECT rtype, rkey FROM xrefs WHERE item_id=? ORDER BY rtype, rkey", (iid,)):
        also = [x[0] for x in conn.execute(
            "SELECT item_id FROM xrefs WHERE rtype=? AND rkey=? AND item_id!=? ORDER BY item_id",
            (r[0], r[1], iid))]
        sm.update(summaries(conn, [a for a in also if a not in sm]))
        xrefs.append({"type": r[0], "key": r[1], "label": ref_label(r[0], r[1]),
                      "url": ref_url(r[0], r[1]), "href": f"/ref/{r[0]}/{r[1]}", "also": also})
    pick = lambda ids: [sm[i] for i in ids if i in sm]  # noqa: E731
    open_bl = [i for i in blocked_by if i in sm and sm[i]["status"] not in FINISHED]
    return {
        "blocks": pick(blocks), "blocked_by": pick(blocked_by),
        "mentions": pick(mentions), "mentioned_by": pick(mentioned_by),
        "open_blockers": open_bl, "xrefs": xrefs,
        "ref_ctx": {"items": {str(k): v for k, v in sm.items()}, "commits": commits,
                    "also": {f"{x['type']}:{x['key']}": x["also"] for x in xrefs}},
    }


def att_dict(a):
    d = dict(a)
    if d["kind"] == "file":
        d["href"] = f"/files/{d['id']}/{quote(d['filename'])}"
        d["path"] = os.path.join(FILES, d["stored"])  # local file, for agents' tools
    d.pop("stored", None)
    return d


def log_event(conn, iid, actor, kind, detail="", ts=None):
    conn.execute(
        "INSERT INTO events(item_id, actor, kind, detail, created) VALUES (?,?,?,?,?)",
        (iid, actor, kind, detail, ts or now_iso()),
    )


def touch(conn, iid, actor, ts):
    if actor == "assistant":
        conn.execute(
            "UPDATE items SET updated=?, assistant_activity=? WHERE id=?", (ts, ts, iid)
        )
    else:
        conn.execute("UPDATE items SET updated=? WHERE id=?", (ts, iid))


def validate_fields(body, partial):
    out = {}
    if "title" in body or not partial:
        t = str(body.get("title") or "").strip()
        if not t:
            raise ApiError(400, "title is required")
        out["title"] = t[:300]
    if "body" in body:
        out["body"] = str(body.get("body") or "")
    if "due" in body:
        due = body.get("due")
        due = str(due).strip() if due not in (None, "", "none") else None
        if due is not None:
            if not DUE_RE.match(due):
                raise ApiError(400, "due must be YYYY-MM-DD")
            try:
                datetime.strptime(due, "%Y-%m-%d")
            except ValueError:
                raise ApiError(400, f"not a date: {due}")
        out["due"] = due
    if "project" in body or "tag" in body or not partial:
        proj = str(body.get("project") or body.get("tag") or "general").strip().lower()
        if not TAG_RE.match(proj):
            raise ApiError(400, "project must match [a-z0-9][a-z0-9_-]* (max 32)")
        out["project"] = proj
        out["tag"] = proj
    if "priority" in body or not partial:
        p = str(body.get("priority") or "soon").strip().lower()
        if p not in PRIORITIES:
            raise ApiError(400, f"priority must be one of {PRIORITIES}")
        out["priority"] = p
    if "options" in body:
        out["options"] = json.dumps(norm_options(body.get("options")))
    if "multi" in body:
        out["multi"] = 1 if body.get("multi") else 0
    if "status" in body:
        s = str(body["status"]).lower()
        if s not in STATUSES:
            raise ApiError(400, f"status must be one of {STATUSES}")
        out["status"] = s
    return out


def store_file(conn, iid, author, filename, data, label="", answer_id=None, ts=None,
               comment_id=None):
    if len(data) > MAX_UPLOAD:
        raise ApiError(413, "file exceeds 25 MB")
    safe = safe_filename(filename)
    ctype, render = classify(safe)
    stored = f"{iid}/{uuid.uuid4().hex}_{safe}"
    path = os.path.join(FILES, stored)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    cur = conn.execute(
        "INSERT INTO attachments(item_id, answer_id, comment_id, author, kind, label, filename,"
        " stored, content_type, render, size, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (iid, answer_id, comment_id, author, "file", label or safe, safe, stored, ctype, render,
         len(data), ts or now_iso()),
    )
    return cur.lastrowid


def parse_multipart(ctype, raw):
    """Return (fields: dict[str, list[str]], files: list[(field, filename, bytes)])."""
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + ctype.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
    )
    if not msg.is_multipart():
        raise ApiError(400, "bad multipart body")
    fields, files = {}, []
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        fn = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if fn is not None:
            if payload:
                files.append((name, fn, payload))
        else:
            fields.setdefault(name, []).append(payload.decode("utf-8", "replace"))
    return fields, files


# --------------------------------------------------------------------------
# HTTP


ROUTES = []


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn

    return deco


class Handler(BaseHTTPRequestHandler):
    server_version = "ReviewDesk/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (now_iso(), fmt % args))

    # -- plumbing ---------------------------------------------------------
    def _dispatch(self, method):
        u = urlparse(self.path)
        self.query = {k: v[-1] for k, v in parse_qs(u.query).items()}
        try:
            for m, rx, fn in ROUTES:
                if m == method:
                    mt = rx.match(u.path)
                    if mt:
                        return fn(self, *mt.groups())
            if method == "GET":
                return self.serve_page(u.path)
            raise ApiError(404, "not found")
        except ApiError as e:
            self.send_json({"error": e.msg}, e.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self.send_json({"error": f"internal error: {e}"}, 500)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def read_body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            # Drain is pointless for a huge body; just refuse and close.
            self.close_connection = True
            raise ApiError(413, f"request body exceeds {limit // (1024 * 1024)} MB")
        return self.rfile.read(n) if n else b""

    def json_body(self):
        raw = self.read_body(MAX_JSON)
        if not raw:
            return {}
        try:
            d = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ApiError(400, f"bad JSON: {e}")
        if not isinstance(d, dict):
            raise ApiError(400, "JSON body must be an object")
        return d

    def send_bytes(self, data, ctype, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, obj, status=200):
        self.send_bytes(
            json.dumps(obj, indent=1).encode(), "application/json", status,
            {"Cache-Control": "no-store"},
        )

    # -- pages ------------------------------------------------------------
    def serve_page(self, path):
        if path.startswith("/static/"):
            name = os.path.normpath(path[len("/static/"):])
            full = os.path.join(STATIC, name)
            if name.startswith("..") or not os.path.isfile(full):
                raise ApiError(404, "not found")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                return self.send_bytes(f.read(), ctype, headers={"Cache-Control": "no-cache"})
        if path in ("/", "/projects", "/new", "/queue", "/todo") or re.match(
                r"^/(item/\d+|ref/(pr|commit|issue)/[A-Za-z0-9-]+)$", path):
            with open(os.path.join(STATIC, "index.html"), "rb") as f:
                return self.send_bytes(
                    f.read(), "text/html; charset=utf-8",
                    headers={
                        "Cache-Control": "no-cache",
                        "Content-Security-Policy": (
                            "default-src 'self'; img-src 'self' data: blob:; "
                            "style-src 'self'; script-src 'self'; frame-src 'self'; "
                            "object-src 'none'; base-uri 'none'"
                        ),
                    },
                )
        raise ApiError(404, "not found")


# --- read --------------------------------------------------------------------

PRIO_SQL = "CASE priority WHEN 'blocking' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END"


@route("GET", r"/healthz")
def healthz(h):
    h.send_json({"ok": True, "now": now_iso()})


@route("GET", r"/api/items")
def list_items(h):
    q, args = "SELECT * FROM items WHERE 1=1", []
    st = h.query.get("status")
    if st and st != "all":
        sts = []
        for x in st.split(","):
            sts += STATUS_ALIASES.get(x, [x])
        if any(s not in STATUSES for s in sts):
            raise ApiError(400, "bad status")
        q += " AND status IN (%s)" % ",".join("?" * len(sts))
        args += sts
    proj = h.query.get("project") or h.query.get("tag")
    if proj:
        q += " AND project=?"
        args.append(proj)
    if h.query.get("kind"):
        q += " AND kind=?"
        args.append(h.query["kind"])
    if h.query.get("priority"):
        q += " AND priority=?"
        args.append(h.query["priority"])
    if h.query.get("since"):
        q += " AND updated>?"
        args.append(norm_iso(h.query["since"]))
    q += f" ORDER BY {PRIO_SQL}, updated DESC"
    conn = db()
    try:
        items = []
        obm = open_blockers_map(conn)
        for r in conn.execute(q, args):
            d = item_row(r)
            d.pop("body", None)
            iid = d["id"]
            d["n_comments"] = conn.execute(
                "SELECT COUNT(*) FROM comments WHERE item_id=?", (iid,)).fetchone()[0]
            d["n_attachments"] = conn.execute(
                "SELECT COUNT(*) FROM attachments WHERE item_id=?", (iid,)).fetchone()[0]
            d["n_answers"] = conn.execute(
                "SELECT COUNT(*) FROM answers WHERE item_id=?", (iid,)).fetchone()[0]
            d["is_new"] = d["owner_seen"] is None or d["assistant_activity"] > d["owner_seen"]
            d["open_blockers"] = obm.get(iid, [])
            items.append(d)
        counts = {s: 0 for s in STATUSES}
        for r in conn.execute("SELECT status, COUNT(*) FROM items GROUP BY status"):
            counts[r[0]] = r[1]
        projects = [r[0] for r in conn.execute("SELECT DISTINCT project FROM items ORDER BY project")]
        h.send_json({"items": items, "counts": counts, "tags": projects, "projects": projects,
                     "now": now_iso()})
    finally:
        conn.close()


@route("GET", r"/api/items/(\d+)")
def show_item(h, iid):
    iid = int(iid)
    conn = db()
    try:
        d = full_item(conn, iid)
        if h.query.get("view") == "owner":
            # Owner opened the page: remember what they had seen before, then
            # mark everything as seen.
            d["prev_owner_seen"] = d["owner_seen"]
            with _write_lock:
                conn.execute("UPDATE items SET owner_seen=? WHERE id=?", (now_iso(), iid))
                conn.commit()
        h.send_json(d)
    finally:
        conn.close()


@route("GET", r"/api/changes")
def changes(h):
    since = h.query.get("since")
    if not since:
        raise ApiError(400, "since is required (ISO-8601)")
    since = norm_iso(since)
    now = now_iso()
    conn = db()
    try:
        titles = {r["id"]: (r["title"], r["project"], r["status"], r["kind"])
                  for r in conn.execute("SELECT id, title, project, status, kind FROM items")}

        def ctx(iid):
            t = titles.get(iid, ("?", "?", "?", "?"))
            return {"item_title": t[0], "item_tag": t[1], "item_project": t[1],
                    "item_status": t[2], "item_kind": t[3]}

        answers = []
        for a in conn.execute(
                "SELECT * FROM answers WHERE created>? AND created<=? ORDER BY created",
                (since, now)):
            d = dict(a)
            d["choices"] = json.loads(d["choices"])
            opts = {o["key"]: o["label"] for o in json.loads(
                conn.execute("SELECT options FROM items WHERE id=?", (d["item_id"],))
                .fetchone()[0])}
            d["choice_labels"] = [opts.get(k, k) for k in d["choices"]]
            d["attachments"] = [att_dict(x) for x in conn.execute(
                "SELECT * FROM attachments WHERE answer_id=?", (d["id"],))]
            d.update(ctx(d["item_id"]))
            answers.append(d)
        comments = []
        for c in conn.execute(
                "SELECT * FROM comments WHERE author='owner' AND created>? AND created<=?"
                " ORDER BY created", (since, now)):
            d = dict(c)
            d["attachments"] = [att_dict(x) for x in conn.execute(
                "SELECT * FROM attachments WHERE comment_id=? ORDER BY id", (d["id"],))]
            d.update(ctx(d["item_id"]))
            comments.append(d)
        requests = []
        for r in conn.execute(
                "SELECT * FROM items WHERE kind='workstream' AND author='owner'"
                " AND created>? AND created<=? ORDER BY created", (since, now)):
            iid = r["id"]
            requests.append({
                "id": iid, "title": r["title"], "project": r["project"], "body": r["body"],
                "priority": r["priority"], "created": r["created"], "status": r["status"],
                "url": f"/item/{iid}",
                "blocks": [x[0] for x in conn.execute(
                    "SELECT dst FROM links WHERE src=? AND kind='blocks'", (iid,))],
                "blocked_by": [x[0] for x in conn.execute(
                    "SELECT src FROM links WHERE dst=? AND kind='blocks'", (iid,))],
                "attachments": [att_dict(x) for x in conn.execute(
                    "SELECT * FROM attachments WHERE item_id=?", (iid,))],
            })
        req_born = {(r["id"], r["created"]) for r in requests}
        events = []
        for e in conn.execute(
                "SELECT * FROM events WHERE actor='owner'"
                " AND kind NOT IN ('answered','commented','requested','done')"
                " AND created>? AND created<=? ORDER BY created", (since, now)):
            d = dict(e)
            if (d["item_id"], d["created"]) in req_born:
                continue  # part of creating a request: already reported in `requests`
            d.update(ctx(d["item_id"]))
            events.append(d)
        todos_done = []
        for e in conn.execute(
                "SELECT e.*, i.title, i.project, i.priority, i.due, i.status FROM events e"
                " JOIN items i ON i.id=e.item_id WHERE e.kind='done' AND e.actor='owner'"
                " AND e.created>? AND e.created<=? ORDER BY e.created", (since, now)):
            note = conn.execute("SELECT body FROM comments WHERE item_id=? AND author='owner'"
                                " AND created=?", (e["item_id"], e["created"])).fetchone()
            todos_done.append({"id": e["item_id"], "title": e["title"], "project": e["project"],
                               "priority": e["priority"], "due": e["due"], "done_at": e["created"],
                               "status_now": e["status"], "note": note[0] if note else "",
                               "url": f"/item/{e['item_id']}"})
        h.send_json({"since": since, "now": now, "answers": answers,
                     "comments": comments, "events": events, "requests": requests,
                     "todos_done": todos_done})
    finally:
        conn.close()


# --- review queue -------------------------------------------------------------

PRIO_RANK = {"blocking": 0, "soon": 1, "whenever": 2}


def queue_state(conn, project=None):
    """Items that need the owner, in queue order, plus those held back by blockers.

    An item needs the owner when it is not closed and:
      - never: a decision the owner already answered (choice or prose) that the
        assistant hasn't finished with (status 'answered', or the owner's input is
        newer than the assistant's last action) — it returns only via `rd reopen`;
      - decision, status open, and no owner answer since the assistant last acted
        ("answer": waiting for a decision), or
      - the assistant did something since the owner last opened it ("activity"), or
      - workstream request: an assistant comment the owner hasn't seen, other than
        the note posted with `rd claim` ("reply"), or
      - the owner snoozed it ("snoozed"; it stays in the queue until handled).
    Order: not snoozed first, by priority (blocking, soon, whenever) then oldest;
    snoozed last, oldest snooze first. Items with an open blocker are left out of
    the queue and reported in `waiting`."""
    obm = open_blockers_map(conn)
    last_ans = dict(conn.execute("SELECT item_id, MAX(created) FROM answers GROUP BY item_id"))
    claim_ts = {(r[0], r[1]) for r in conn.execute(
        "SELECT item_id, created FROM events WHERE kind='claimed'")}
    last_owner_c = dict(conn.execute(
        "SELECT item_id, MAX(created) FROM comments WHERE author='owner' GROUP BY item_id"))
    last_reply = {}
    for iid, created in conn.execute(
            "SELECT item_id, created FROM comments WHERE author='assistant' ORDER BY created"):
        if (iid, created) not in claim_ts:
            last_reply[iid] = created
    q = "SELECT * FROM items WHERE status NOT IN " + FINISHED_SQL
    args = []
    if project:
        q += " AND project=?"
        args.append(project)
    items, waiting = [], []
    for r in conn.execute(q, args):
        iid = r["id"]
        # the owner has seen the item if they opened it OR answered/commented on it
        seen = max([x for x in (r["owner_seen"], last_ans.get(iid), last_owner_c.get(iid)) if x],
                   default=None)
        reason = None
        if r["kind"] == "todo":
            reason = "todo"  # every open owner TODO is the owner's to act on
        elif r["kind"] == "decision":
            la = last_ans.get(iid)
            owner_in = max([x for x in (la, last_owner_c.get(iid)) if x], default=None)
            if r["status"] == "answered" or (owner_in and owner_in > r["assistant_activity"]):
                # The owner already answered (a choice, or a prose reply) and the assistant
                # is still acting on it. It comes back only when the assistant reopens it
                # (`rd reopen`, e.g. for a follow-up question); `rd close` ends it.
                reason = None
            elif r["status"] == "open" and (la is None or r["assistant_activity"] > la):
                reason = "answer"
            elif seen is None or r["assistant_activity"] > seen:
                reason = "activity"
        else:
            lr = last_reply.get(iid)
            if lr and (seen is None or lr > seen):
                reason = "reply"
        if not reason and r["snoozed_at"] and not (r["kind"] == "decision" and (
                r["status"] == "answered" or (owner_in and owner_in > r["assistant_activity"]))):
            reason = "snoozed"
        if not reason:
            continue
        d = {"id": iid, "title": r["title"], "project": r["project"], "priority": r["priority"],
             "kind": r["kind"], "status": r["status"], "created": r["created"],
             "updated": r["updated"], "snoozed_at": r["snoozed_at"], "reason": reason,
             "due": r["due"],
             "n_options": len(json.loads(r["options"])), "open_blockers": obm.get(iid, [])}
        (waiting if d["open_blockers"] else items).append(d)
    # due dates only exist on TODOs: within a priority, sooner due first, undated after
    items.sort(key=lambda d: (d["snoozed_at"] is not None, d["snoozed_at"] or "",
                              PRIO_RANK.get(d["priority"], 9), d["due"] or "9999", d["created"]))
    waiting.sort(key=lambda d: (PRIO_RANK.get(d["priority"], 9), d["created"]))
    return items, waiting


@route("GET", r"/api/queue")
def queue(h):
    conn = db()
    try:
        items, waiting = queue_state(conn, h.query.get("project") or None)
        if h.query.get("count"):
            todo = conn.execute("SELECT COUNT(*) FROM items WHERE kind='todo' AND status='open'").fetchone()[0]
            return h.send_json({"count": len(items), "waiting": len(waiting), "todo": todo})
        projects = sorted({d["project"] for d in items})
        h.send_json({"items": items, "waiting": waiting, "count": len(items),
                     "projects": projects, "now": now_iso()})
    finally:
        conn.close()


@route("POST", r"/api/items/(\d+)/snooze")
def snooze_item(h, iid):
    """Owner-only UI state: no event, no change to `updated`, not in `rd changes`.
    {"snoozed_at": null} un-snoozes; {"snoozed_at": "<iso>"} restores (undo)."""
    iid = int(iid)
    b = h.json_body()
    if "snoozed_at" in b:
        val = norm_iso(b["snoozed_at"]) if b["snoozed_at"] else None
    else:
        val = now_iso()
    with _write_lock:
        conn = db()
        try:
            old = get_item(conn, iid)["snoozed_at"]
            conn.execute("UPDATE items SET snoozed_at=? WHERE id=?", (val, iid))
            conn.commit()
        finally:
            conn.close()
    h.send_json({"id": iid, "snoozed_at": val, "previous": old})


def _retract(h, table, rid):
    """Owner undo of their own answer/comment within RETRACT_WINDOW_S. Deletes it
    and its files, and logs a 'retracted' owner event (visible in `rd changes`)."""
    rid = int(rid)
    b = h.json_body()
    with _write_lock:
        conn = db()
        try:
            row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (rid,)).fetchone()
            if not row:
                raise ApiError(404, f"no such {table[:-1]}")
            if table == "comments" and row["author"] != "owner":
                raise ApiError(403, "only the owner's own comments can be retracted")
            age = (datetime.now(timezone.utc)
                   - datetime.fromisoformat(row["created"].replace("Z", "+00:00"))).total_seconds()
            if age > RETRACT_WINDOW_S:
                raise ApiError(409, "too late to undo (10 minute window)")
            iid = row["item_id"]
            col = "answer_id" if table == "answers" else "comment_id"
            stored = [r[0] for r in conn.execute(
                f"SELECT stored FROM attachments WHERE {col}=? AND kind='file'", (rid,))]
            conn.execute(f"DELETE FROM attachments WHERE {col}=?", (rid,))
            conn.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
            ts = now_iso()
            if table == "answers":
                it = get_item(conn, iid)
                left = conn.execute("SELECT COUNT(*) FROM answers WHERE item_id=?", (iid,)).fetchone()[0]
                if it["status"] == "answered" and not left:
                    conn.execute("UPDATE items SET status='open' WHERE id=?", (iid,))
            if b.get("snoozed_at") is not None:  # restore the pre-submit snooze state
                conn.execute("UPDATE items SET snoozed_at=? WHERE id=?",
                             (norm_iso(b["snoozed_at"]) if b["snoozed_at"] else None, iid))
            # drop the 'answered'/'commented' event this undoes, then record the retraction
            kind = "answered" if table == "answers" else "commented"
            conn.execute("DELETE FROM events WHERE item_id=? AND actor='owner' AND kind=? AND created=?",
                         (iid, kind, row["created"]))
            log_event(conn, iid, "owner", "retracted", f"{table[:-1]} {rid} (undo)", ts)
            touch(conn, iid, "owner", ts)
            reindex(conn, iid)
            conn.commit()
            d = full_item(conn, iid)
        finally:
            conn.close()
    for st in stored:
        try:
            os.remove(os.path.join(FILES, st))
        except OSError:
            pass
    h.send_json(d)


@route("POST", r"/api/answers/(\d+)/retract")
def retract_answer(h, aid):
    _retract(h, "answers", aid)


@route("POST", r"/api/comments/(\d+)/retract")
def retract_comment(h, cid):
    _retract(h, "comments", cid)


@route("GET", r"/api/config")
def config(h):
    h.send_json({"pr_url_base": PR_URL_BASE, "repo": GH_REPO, "commits": bool(GIT_DIR),
                 "commit_url_base": COMMIT_URL_BASE, "issue_url": ISSUE_URL,
                 "issue_prefixes": ISSUE_PREFIXES,
                 "statuses": STATUSES, "priorities": PRIORITIES, "kinds": KINDS})


@route("GET", r"/api/projects")
def projects_rollup(h):
    """One card per project: counts, blocked items, most recent activity."""
    conn = db()
    try:
        obm = open_blockers_map(conn)
        cards = {}
        for r in conn.execute("SELECT id, title, project, kind, status, priority, updated FROM items"):  # noqa
            c = cards.setdefault(r["project"], {
                "project": r["project"],
                "counts": {"open": 0, "waiting": 0, "blocking": 0, "answered": 0,
                           "requested": 0, "todo": 0, "done": 0, "closed": 0, "total": 0},
                "blocked": [], "last": None})
            n = c["counts"]
            n["total"] += 1
            st = r["status"]
            if st == "closed":
                n["closed"] += 1
            elif st == "done":
                n["done"] += 1
            else:
                n["open"] += 1
            if r["kind"] == "todo":
                if st == "open":
                    n["todo"] += 1
            elif st == "open":
                n["waiting"] += 1
                if r["priority"] == "blocking":
                    n["blocking"] += 1
            elif st == "answered":
                n["answered"] += 1
            elif st in ("requested", "in_progress"):
                n["requested"] += 1
            if st not in FINISHED and obm.get(r["id"]):
                c["blocked"].append({"id": r["id"], "title": r["title"], "status": st,
                                     "priority": r["priority"], "open_blockers": obm[r["id"]]})
        for proj, c in cards.items():
            e = conn.execute(
                "SELECT e.item_id, e.actor, e.kind, e.created, i.title FROM events e"
                " JOIN items i ON i.id=e.item_id WHERE i.project=?"
                " ORDER BY e.created DESC, e.id DESC LIMIT 1", (proj,)).fetchone()
            if e:
                c["last"] = {"item_id": e["item_id"], "title": e["title"], "actor": e["actor"],
                             "kind": e["kind"], "created": e["created"]}
        out = list(cards.values())
        # newest activity first within equal urgency
        out.sort(key=lambda c: c["last"]["created"] if c["last"] else "", reverse=True)
        out.sort(key=lambda c: (-c["counts"]["blocking"], -(c["counts"]["waiting"]
                                + c["counts"]["requested"]), c["counts"]["open"] == 0))
        h.send_json({"projects": out, "now": now_iso()})
    finally:
        conn.close()


@route("GET", r"/api/refs/(pr|commit|issue)/([A-Za-z0-9-]{1,64})")
def show_ref(h, rtype, key):
    if rtype == "pr":
        if not key.isdigit():
            raise ApiError(400, "PR number must be numeric")
        key = str(int(key))
    elif rtype == "commit":
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", key):
            raise ApiError(400, "not a commit sha")
        key = resolve_commit(key) or key.lower()
    else:
        key = key.upper()
    conn = db()
    try:
        ids = [r[0] for r in conn.execute(
            "SELECT item_id FROM xrefs WHERE rtype=? AND rkey=? ORDER BY item_id", (rtype, key))]
        if rtype == "commit" and len(key) < 40:  # unresolved: match by prefix
            ids = [r[0] for r in conn.execute(
                "SELECT DISTINCT item_id FROM xrefs WHERE rtype='commit' AND rkey LIKE ?"
                " ORDER BY item_id", (key + "%",))]
        sm = summaries(conn, ids)
        obm = open_blockers_map(conn)
        items = []
        for i in ids:
            if i in sm:
                d = dict(sm[i])
                d["open_blockers"] = obm.get(i, [])
                items.append(d)
        h.send_json({"type": rtype, "key": key, "label": ref_label(rtype, key),
                     "url": ref_url(rtype, key), "known": rtype != "commit" or len(key) == 40,
                     "items": items})
    finally:
        conn.close()


@route("GET", r"/files/(\d+)/[^/]*")
def serve_file(h, aid):
    conn = db()
    try:
        a = conn.execute("SELECT * FROM attachments WHERE id=? AND kind='file'",
                         (int(aid),)).fetchone()
    finally:
        conn.close()
    if not a:
        raise ApiError(404, "no such file")
    path = os.path.realpath(os.path.join(FILES, a["stored"]))
    if not path.startswith(os.path.realpath(FILES) + os.sep) or not os.path.isfile(path):
        raise ApiError(404, "file missing on disk")
    with open(path, "rb") as f:
        data = f.read()
    render, fn = a["render"], a["filename"]
    mode = h.query.get("mode", "")
    headers = {"Content-Security-Policy": FILE_CSP, "Cache-Control": "private, max-age=3600",
               "Cross-Origin-Resource-Policy": "same-origin"}
    disp_name = f"filename=\"{fn}\"; filename*=UTF-8''{quote(fn)}"
    ctype = a["content_type"]
    if render == "image" or (render in ("markdown", "text") and mode == "raw"):
        headers["Content-Disposition"] = "inline; " + disp_name
        if render != "image":
            ctype = "text/plain; charset=utf-8"
    elif render == "html" and mode == "sandbox":
        # Only ever loaded by the app inside <iframe sandbox="">; the CSP sandbox
        # header keeps scripts off even if opened directly.
        headers["Content-Disposition"] = "inline; " + disp_name
    else:
        headers["Content-Disposition"] = "attachment; " + disp_name
    h.send_bytes(data, ctype, headers=headers)


# --- write (assistant + owner) ----------------------------------------------


ID_TOKEN_RE = re.compile(r"^(?:D-?|#)?(\d{1,9})$", re.I)


def parse_ids(vals):
    """Item ids from ints / "D-12" / "#12" / "12, D-13" strings (or lists of them)."""
    if vals is None:
        return []
    if not isinstance(vals, list):
        vals = [vals]
    out = []
    for v in vals:
        if isinstance(v, int) and not isinstance(v, bool):
            out.append(v)
            continue
        for tok in re.split(r"[\s,]+", str(v).strip()):
            if not tok:
                continue
            m = ID_TOKEN_RE.match(tok)
            if not m:
                raise ApiError(400, f"not a desk item id: {tok!r} (use D-12 or 12)")
            out.append(int(m.group(1)))
    return list(dict.fromkeys(out))


def reaches(conn, start, goal):
    """True if goal is reachable from start along blocks edges."""
    seen, stack = set(), [start]
    while stack:
        n = stack.pop()
        if n == goal:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack += [r[0] for r in conn.execute(
            "SELECT dst FROM links WHERE src=? AND kind='blocks'", (n,))]
    return False


def add_block(conn, src, dst, actor, ts):
    """src blocks dst. Returns True if a new edge was made."""
    if src == dst:
        raise ApiError(400, "an item cannot block itself")
    get_item(conn, src)
    get_item(conn, dst)
    if conn.execute("SELECT 1 FROM links WHERE src=? AND dst=? AND kind='blocks'",
                    (src, dst)).fetchone():
        return False
    if reaches(conn, dst, src):
        raise ApiError(400, f"D-{src} blocks D-{dst} would make a cycle")
    conn.execute("INSERT INTO links(src, dst, kind, created) VALUES (?,?,?,?)",
                 (src, dst, "blocks", ts))
    log_event(conn, src, actor, "linked", f"blocks D-{dst}", ts)
    log_event(conn, dst, actor, "linked", f"blocked by D-{src}", ts)
    touch(conn, src, actor, ts)
    touch(conn, dst, actor, ts)
    return True


def remove_block(conn, src, dst, actor, ts):
    cur = conn.execute("DELETE FROM links WHERE src=? AND dst=? AND kind='blocks'", (src, dst))
    if not cur.rowcount:
        raise ApiError(404, f"D-{src} does not block D-{dst}")
    for iid, detail in ((src, f"no longer blocks D-{dst}"), (dst, f"no longer blocked by D-{src}")):
        if conn.execute("SELECT 1 FROM items WHERE id=?", (iid,)).fetchone():
            log_event(conn, iid, actor, "unlinked", detail, ts)
            touch(conn, iid, actor, ts)


def insert_item(conn, f, kind, author, ts, blocks=(), blocked_by=()):
    status = "requested" if kind == "workstream" else "open"
    cur = conn.execute(
        "INSERT INTO items(title, body, tag, project, kind, author, priority, status, options,"
        " multi, created, updated, assistant_activity, owner_seen, due)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (f["title"], f.get("body", ""), f["project"], f["project"], kind, author, f["priority"],
         status, f.get("options", "[]"), f.get("multi", 0), ts, ts, ts,
         ts if author == "owner" else None, f.get("due")),
    )
    iid = cur.lastrowid
    log_event(conn, iid, author, "requested" if author == "owner" else "created", "", ts)
    for dst in blocks:
        add_block(conn, iid, dst, author, ts)
    for src in blocked_by:
        add_block(conn, src, iid, author, ts)
    reindex(conn, iid)
    return iid


@route("POST", r"/api/items")
def create_item(h):
    b = h.json_body()
    f = validate_fields(b, partial=False)
    kind = str(b.get("kind") or "decision")
    if kind not in KINDS:
        raise ApiError(400, f"kind must be one of {KINDS}")
    author = "owner" if b.get("author") == "owner" else "assistant"
    blocks, blocked_by = parse_ids(b.get("blocks")), parse_ids(b.get("blocked_by"))
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            iid = insert_item(conn, f, kind, author, ts, blocks, blocked_by)
            conn.commit()
            d = full_item(conn, iid)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    h.send_json(d, 201)


@route("POST", r"/api/requests")
def create_request(h):
    """Owner opens a workstream: JSON {title, project, body, priority, blocks, blocked_by}
    or multipart with the same fields (blocks/blocked_by repeatable or comma lists) and
    any number of 'file' parts."""
    ctype = h.headers.get("Content-Type", "")
    files = []
    if ctype.startswith("multipart/form-data"):
        fields, files = parse_multipart(ctype, h.read_body(MAX_UPLOAD + 256 * 1024))
        b = {k: v[0] for k, v in fields.items() if k not in ("blocks", "blocked_by")}
        b["blocks"], b["blocked_by"] = fields.get("blocks", []), fields.get("blocked_by", [])
    else:
        b = h.json_body()
    f = validate_fields(b, partial=False)
    blocks, blocked_by = parse_ids(b.get("blocks")), parse_ids(b.get("blocked_by"))
    message_files(files)
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            iid = insert_item(conn, f, "workstream", "owner", ts, blocks, blocked_by)
            for _, fn, data in files:
                aid = store_file(conn, iid, "owner", fn, data, "", ts=ts)
                a = conn.execute("SELECT filename FROM attachments WHERE id=?", (aid,)).fetchone()
                log_event(conn, iid, "owner", "attached", f"file: {a[0]}", ts)
            conn.commit()
            d = full_item(conn, iid)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    h.send_json(d, 201)


@route("POST", r"/api/links")
def create_link(h):
    """{src, dst, kind: "blocks"} (src blocks dst); kind "blocked_by" swaps them."""
    b = h.json_body()
    kind = b.get("kind", "blocks")
    if kind not in ("blocks", "blocked_by"):
        raise ApiError(400, "kind must be blocks or blocked_by (mentions are automatic)")
    try:
        src, dst = parse_ids(b.get("src"))[0], parse_ids(b.get("dst"))[0]
    except IndexError:
        raise ApiError(400, "src and dst are required")
    if kind == "blocked_by":
        src, dst = dst, src
    actor = "owner" if b.get("author") == "owner" else "assistant"
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            made = add_block(conn, src, dst, actor, ts)
            conn.commit()
        finally:
            conn.close()
    h.send_json({"src": src, "dst": dst, "kind": "blocks", "created": made}, 201 if made else 200)


@route("DELETE", r"/api/links/(\d+)/(blocks|blocked_by)/(\d+)")
def delete_link(h, a, kind, b):
    src, dst = (int(a), int(b)) if kind == "blocks" else (int(b), int(a))
    actor = "owner" if h.query.get("author") == "owner" else "assistant"
    with _write_lock:
        conn = db()
        try:
            remove_block(conn, src, dst, actor, now_iso())
            conn.commit()
        finally:
            conn.close()
    h.send_json({"src": src, "dst": dst, "kind": "blocks", "deleted": True})


@route("POST", r"/api/items/(\d+)/claim")
def claim_item(h, iid):
    conn = db()
    try:
        if get_item(conn, int(iid))["kind"] != "workstream":
            raise ApiError(400, "only workstream requests can be claimed")
    finally:
        conn.close()
    set_status(h, iid, "in_progress", "assistant", "claimed")


def update_item_impl(h, iid):
    iid = int(iid)
    b = h.json_body()
    actor = "owner" if b.pop("author", "assistant") == "owner" else "assistant"
    f = validate_fields(b, partial=True)
    if not f:
        raise ApiError(400, "nothing to update")
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            old = get_item(conn, iid)
            sets = ", ".join(f"{k}=?" for k in f)
            conn.execute(f"UPDATE items SET {sets} WHERE id=?", (*f.values(), iid))
            changed = [k for k in f if str(old[k]) != str(f[k])]
            if "status" in changed:
                log_event(conn, iid, actor, "status", f"{old['status']} -> {f['status']}", ts)
            other = [k for k in changed if k not in ("status", "tag")]
            if other:
                log_event(conn, iid, actor, "updated", ", ".join(other), ts)
            touch(conn, iid, actor, ts)
            reindex(conn, iid)
            conn.commit()
            d = full_item(conn, iid)
        finally:
            conn.close()
    h.send_json(d)


route("PATCH", r"/api/items/(\d+)")(update_item_impl)
route("POST", r"/api/items/(\d+)/update")(update_item_impl)


@route("DELETE", r"/api/items/(\d+)")
def delete_item(h, iid):
    iid = int(iid)
    with _write_lock:
        conn = db()
        try:
            get_item(conn, iid)
            stored = [r[0] for r in conn.execute(
                "SELECT stored FROM attachments WHERE item_id=? AND kind='file'", (iid,))]
            for tbl in ("attachments", "answers", "comments", "events", "xrefs"):
                conn.execute(f"DELETE FROM {tbl} WHERE item_id=?", (iid,))
            conn.execute("DELETE FROM links WHERE src=? OR (dst=? AND kind='blocks')", (iid, iid))
            conn.execute("DELETE FROM items WHERE id=?", (iid,))
            conn.commit()
        finally:
            conn.close()
    for s in stored:
        try:
            os.remove(os.path.join(FILES, s))
        except OSError:
            pass
    try:
        os.rmdir(os.path.join(FILES, str(iid)))
    except OSError:
        pass
    h.send_json({"deleted": iid})


@route("POST", r"/api/items/(\d+)/attachments")
def add_attachment(h, iid):
    """JSON {url, label} adds a link; any other body is a raw file upload
    (?filename=...&label=...), or multipart/form-data with a 'file' field."""
    iid = int(iid)
    ctype = h.headers.get("Content-Type", "")
    ts = now_iso()
    author = "owner" if h.query.get("author") == "owner" else "assistant"
    if ctype.startswith("application/json"):
        b = h.json_body()
        url = str(b.get("url") or "").strip()
        if not re.match(r"^https?://", url):
            raise ApiError(400, "link url must be http(s)")
        label = str(b.get("label") or "").strip() or url
        with _write_lock:
            conn = db()
            try:
                get_item(conn, iid)
                cur = conn.execute(
                    "INSERT INTO attachments(item_id, author, kind, label, url, created)"
                    " VALUES (?,?,?,?,?,?)", (iid, author, "link", label[:300], url, ts))
                aid = cur.lastrowid
                log_event(conn, iid, author, "attached", f"link: {label}", ts)
                touch(conn, iid, author, ts)
                reindex(conn, iid)
                conn.commit()
                a = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
            finally:
                conn.close()
        return h.send_json(att_dict(a), 201)
    raw = h.read_body(MAX_UPLOAD + 64 * 1024)
    if ctype.startswith("multipart/form-data"):
        fields, files = parse_multipart(ctype, raw)
        if not files:
            raise ApiError(400, "no file in upload")
        _, fn, data = files[0]
        label = (fields.get("label") or [""])[0]
    else:
        fn = h.query.get("filename") or h.headers.get("X-Filename") or "upload.bin"
        label = h.query.get("label", "")
        data = raw
    if not data:
        raise ApiError(400, "empty upload")
    with _write_lock:
        conn = db()
        try:
            get_item(conn, iid)
            aid = store_file(conn, iid, author, fn, data, label.strip(), ts=ts)
            a = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
            log_event(conn, iid, author, "attached", f"file: {a['filename']}", ts)
            touch(conn, iid, author, ts)
            conn.commit()
        finally:
            conn.close()
    h.send_json(att_dict(a), 201)


def message_files(files):
    """Validate the files sent with one comment/answer/request (pasted images etc.)."""
    if len(files) > MAX_FILES_PER_MESSAGE:
        raise ApiError(400, f"at most {MAX_FILES_PER_MESSAGE} files per message")
    if sum(len(x[2]) for x in files) > MAX_UPLOAD:
        raise ApiError(413, "attachments exceed 25 MB in total for one message")
    return files


def add_comment(h, iid):
    """JSON {body, author}, or multipart with body, author and any number of 'file'
    parts (pasted / dropped images); the files are tied to the comment."""
    iid = int(iid)
    ctype = h.headers.get("Content-Type", "")
    files = []
    if ctype.startswith("multipart/form-data"):
        fields, files = parse_multipart(ctype, h.read_body(MAX_UPLOAD + 256 * 1024))
        b = {k: v[0] for k, v in fields.items()}
    else:
        b = h.json_body()
    message_files(files)
    body = str(b.get("body") or "").strip()
    if not body and not files:
        raise ApiError(400, "comment body is required")
    author = "owner" if b.get("author") == "owner" else "assistant"
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            get_item(conn, iid)
            cur = conn.execute(
                "INSERT INTO comments(item_id, author, body, created) VALUES (?,?,?,?)",
                (iid, author, body, ts))
            cid = cur.lastrowid
            if author == "owner":
                conn.execute("UPDATE items SET snoozed_at=NULL WHERE id=?", (iid,))
            for _, fn, data in files:
                store_file(conn, iid, author, fn, data, "", ts=ts, comment_id=cid)
            log_event(conn, iid, author, "commented",
                      f"{len(files)} file(s)" if files else "", ts)
            touch(conn, iid, author, ts)
            reindex(conn, iid)
            conn.commit()
            c = dict(conn.execute("SELECT * FROM comments WHERE id=?", (cid,)).fetchone())
            c["attachments"] = [att_dict(a) for a in conn.execute(
                "SELECT * FROM attachments WHERE comment_id=? ORDER BY id", (cid,))]
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    h.send_json(c, 201)


route("POST", r"/api/items/(\d+)/comments")(add_comment)


def set_status(h, iid, status, actor, kind):
    iid = int(iid)
    b = h.json_body()
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            old = get_item(conn, iid)
            conn.execute("UPDATE items SET status=? WHERE id=?", (status, iid))
            log_event(conn, iid, actor, kind, f"{old['status']} -> {status}", ts)
            note = str(b.get("comment") or "").strip()
            if note:
                conn.execute(
                    "INSERT INTO comments(item_id, author, body, created) VALUES (?,?,?,?)",
                    (iid, actor, note, ts))
            touch(conn, iid, actor, ts)
            reindex(conn, iid)
            conn.commit()
            d = full_item(conn, iid)
        finally:
            conn.close()
    h.send_json(d)


@route("POST", r"/api/items/(\d+)/close")
def close_item(h, iid):
    actor = "owner" if h.query.get("author") == "owner" else "assistant"
    set_status(h, iid, "closed", actor, "closed")


@route("POST", r"/api/items/(\d+)/done")
def done_item(h, iid):
    """Mark an owner TODO done ({comment} optional). Owner by default; agents pass
    ?author=assistant (e.g. they verified it happened)."""
    actor = "assistant" if h.query.get("author") == "assistant" else "owner"
    conn = db()
    try:
        if get_item(conn, int(iid))["kind"] != "todo":
            raise ApiError(400, "only TODO items can be marked done (use close)")
    finally:
        conn.close()
    set_status(h, iid, "done", actor, "done")


@route("GET", r"/api/todos")
def list_todos(h):
    """Owner checklist: open TODOs (priority, due, oldest) and done ones (newest first)."""
    conn = db()
    try:
        obm = open_blockers_map(conn)
        q, args = "SELECT * FROM items WHERE kind='todo'", []
        if h.query.get("project"):
            q += " AND project=?"
            args.append(h.query["project"])
        open_, done = [], []
        done_at = dict(conn.execute(
            "SELECT item_id, MAX(created) FROM events WHERE kind='done' GROUP BY item_id"))
        for r in conn.execute(q, args):
            d = {k: r[k] for k in ("id", "title", "project", "priority", "status", "due", "created",
                                   "updated", "snoozed_at")}
            d["kind"] = "todo"
            d["open_blockers"] = obm.get(r["id"], [])
            d["n_comments"] = conn.execute("SELECT COUNT(*) FROM comments WHERE item_id=?",
                                           (r["id"],)).fetchone()[0]
            if r["status"] == "open":
                open_.append(d)
            else:
                d["done_at"] = done_at.get(r["id"]) or r["updated"]
                done.append(d)
        open_.sort(key=lambda d: (PRIO_RANK.get(d["priority"], 9), d["due"] or "9999", d["created"]))
        done.sort(key=lambda d: d["done_at"], reverse=True)
        h.send_json({"open": open_, "done": done, "count": len(open_), "now": now_iso()})
    finally:
        conn.close()


@route("POST", r"/api/items/(\d+)/convert")
def convert_item(h, iid):
    """Re-file an item as another kind (e.g. a decision that is really an owner TODO).
    {kind, title?, status?, due?}. Comments, answers and attachments are kept; the
    change is an event and a line in data/conversions-<date>.log."""
    iid = int(iid)
    b = h.json_body()
    kind = b.get("kind")
    if kind not in ("todo", "decision"):
        raise ApiError(400, "kind must be todo or decision")
    allowed = {"todo": ("open", "done", "closed"), "decision": ("open", "answered", "closed")}[kind]
    status = b.get("status") or "open"
    if status not in allowed:
        raise ApiError(400, f"status for a {kind} must be one of {allowed}")
    f = validate_fields({k: b[k] for k in ("title", "due") if k in b}, partial=True)
    actor = "owner" if b.get("author") == "owner" else "assistant"
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            old = get_item(conn, iid)
            if old["kind"] == "workstream":
                raise ApiError(400, "workstream requests can't be converted")
            sets = {"kind": kind, "status": status}
            sets.update(f)
            conn.execute("UPDATE items SET " + ", ".join(f"{k}=?" for k in sets) + " WHERE id=?",
                         (*sets.values(), iid))
            detail = f"{old['kind']} -> {kind}; status {old['status']} -> {status}"
            if "title" in f and f["title"] != old["title"]:
                detail += f"; title was: {old['title']}"
            log_event(conn, iid, actor, "converted", detail, ts)
            touch(conn, iid, actor, ts)
            reindex(conn, iid)
            conn.commit()
            d = full_item(conn, iid)
        finally:
            conn.close()
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with open(os.path.join(DATA, f"conversions-{day}.log"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": ts, "item": f"D-{iid}", "by": actor, "from_kind": old["kind"],
                             "to_kind": kind, "from_status": old["status"], "to_status": status,
                             "old_title": old["title"], "new_title": d["title"], "due": d.get("due"),
                             "answers_kept": len(d["answers"]), "comments_kept": len(d["comments"])},
                            ensure_ascii=False) + "\n")
    h.send_json(d)


@route("POST", r"/api/items/(\d+)/reopen")
def reopen_item(h, iid):
    actor = "assistant" if h.query.get("author") == "assistant" else "owner"
    conn = db()
    try:
        kind = get_item(conn, int(iid))["kind"]
    finally:
        conn.close()
    set_status(h, iid, "requested" if kind == "workstream" else "open", actor, "reopened")


@route("POST", r"/api/items/(\d+)/answer")
def answer_item(h, iid):
    """Owner answer: JSON {choices: [key...], text} or multipart with fields
    choice (repeatable), text, and an optional file."""
    iid = int(iid)
    ctype = h.headers.get("Content-Type", "")
    files = []
    if ctype.startswith("multipart/form-data"):
        fields, files = parse_multipart(ctype, h.read_body(MAX_UPLOAD + 256 * 1024))
        message_files(files)
        choices = fields.get("choice", [])
        text = (fields.get("text") or [""])[0]
    else:
        b = h.json_body()
        choices = b.get("choices") or []
        text = str(b.get("text") or "")
    text = text.strip()
    ts = now_iso()
    with _write_lock:
        conn = db()
        try:
            it = item_row(get_item(conn, iid))
            keys = {o["key"] for o in it["options"]}
            if not isinstance(choices, list) or any(c not in keys for c in choices):
                raise ApiError(400, "unknown option key")
            if not it["multi"] and len(choices) > 1:
                raise ApiError(400, "this item takes a single choice")
            if not choices and not text and not files:
                raise ApiError(400, "pick an option, write an answer, or attach a file")
            cur = conn.execute(
                "INSERT INTO answers(item_id, choices, text, created) VALUES (?,?,?,?)",
                (iid, json.dumps(choices), text, ts))
            ans_id = cur.lastrowid
            for _, fn, data in files:
                store_file(conn, iid, "owner", fn, data, "", answer_id=ans_id, ts=ts)
            conn.execute("UPDATE items SET status='answered', snoozed_at=NULL WHERE id=?", (iid,))
            labels = [o["label"] for o in it["options"] if o["key"] in choices]
            log_event(conn, iid, "owner", "answered", "; ".join(labels), ts)
            touch(conn, iid, "owner", ts)
            reindex(conn, iid)
            conn.commit()
            a = dict(conn.execute("SELECT * FROM answers WHERE id=?", (ans_id,)).fetchone())
            a["choices"] = json.loads(a["choices"])
        finally:
            conn.close()
    h.send_json(a, 201)


def main():
    ap = argparse.ArgumentParser(description="Review Desk server (see README.md)")
    ap.add_argument("--host", default=os.environ.get("RD_HOST", "127.0.0.1"),
                    help="bind address (default 127.0.0.1; env RD_HOST)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("RD_PORT", "8471")),
                    help="port (default 8471; env RD_PORT)")
    ap.add_argument("--data-dir", default=None,
                    help="database + uploads directory (default ./data next to server.py; env RD_DATA_DIR)")
    args = ap.parse_args()
    if args.data_dir:
        set_data_dir(args.data_dir)
    init_db()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"{now_iso()} WARNING: listening on {args.host}. Review Desk has no authentication;"
              " put it behind your own tunnel or auth proxy.", flush=True)
    print(f"{now_iso()} review desk listening on http://{args.host}:{args.port}/ data={DATA}",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
