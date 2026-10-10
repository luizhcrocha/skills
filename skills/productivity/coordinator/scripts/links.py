"""What a link is to the user: its kind as people recognise it, where it can be reached from, and the
hub path a `file://` link is served at (the TypeScript fleet's `ledger/links.ts`).

Kinds: `preview` (the fleet's live preview of the app), `prototype` (a throwaway sketch or round), `doc`
(a design note, a report, an artifact), `tool` (a page the user works in: marking, confirming gold),
`service` (a lab or infra endpoint). A row recorded before them says `dev` or `page`, and is read at
display time, never rewritten: a claude.ai artifact is a doc, an address with `/prototipo` or
`prototype` in it (or a title that says prototype) is a prototype, else `dev` reads as preview and
`page` as doc.
"""
import os
import re
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

KINDS = ["preview", "prototype", "doc", "tool", "service"]
OLD_KINDS = ["dev", "page"]  # what a link recorded before KINDS says; `--kind` still takes them
WORDS = {"preview": "Preview", "prototype": "Prototype", "doc": "Doc", "tool": "Tool", "service": "Service"}

ARTIFACT_RE = re.compile(r"^https?://(?:www\.)?claude\.ai/(?:code/)?artifacts?/", re.I)
PROTOTYPE_URL_RE = re.compile(r"/prot[oó]tipo|prototype", re.I)
PROTOTYPE_TITLE_RE = re.compile(r"\bprototypes?\b|\bprot[oó]tipos?\b", re.I)
FILE_RE = re.compile(r"^file://([^/]*)(/[^?#]*)", re.I)


def kind_of(kind, url: str, title) -> str:
    """The kind of a link with stored `kind`, address `url` and `title`, as the user sees it."""
    if kind in KINDS:
        return kind
    if ARTIFACT_RE.search(url):
        return "doc"
    if PROTOTYPE_URL_RE.search(url) or PROTOTYPE_TITLE_RE.search(title or ""):
        return "prototype"
    return "doc" if kind == "page" or url.lower().startswith("file:") else "preview"


def on_tailnet(host) -> bool:
    """Whether `host` is this machine or a host of its tailnet."""
    if not host:
        return False
    h = host.lower()
    if h in ("localhost", "::1", "0.0.0.0") or h.endswith(".localhost") or h.endswith(".ts.net"):
        return True
    ip = re.fullmatch(r"(\d+)\.(\d+)\.\d+\.\d+", h)
    if not ip:
        return False
    a, b = int(ip.group(1)), int(ip.group(2))
    return a == 127 or (a == 100 and 64 <= b <= 127)


def reach_of(url: str) -> str:
    """Where `url` can be reached from: `machine` (this machine or its tailnet, probed), `external` (never probed),
    `file` (a file on this machine)."""
    parts = urlsplit(url)
    if parts.scheme.lower() == "file":
        return "file"
    try:
        host = parts.hostname
    except ValueError:
        host = None
    return "machine" if parts.scheme.lower() in ("http", "https") and on_tailnet(host) else "external"


def file_path_of(url: str) -> str | None:
    """The path a `file://` address names, normalised; None for any other address or a remote host."""
    m = FILE_RE.match(url)
    if not m or m.group(1).lower() not in ("", "localhost"):
        return None
    return os.path.normpath(unquote(m.group(2), errors="strict")) if _decodes(m.group(2)) else None


def _decodes(text: str) -> bool:
    try:
        unquote(text, errors="strict")
        return True
    except UnicodeDecodeError:
        return False


def files_root(dir_: str) -> str:
    """Where a fleet's files may be served from: its state dir, DIR's parent when that is a session's scratchpad
    or a directory of its own under the state home (~/.local/state/<name>), else DIR itself."""
    parent = os.path.dirname(dir_)
    state_home = os.environ.get("XDG_STATE_HOME") or os.path.join(os.environ.get("HOME", ""), ".local", "state")
    return parent if os.path.basename(parent) == "scratchpad" or (parent.startswith(state_home + os.sep) and parent != state_home) else dir_


def served_rel(root: str, path: str) -> str | None:
    """`path` relative to `root`, its parts URI-encoded, when it lies under `root` with no part hidden; else None."""
    rel = os.path.relpath(path, root)
    if rel == "." or rel.startswith("..") or os.path.isabs(rel):
        return None
    parts = rel.split(os.sep)
    if any(p == "" or p.startswith(".") for p in parts):
        return None
    return "/".join(quote(p, safe="!*'()") for p in parts)
