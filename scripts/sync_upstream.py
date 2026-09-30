#!/usr/bin/env python3
"""Sync files from the upstreams listed in upstreams.toml, keeping local changes.

For each upstream:
- Only paths named by its `map` sync. Unmapped upstream content is reported
  by unit name (e.g. `skills/tdd`) and never copied.
- A mapped file missing locally is copied in.
- A mapped file changed upstream since the recorded `base` commit is 3-way
  merged (`git merge-file`) into the local file, so local edits survive. Real
  conflicts get standard conflict markers for manual resolution.
- A mapped file that differs locally with no merge base is left alone and
  reported as skipped.
- Nothing is ever deleted locally.
- After a real (not --dry-run) run with no conflicts, `base` in the manifest
  moves to the upstream commit just synced.

Mapping semantics (`from` is relative to the upstream's `subdir`, `to` to the
repo root): `from` is a path pattern where `*` matches within one path
segment and `**` across segments. It matches a file when it matches the whole
path (file -> file) or a leading directory of it (dir -> dir; the rest of the
path is appended to `to`). `{1}`, `{2}`... in `to` are replaced by what the
wildcards matched, in order. The first matching entry wins.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


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
    regex: re.Pattern = field(init=False)

    def __post_init__(self) -> None:
        self.src = self.src.strip("/")
        self.dst = self.dst.strip("/")
        if ".." in Path(self.dst).parts or Path(self.dst).is_absolute():
            raise SystemExit(f"error: mapping target escapes the repo: {self.dst}")
        self.regex = pattern_regex(self.src)

    def target(self, path: str) -> str | None:
        m = self.regex.match(path)
        if not m:
            return None
        dst = self.dst
        for n, value in enumerate(m.groups()[:-1], start=1):
            dst = dst.replace("{%d}" % n, value)
        return dst + (m.group("rest") or "")


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

    def target(self, path: str) -> str | None:
        for m in self.maps:
            t = m.target(path)
            if t is not None:
                return t
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
                maps=[Mapping(m["from"], m["to"]) for m in u.get("map", [])],
                units=u.get("units", []),
                ignore=u.get("ignore", []),
            )
        )
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
    stale_maps: list[str] = field(default_factory=list)
    unmapped: list[tuple[str, bool]] = field(default_factory=list)  # (unit, new since base)


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
    targets: dict[str, str] = {}
    for f in head_files:
        t = u.target(f)
        if t is None and u.ignored(f):
            continue
        unit = u.unit(f)
        unit_mapped[unit] = unit_mapped.get(unit, False) or t is not None
        if t is not None:
            if t in targets and targets[t] != f:
                raise SystemExit(f"error: {u.name}: {targets[t]} and {f} both map to {t}")
            targets[t] = f
    for unit, mapped in sorted(unit_mapped.items()):
        if not mapped:
            new = not any(b == unit or b.startswith(unit + "/") for b in base_files)
            r.unmapped.append((unit, new))
    for m in u.maps:
        if not any(m.target(f) is not None for f in head_files):
            r.stale_maps.append(m.src)
    for f in sorted(base_files - set(head_files)):
        t = u.target(f)
        if t is not None and (root / t).exists():
            r.removed_upstream.append(t)
    if list_only:
        return r

    for dst, src in sorted(targets.items(), key=lambda kv: kv[1]):
        theirs = show(up, "HEAD", prefix + src)
        local = root / dst
        if not local.exists():
            if not dry_run:
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(theirs)
                mode = git("ls-tree", "HEAD", "--", prefix + src, cwd=up).stdout.split()[0]
                if mode == b"100755":
                    local.chmod(0o755)
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

    if not list_only:
        section("Added (new upstream files):", r.added)
        section("Updated (upstream change, no local edits):", r.updated)
        section("Merged (upstream + local changes combined):", r.merged)
        section("CONFLICTED (fix conflict markers by hand):", r.conflicted)
        section("Skipped (local differs, no merge base; review manually):", r.skipped)
        section("Removed upstream (kept locally):", r.removed_upstream)
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
            f"{k} {len(getattr(r, k))}" for k in ("added", "updated", "merged", "conflicted", "skipped")
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
            r = sync(u, root, tmp, args.dry_run, args.list_unmapped)
            report(u, r, args.dry_run, args.list_unmapped, args.all_unmapped)
            if not (args.dry_run or args.list_unmapped or r.conflicted) and r.head != u.base:
                set_base(manifest, u.name, r.head)
    if not (args.dry_run or args.list_unmapped):
        print("\nReview with: jj diff (or git diff)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
