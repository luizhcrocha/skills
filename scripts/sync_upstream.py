#!/usr/bin/env python3
"""Sync files from the upstreams listed in upstreams.toml, keeping local changes.

For each upstream:
- Only paths named by its `map` sync. Unmapped upstream content is reported
  by unit name (e.g. `skills/tdd`) and never copied.
- Every mapped file is mirrored verbatim to `upstream/<name>/<from path>`;
  mirrored files no longer mapped or gone upstream are deleted. The mirror is
  outside `skills/`, so it never loads as a skill.
- Each map entry's `mode` decides what happens to its `to` path:
  - "merge" (default): a file missing locally is copied in; one changed
    upstream since `base` is 3-way merged (`git merge-file`) into the local
    file, so local edits survive, and real conflicts get conflict markers. A
    file that differs locally with no merge base is skipped. Nothing is
    deleted: files gone upstream are reported.
  - "mirror": the mirror only; `to` is ours and never written.
  - "overlay": `to` becomes exactly upstream's (files gone upstream, or never
    there, are deleted under the mapped folder; files other entries map are
    kept), then its SKILL.md is post-processed from `local/<skill>.md`, where
    <skill> is the folder's basename. That file's frontmatter keys replace
    SKILL.md's same keys (added if missing; `key: ~` removes it); its body is
    our changes, for the agent to read, never copied. One line is appended to
    SKILL.md when there is something to point at:
      Local changes (tstack): [local/<skill>.md](<relative path>) · Names here: <up> → <ours>, ...
    the first part when the local file has a body, the second for each row of
    the `local/NAMES.md` table (upstream name | our name) whose upstream name
    occurs as a whole word in a .md file of the folder. A rerun regenerates
    the same bytes.
    An upstream's `strip` list of regexes is cut from every overlaid .md
    before that (blank-line runs it leaves closed up); the mirror keeps them.
- After a real (not --dry-run) run with no conflicts, `base` in the manifest
  moves to the upstream commit just synced. Mirror and overlay never conflict.

Mapping semantics (`from` is relative to the upstream's `subdir`, `to` to the
repo root): `from` is a path pattern where `*` matches within one path
segment and `**` across segments. It matches a file when it matches the whole
path (file -> file) or a leading directory of it (dir -> dir; the rest of the
path is appended to `to`). `{1}`, `{2}`... in `to` are replaced by what the
wildcards matched, in order. The first matching entry wins.

A `watch = true` upstream is read, never copied: it may not have a `map`. The
report lists its commits and changed files since `base` (`--diff` prints the
diff) so ideas can be reimplemented by hand, as for an unlicensed repo. A real
run marks what it showed as seen by moving `base`, like any other upstream.
"""

from __future__ import annotations

import argparse
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODES = ("merge", "mirror", "overlay")


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True)


def pattern_regex(pattern: str) -> re.Pattern:
    """`pattern` matching a whole path or a leading directory of it."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append("(.*?)")
            i += 2
        elif pattern[i] == "*":
            out.append("([^/]*)")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "(?P<rest>/.+)?$")


@dataclass
class Mapping:
    src: str
    dst: str
    mode: str = "merge"
    regex: re.Pattern = field(init=False)

    def __post_init__(self) -> None:
        self.src = self.src.strip("/")
        self.dst = self.dst.strip("/")
        if ".." in Path(self.dst).parts or Path(self.dst).is_absolute():
            raise SystemExit(f"error: mapping target escapes the repo: {self.dst}")
        if self.mode not in MODES:
            raise SystemExit(f"error: map {self.src}: unknown mode {self.mode!r} (one of {', '.join(MODES)})")
        self.regex = pattern_regex(self.src)

    def target(self, path: str) -> tuple[str, str] | None:
        """(where `path` lands, the mapped root it lies under)."""
        m = self.regex.match(path)
        if not m:
            return None
        dst = self.dst
        for n, value in enumerate(m.groups()[:-1], start=1):
            dst = dst.replace("{%d}" % n, value)
        return dst + (m.group("rest") or ""), dst


@dataclass
class Upstream:
    name: str
    url: str
    base: str
    subdir: str = ""
    branch: str = ""
    maps: list[Mapping] = field(default_factory=list)
    units: list[str] = field(default_factory=list)
    ignore: list[str] = field(default_factory=list)
    watch: bool = False
    strip: list[str] = field(default_factory=list)

    def match(self, path: str) -> tuple[Mapping, str, str] | None:
        """(the first matching entry, the target, its mapped root)."""
        for m in self.maps:
            t = m.target(path)
            if t is not None:
                return m, *t
        return None

    def unit(self, path: str) -> str:
        for u in self.units:
            m = pattern_regex(u).match(path)
            if m:
                return path[: len(path) - len(m.group("rest") or "")]
        return path.split("/", 1)[0]

    def ignored(self, path: str) -> bool:
        return any(pattern_regex(p).match(path) for p in self.ignore)


def load_manifest(path: Path) -> list[Upstream]:
    data = tomllib.loads(path.read_text())
    out = []
    for name, u in data.get("upstream", {}).items():
        out.append(
            Upstream(
                name=name,
                url=u["url"],
                base=u.get("base", ""),
                subdir=u.get("subdir", "").strip("/"),
                branch=u.get("branch", ""),
                maps=[Mapping(m["from"], m["to"], m.get("mode", "merge")) for m in u.get("map", [])],
                units=u.get("units", []),
                ignore=u.get("ignore", []),
                watch=u.get("watch", False),
                strip=u.get("strip", []),
            )
        )
        if out[-1].watch and out[-1].maps:
            raise SystemExit(f"error: {name} is watch-only; its files are never copied, so it takes no map")
    return out


def set_base(manifest: Path, name: str, sha: str) -> None:
    """Rewrite `base = "..."` inside `[upstream.<name>]`, leaving the rest as is."""
    lines = manifest.read_text().splitlines(keepends=True)
    header = re.compile(r"^\s*\[\s*upstream\.%s\s*\]\s*(#.*)?$" % re.escape(name))
    in_section = False
    for i, line in enumerate(lines):
        if re.match(r"^\s*\[", line):
            in_section = bool(header.match(line))
            continue
        if in_section and re.match(r"^\s*base\s*=", line):
            lines[i] = re.sub(r'=\s*"[^"]*"', f'= "{sha}"', line, count=1)
            manifest.write_text("".join(lines))
            return
    raise SystemExit(f"error: no base line for upstream {name} in {manifest}")


@dataclass
class Result:
    head: str = ""
    base: str = ""
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    merged: list[str] = field(default_factory=list)
    conflicted: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    removed_upstream: list[str] = field(default_factory=list)
    mirrored: list[str] = field(default_factory=list)  # "<added|updated|removed> <path>"
    overlaid: list[str] = field(default_factory=list)  # same
    postprocessed: list[str] = field(default_factory=list)
    stale_maps: list[str] = field(default_factory=list)
    unmapped: list[tuple[str, bool]] = field(default_factory=list)  # (unit, new since base)
    commits: list[str] = field(default_factory=list)  # watch: one line per commit since base
    changed: list[str] = field(default_factory=list)  # watch: `git diff --stat` lines
    diff: str = ""  # watch, with --diff


def clone(u: Upstream, dest: Path) -> None:
    args = ["clone", "--quiet"]
    if u.url.startswith(("http://", "https://", "ssh://", "git@")):
        args.append("--filter=blob:none")
    if u.branch:
        args += ["--branch", u.branch]
    git(*args, u.url, str(dest))


def ls_files(clone_dir: Path, rev: str, subdir: str) -> list[str]:
    args = ["ls-tree", "-r", "--name-only", rev]
    if subdir:
        args += ["--", subdir + "/"]
    names = git(*args, cwd=clone_dir).stdout.decode().splitlines()
    cut = len(subdir) + 1 if subdir else 0
    return [n[cut:] for n in names]


def show(clone_dir: Path, rev: str, path: str) -> bytes | None:
    p = git("show", f"{rev}:{path}", cwd=clone_dir, check=False)
    return p.stdout if p.returncode == 0 else None


def write(f: Path, data: bytes, executable: bool) -> None:
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)
    if executable:
        f.chmod(0o755)


def place(root: Path, want: dict[str, tuple[bytes, bool]], scopes: set[str], keep: set[str], dry_run: bool) -> list[str]:
    """The copy step: each `want` path gets its bytes; any other file under a
    `scopes` path, unless in `keep`, is deleted. Returns "<verb> <path>" per change."""
    changes = []
    for path, (data, executable) in sorted(want.items()):
        f = root / path
        if f.is_file() and f.read_bytes() == data:
            continue
        changes.append(f"{'updated' if f.exists() else 'added'} {path}")
        if not dry_run:
            write(f, data, executable)
    for scope in sorted(scopes):
        top = root / scope
        files = [top] if top.is_file() else sorted(p for p in top.rglob("*") if p.is_file())
        for f in files:
            path = f.relative_to(root).as_posix()
            if path not in want and path not in keep:
                changes.append(f"removed {path}")
                if not dry_run:
                    f.unlink()
        if not dry_run and top.is_dir():
            for d in sorted((p for p in top.rglob("*") if p.is_dir()), reverse=True):
                if not any(d.iterdir()):
                    d.rmdir()
    return changes


FM_KEY = re.compile(r"^([A-Za-z0-9_][\w.-]*)\s*:(.*)$")


def frontmatter(text: str) -> tuple[list[str] | None, str]:
    """(the lines inside a leading `---` block, or None; the text after it)."""
    lines = text.splitlines(keepends=True)
    if lines and lines[0].rstrip("\r\n") == "---":
        for i in range(1, len(lines)):
            if lines[i].rstrip("\r\n") == "---":
                return lines[1:i], "".join(lines[i + 1 :])
    return None, text


def fm_entries(lines: list[str]) -> list[tuple[str | None, list[str]]]:
    """`key: value` entries, each with its continuation lines, kept verbatim."""
    out: list[tuple[str | None, list[str]]] = []
    for line in lines:
        m = FM_KEY.match(line)
        if m or not out:
            out.append((m.group(1) if m else None, [line]))
        else:
            out[-1][1].append(line)
    return out


def override(text: str, local_fm: list[str]) -> str:
    """`text` with each local frontmatter key replacing (or, as `~`, removing) its own."""
    over = {k: lines for k, lines in fm_entries(local_fm) if k}
    if not over:
        return text
    gone = {k for k, lines in over.items() if len(lines) == 1 and FM_KEY.match(lines[0]).group(2).strip() == "~"}
    fm, rest = frontmatter(text)
    out = []
    for k, lines in fm_entries(fm or []):
        out += over.pop(k) if k in over else lines
    out = [line for line in out if not ((m := FM_KEY.match(line)) and m.group(1) in gone)]
    out += [line for k, lines in over.items() if k not in gone for line in lines]
    return "---\n" + "".join(out) + "---\n" + rest


def names_table(text: str) -> list[tuple[str, str]]:
    """The (upstream name, our name) rows of a markdown table."""
    rows: list[tuple[str, str]] = []
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-+:?", c) for c in cells):
            rows = rows[:-1]  # the header above the separator
        elif len(cells) >= 2 and cells[0] and cells[1]:
            rows.append((cells[0], cells[1]))
    return rows


def local_line(skill_md: str, skill: str, has_body: bool, names: list[tuple[str, str]]) -> str:
    parts = []
    if has_body:
        rel = posixpath.relpath(f"local/{skill}.md", posixpath.dirname(skill_md))
        parts.append(f"Local changes (tstack): [local/{skill}.md]({rel})")
    if names:
        parts.append("Names here: " + ", ".join(f"{a} → {b}" for a, b in names))
    return " · ".join(parts)


def strip(data: bytes, patterns: list[str]) -> bytes:
    """`data` with every match of the upstream's `strip` patterns cut, blank-line runs left behind closed up."""
    text = data.decode()
    out = text
    for pattern in patterns:
        out = re.sub(pattern, "", out)
    return data if out == text else re.sub(r"\n{3,}", "\n\n", out).encode()


def post_process(root: Path, folder: str, files: dict[str, tuple[bytes, bool]]) -> tuple[str, list[str]]:
    """The overlay folder's SKILL.md with local/<skill>.md applied, and what was applied."""
    skill_md, skill = f"{folder}/SKILL.md", posixpath.basename(folder)
    text = files[skill_md][0].decode()
    local = root / "local" / f"{skill}.md"
    local_fm, body = frontmatter(local.read_text(encoding="utf-8")) if local.is_file() else (None, "")
    names_md = root / "local" / "NAMES.md"
    corpus = "\n".join(
        data.decode(errors="replace") for p, (data, _) in files.items() if p.startswith(folder + "/") and p.endswith(".md")
    )
    names = [
        (a, b) for a, b in (names_table(names_md.read_text(encoding="utf-8")) if names_md.is_file() else [])
        if re.search(r"(?<![\w-])" + re.escape(a) + r"(?![\w-])", corpus)
    ]
    applied = []
    if local_fm:
        text = override(text, local_fm)
        applied.append("frontmatter")
    line = local_line(skill_md, skill, bool(body.strip()), names)
    if line:
        text = text.rstrip("\n") + "\n\n" + line + "\n"
        applied.append("local line")
    return text, applied


def watch(u: Upstream, tmp: Path, with_diff: bool) -> Result:
    up = tmp / u.name
    clone(u, up)
    r = Result(head=git("rev-parse", "HEAD", cwd=up).stdout.decode().strip())
    if u.base and git("cat-file", "-e", f"{u.base}^{{commit}}", cwd=up, check=False).returncode == 0:
        r.base = u.base
    elif u.base:
        print(f"warning: {u.name}: recorded base {u.base} not found upstream; showing all history", file=sys.stderr)
    span = f"{r.base}..HEAD" if r.base else "HEAD"
    paths = ["--", u.subdir + "/"] if u.subdir else []
    r.commits = git("log", "--format=%h %ad %s", "--date=short", span, *paths, cwd=up).stdout.decode().splitlines()
    if r.base and r.commits:
        r.changed = git("diff", "--stat", r.base, "HEAD", *paths, cwd=up).stdout.decode().splitlines()
        if with_diff:
            r.diff = git("diff", r.base, "HEAD", *paths, cwd=up).stdout.decode()
    return r


def sync(u: Upstream, root: Path, tmp: Path, dry_run: bool, list_only: bool) -> Result:
    up = tmp / u.name
    clone(u, up)
    r = Result(head=git("rev-parse", "HEAD", cwd=up).stdout.decode().strip())
    if u.base and git("cat-file", "-e", f"{u.base}^{{commit}}", cwd=up, check=False).returncode == 0:
        r.base = u.base
    elif u.base:
        print(f"warning: {u.name}: recorded base {u.base} not found upstream; treating as first run", file=sys.stderr)

    prefix = f"{u.subdir}/" if u.subdir else ""
    head_files = ls_files(up, "HEAD", u.subdir)
    base_files = set(ls_files(up, r.base, u.subdir)) if r.base else set()

    # Unmapped units, and mapping sanity.
    unit_mapped: dict[str, bool] = {}
    targets: dict[str, tuple[str, Mapping, str]] = {}  # target -> (upstream path, entry, mapped root)
    for f in head_files:
        hit = u.match(f)
        if hit is None and u.ignored(f):
            continue
        unit = u.unit(f)
        unit_mapped[unit] = unit_mapped.get(unit, False) or hit is not None
        if hit is not None:
            m, t, mapped_root = hit
            if t in targets and targets[t][0] != f:
                raise SystemExit(f"error: {u.name}: {targets[t][0]} and {f} both map to {t}")
            targets[t] = (f, m, mapped_root)
    for unit, mapped in sorted(unit_mapped.items()):
        if not mapped:
            new = not any(b == unit or b.startswith(unit + "/") for b in base_files)
            r.unmapped.append((unit, new))
    for m in u.maps:
        if not any(m.target(f) is not None for f in head_files):
            r.stale_maps.append(m.src)
    for f in sorted(base_files - set(head_files)):
        hit = u.match(f)
        if hit is not None and hit[0].mode != "overlay" and (root / hit[1]).exists():
            r.removed_upstream.append(hit[1])
    if list_only:
        return r

    tree = git("ls-tree", "-r", "HEAD", *(["--", prefix] if prefix else []), cwd=up).stdout.decode().splitlines()
    executable = {line.split("\t", 1)[1][len(prefix):] for line in tree if line.startswith("100755")}
    blobs = {src: (show(up, "HEAD", prefix + src), src in executable) for src, _, _ in targets.values()}

    mirror = f"upstream/{u.name}"
    r.mirrored = place(root, {f"{mirror}/{src}": blob for src, blob in blobs.items()}, {mirror}, set(), dry_run)

    overlay = {dst: blobs[src] for dst, (src, m, _) in targets.items() if m.mode == "overlay"}
    folders = {mapped_root for _, m, mapped_root in targets.values() if m.mode == "overlay"}
    if u.strip:
        overlay = {dst: (strip(data, u.strip), x) if dst.endswith(".md") else (data, x) for dst, (data, x) in overlay.items()}
    for folder in sorted(folders):
        if f"{folder}/SKILL.md" in overlay:
            text, applied = post_process(root, folder, overlay)
            if applied:
                overlay[f"{folder}/SKILL.md"] = (text.encode(), overlay[f"{folder}/SKILL.md"][1])
                r.postprocessed.append(f"{folder}/SKILL.md ({', '.join(applied)})")
    r.overlaid = place(root, overlay, folders, set(targets), dry_run)
    changed = {c.split(" ", 1)[1] for c in r.overlaid}
    r.postprocessed = [p for p in r.postprocessed if p.split(" ", 1)[0] in changed]

    merged = sorted((src, dst) for dst, (src, m, _) in targets.items() if m.mode == "merge")
    for src, dst in merged:
        theirs, theirs_executable = blobs[src]
        local = root / dst
        if not local.exists():
            if not dry_run:
                write(local, theirs, theirs_executable)
            r.added.append(dst)
            continue
        mine = local.read_bytes()
        if mine == theirs:
            continue
        base = show(up, r.base, prefix + src) if r.base else None
        if base is None:
            r.skipped.append(dst)
            continue
        if base == theirs:
            continue  # upstream unchanged since last sync; the diff is ours
        if base == mine:
            if not dry_run:
                local.write_bytes(theirs)
            r.updated.append(dst)
            continue
        (tmp / "base").write_bytes(base)
        (tmp / "theirs").write_bytes(theirs)
        p = subprocess.run(
            ["git", "merge-file", "-p", "-L", "local", "-L", "base", "-L", "upstream",
             str(local), str(tmp / "base"), str(tmp / "theirs")],
            capture_output=True,
        )
        if p.returncode < 0 or p.returncode > 127:
            r.conflicted.append(dst + " (unmergeable, left as local)")
            continue
        if not dry_run:
            local.write_bytes(p.stdout)
        (r.conflicted if p.returncode else r.merged).append(dst)
    return r


def report(u: Upstream, r: Result, dry_run: bool, list_only: bool, all_unmapped: bool) -> None:
    where = u.url + (f" ({u.subdir}/)" if u.subdir else "")
    print(f"\n== {u.name}: {where}")
    print(f"   base {r.base[:12] or '(none)'} -> head {r.head[:12]}")

    def section(label: str, items: list[str]) -> None:
        if items:
            print(f"\n  {label}")
            for i in items:
                print(f"    {i}")

    if u.watch:
        print("   watch-only: read for ideas, never copied")
        if not r.commits:
            print("\n  nothing new since base")
            return
        section(f"Commits since base ({len(r.commits)}):", r.commits)
        section("Changed files:", r.changed)
        if r.diff:
            print("\n" + r.diff)
        if dry_run or list_only:
            print("  dry run: base unchanged")
        else:
            print(f"  seen: base -> {r.head[:12]}")
        return

    if not list_only:
        section("Added (new upstream files):", r.added)
        section("Updated (upstream change, no local edits):", r.updated)
        section("Merged (upstream + local changes combined):", r.merged)
        section("CONFLICTED (fix conflict markers by hand):", r.conflicted)
        section("Skipped (local differs, no merge base; review manually):", r.skipped)
        section("Removed upstream (kept locally):", r.removed_upstream)
        section(f"Mirrored to upstream/{u.name}/:", r.mirrored)
        section("Overlaid (exactly upstream's; files not upstream removed):", r.overlaid)
        section("Post-processed from local/:", r.postprocessed)
        section("Stale mappings (match nothing upstream):", r.stale_maps)
    new = [x for x, n in r.unmapped if n]
    if list_only or all_unmapped:
        section(
            f"Unmapped upstream ({len(r.unmapped)}; * = new since base):",
            [x + (" *" if n else "") for x, n in r.unmapped],
        )
    else:
        section("New upstream, unmapped (add a mapping or an ignore):", new)
        if len(r.unmapped) > len(new):
            print(f"\n  ({len(r.unmapped) - len(new)} older unmapped units; see --list-unmapped)")
    if not list_only:
        counts = ", ".join(
            f"{k} {len(getattr(r, k))}" for k in ("added", "updated", "merged", "conflicted", "skipped", "mirrored", "overlaid")
        )
        print(f"\n  {counts}, unmapped {len(r.unmapped)} (new {len(new)})")
        if dry_run:
            print("  dry run: nothing written, base unchanged")
        elif r.conflicted:
            print(f"  base left at {r.base[:12] or '(none)'} (conflicts)")
        else:
            print(f"  base -> {r.head[:12]}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="report what would change; write nothing")
    ap.add_argument("--upstream", action="append", metavar="NAME", help="sync only this upstream (repeatable)")
    ap.add_argument("--list-unmapped", action="store_true", help="only list upstream content no mapping covers")
    ap.add_argument("--all-unmapped", action="store_true", help="in the sync report, list every unmapped unit, not only new ones")
    ap.add_argument("--diff", action="store_true", help="for watch-only upstreams, print the diff since base")
    ap.add_argument("--root", type=Path, default=REPO, help=argparse.SUPPRESS)
    ap.add_argument("--manifest", type=Path, help="default: <root>/upstreams.toml")
    args = ap.parse_args(argv)

    root = args.root.resolve()
    manifest = args.manifest or root / "upstreams.toml"
    upstreams = load_manifest(manifest)
    if args.upstream:
        unknown = set(args.upstream) - {u.name for u in upstreams}
        if unknown:
            raise SystemExit(f"error: unknown upstream(s): {', '.join(sorted(unknown))}")
        upstreams = [u for u in upstreams if u.name in args.upstream]

    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for u in upstreams:
            print(f"Cloning {u.name} ({u.url})...")
            if u.watch:
                r = watch(u, tmp, args.diff)
            else:
                r = sync(u, root, tmp, args.dry_run, args.list_unmapped)
            report(u, r, args.dry_run, args.list_unmapped, args.all_unmapped)
            if not (args.dry_run or args.list_unmapped or r.conflicted) and r.head != u.base:
                set_base(manifest, u.name, r.head)
    if not (args.dry_run or args.list_unmapped):
        print("\nReview with: jj diff (or git diff)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
