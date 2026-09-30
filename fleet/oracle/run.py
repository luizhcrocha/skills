#!/usr/bin/env python3
"""Replay a fleet trace against an implementation, and compare what two implementations did.

    run.py run TRACE [--impl CLI=COMMAND]... [--subst PATH=TOKEN]... [-o RESULTS]
                                    replay TRACE, write one result line per step (stdout by default)
    run.py check TRACE [EXPECTED] [--impl ...] [--subst ...]
                                    replay TRACE and diff against EXPECTED (TRACE's .expected.jsonl
                                    beside it by default); exit 1 at the first divergence
    run.py diff A B                 compare two result files; print the first divergence with context
    run.py record TRACE...          replay each TRACE on the Python oracle and write its .expected.jsonl

A trace is JSON lines (the format is in fleet/SPEC.md, "Oracle traces"): a header, then steps. A `cli`
step is one invocation of one of the fleet's CLIs (`state`, `chat`, `fleets`), with its argv, env
overrides, and the virtual clock it runs at (FLEET_NOW). A `fixture` step writes, appends to,
patches or deletes a file, for what no CLI writes (the user's chat messages come from the page, a
ledger from an older version). Every step runs in one throwaway tree: $W (the work root), $DIR
($W/coordinator, the default dashboard directory), $REGISTRY (FLEET_HOME). Its result is the
exit code, stdout and stderr, and every file of $W and $REGISTRY that the step added, changed or
removed, with paths canonicalised back to those tokens. The clock is pinned, so timestamps need no
masking; the runner's own pid, which a fixture writes as $PID for a registry entry that must read
as alive, reads back as $PID.

An implementation is a command prefix per CLI. The default is the Python oracle,
skills/productivity/coordinator/scripts/*.py; stage 2's binary is given as
`--impl state="fleet state" --impl chat="fleet chat" --impl fleets="fleet fleets"`, plus
`--subst ITS_SKILL_DIR='$SKILL'` for the paths it prints. Stdlib only.
"""
import argparse
import difflib
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SKILL = REPO / "skills" / "productivity" / "coordinator"
CLIS = ("state", "chat", "fleets")
START = "2026-01-05T09:00:00+00:00"  # the clock of a step that names none, before any step named one
STEP_TIMEOUT_S = 20
IGNORED = {"__pycache__", "server.log"}  # never part of the observable state
IGNORED_SUFFIXES = (".pyc", ".tmp")


def python_impl() -> dict:
    """The oracle: the coordinator's Python scripts, run by this interpreter."""
    return {cli: [sys.executable, str(SKILL / "scripts" / f"{cli}.py")] for cli in CLIS}


def python_subst() -> dict:
    return {str(SKILL): "$SKILL"}


class Session:
    """One replay: a throwaway tree, the clock, and what the tree looked like after the last step."""

    def __init__(self, impl: dict | None = None, subst: dict | None = None):
        self.impl = impl or python_impl()
        self._tmp = tempfile.TemporaryDirectory(prefix="fleet-oracle-")
        base = Path(os.path.realpath(self._tmp.name))
        self.w, self.registry, self.home = base / "w", base / "registry", base / "home"
        for d in (self.w, self.registry, self.home):
            d.mkdir()
        self.dir = self.w / "coordinator"
        self.clock = START
        self.pid = str(os.getpid())
        # Longest first, so $DIR wins over $W; the implementation's own paths first of all.
        pairs = {**(subst if subst is not None else python_subst()), str(self.dir): "$DIR", str(self.w): "$W",
                 str(self.registry): "$REGISTRY", str(self.home): "$USERHOME", str(base): "$TMP"}
        self.subst = sorted(pairs.items(), key=lambda kv: -len(kv[0]))
        self.view: dict[str, object] = {}

    def close(self) -> None:
        self._tmp.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- tokens -------------------------------------------------------------------------------
    def expand(self, text: str) -> str:
        """A trace's tokens as this session's paths."""
        for token, value in (("$DIR", self.dir), ("$REGISTRY", self.registry), ("$W", self.w), ("$PID", self.pid)):
            text = text.replace(token, str(value))
        return text

    def canon(self, text: str) -> str:
        """This session's (and the implementation's) paths as tokens."""
        for path, token in self.subst:
            text = text.replace(path, token)
        return text

    def _canon_json(self, value):
        if isinstance(value, str):
            return self.canon(value)
        if isinstance(value, list):
            return [self._canon_json(v) for v in value]
        if isinstance(value, dict):
            out = {k: self._canon_json(v) for k, v in value.items()}
            if "pid" in out and str(out["pid"]) == self.pid:
                out["pid"] = "$PID"
            return out
        return value

    # -- observing ----------------------------------------------------------------------------
    def _read(self, path: Path, rel: str):
        data = path.read_bytes()
        if rel.endswith("index.html"):
            return {"present": True}  # the page is the template around fleets.view(): stage 3's contract
        if rel.endswith(".jsonl"):
            rows = []
            for line in data.split(b"\n"):
                if not line.strip():
                    continue
                try:
                    rows.append(self._canon_json(json.loads(line.decode("utf-8"))))
                except (ValueError, UnicodeDecodeError):
                    rows.append({"raw": self.canon(line.decode("utf-8", "replace"))})
            if data and not data.endswith(b"\n"):
                rows.append({"torn": True})
            return rows
        if rel.endswith(".json"):
            try:
                return self._canon_json(json.loads(data.decode("utf-8")))
            except (ValueError, UnicodeDecodeError):
                pass
        try:
            return self.canon(data.decode("utf-8"))
        except UnicodeDecodeError:
            return {"sha256": hashlib.sha256(data).hexdigest()}

    def observe(self) -> dict:
        found = {}
        for root in (self.w, self.registry):
            for path in sorted(root.rglob("*")):
                if not path.is_file() or IGNORED & set(path.parts) or path.name.endswith(IGNORED_SUFFIXES) \
                        or path.name.endswith(".pid"):
                    continue
                rel = self.canon(str(path))
                found[rel] = self._read(path, rel)
        return found

    def _delta(self) -> tuple[dict, list]:
        now = self.observe()
        changed = {k: v for k, v in now.items() if self.view.get(k, object()) != v}
        removed = sorted(k for k in self.view if k not in now)
        self.view = now
        return changed, removed

    # -- stepping -----------------------------------------------------------------------------
    def env(self, step: dict) -> dict:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.home), "TZ": "UTC", "LANG": "C.UTF-8",
               "FLEET_HOME": str(self.registry), "FLEET_DISCOVER": "0", "CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
               "XDG_STATE_HOME": str(self.home / ".local" / "state"), "PYTHONDONTWRITEBYTECODE": "1",
               "FLEET_NOW": self.clock}
        for key, value in (step.get("env") or {}).items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = self.expand(str(value))
        return env

    def apply(self, step: dict) -> dict:
        """Run one step; its result, as a result line holds it."""
        if step.get("clock"):
            self.clock = step["clock"]
        if "cli" in step:
            result = self._cli(step)
        elif "fixture" in step:
            self._fixture(step)
            result = {}
        else:
            raise ValueError(f"a step is a `cli` or a `fixture` step: {step}")
        changed, removed = self._delta()
        result.update(changed=changed)
        if removed:
            result["removed"] = removed
        return result

    def _cli(self, step: dict) -> dict:
        if step["cli"] not in self.impl:
            raise ValueError(f"no implementation of the {step['cli']!r} CLI; give --impl {step['cli']}=COMMAND")
        argv = self.impl[step["cli"]] + [self.expand(a) for a in step.get("argv", [])]
        try:
            done = subprocess.run(argv, capture_output=True, env=self.env(step), cwd=str(self.w),
                                  input=self.expand(step.get("stdin", "")).encode(), timeout=step.get("timeout", STEP_TIMEOUT_S))
            code, out, err = done.returncode, done.stdout, done.stderr
        except subprocess.TimeoutExpired as exc:
            code, out, err = "timeout", exc.stdout or b"", exc.stderr or b""
        return {"exit": code, "stdout": self.canon(out.decode("utf-8", "replace")),
                "stderr": self.canon(err.decode("utf-8", "replace"))}

    def _fixture(self, step: dict) -> None:
        path = Path(self.expand(step["path"]))
        kind = step["fixture"]
        if kind == "delete":
            path.unlink(missing_ok=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        if kind == "patch":  # top-level keys of a JSON object: `set` them, `unset` them
            value = json.loads(path.read_text(encoding="utf-8"))
            value.update(json.loads(self.expand(json.dumps(step.get("set") or {}))))
            for key in step.get("unset") or []:
                value.pop(key, None)
            path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            return
        content = self.expand(step["content"]) if isinstance(step.get("content"), str) \
            else json.dumps(json.loads(self.expand(json.dumps(step["content"]))), ensure_ascii=False) + "\n"
        with open(path, "a" if kind == "append" else "w", encoding="utf-8") as f:
            f.write(content)


# -- traces and results --------------------------------------------------------------------------
def read_lines(path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def split(trace: list[dict]) -> tuple[dict, list[dict]]:
    """The header (the first line when it has `trace`) and the steps."""
    if trace and "trace" in trace[0]:
        return trace[0], trace[1:]
    return {"trace": 1}, trace


def replay(trace: list[dict], impl: dict | None = None, subst: dict | None = None) -> list[dict]:
    header, steps = split(trace)
    lines = [{"results": header.get("name") or "", "trace": 1}]
    with Session(impl, subst) as s:
        for i, step in enumerate(steps, 1):
            lines.append({"step": i, **s.apply(step)})
    return lines


def write_lines(lines: list[dict], out) -> None:
    for line in lines:
        out.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + "\n")


# -- diffing -------------------------------------------------------------------------------------
def _first_path(a, b, at="") -> str | None:
    """The first JSON path where a and b differ, or None."""
    if type(a) is not type(b):
        return at or "."
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{at}.{k}"
            found = _first_path(a[k], b[k], f"{at}.{k}")
            if found:
                return found
        return None
    if isinstance(a, list):
        for i, (x, y) in enumerate(zip(a, b)):
            found = _first_path(x, y, f"{at}[{i}]")
            if found:
                return found
        return f"{at}[{min(len(a), len(b))}]" if len(a) != len(b) else None
    return None if a == b else (at or ".")


def _pretty(value) -> list[str]:
    return (value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)).splitlines()


def divergence(a: list[dict], b: list[dict], steps: list[dict] | None = None, names=("A", "B"), context: int = 3) -> str | None:
    """The first step at which two result files differ, told with the steps before it; None when they agree."""
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else None
        y = b[i] if i < len(b) else None
        if x is not None and y is not None and "results" in x and "results" in y:
            continue
        if x == y:
            continue
        out = []
        n = (x or y or {}).get("step", i)
        if steps:
            out.append("steps before and at the divergence:")
            for j in range(max(1, n - context), n + 1):
                if j - 1 < len(steps):
                    out.append(f"  {'>' if j == n else ' '} #{j} {json.dumps(steps[j - 1], ensure_ascii=False)}")
        if x is None or y is None:
            out.append(f"step {n}: only {names[0] if y is None else names[1]} has a result")
            return "\n".join(out)
        out.append(f"step {n} diverges at {_first_path(x, y)}")
        for key in ("exit", "stdout", "stderr", "removed"):
            if x.get(key) != y.get(key):
                out.append(f"--- {key}")
                out += difflib.unified_diff(_pretty(x.get(key, "")), _pretty(y.get(key, "")), names[0], names[1], lineterm="", n=2)
        cx, cy = x.get("changed", {}), y.get("changed", {})
        for f in sorted(set(cx) | set(cy)):
            if cx.get(f) != cy.get(f):
                out.append(f"--- file {f}: first difference at {_first_path(cx.get(f), cy.get(f))}")
                out += list(difflib.unified_diff(_pretty(cx.get(f, "(unchanged)")), _pretty(cy.get(f, "(unchanged)")),
                                                 names[0], names[1], lineterm="", n=3))[:60]
        return "\n".join(out)
    return None


# -- CLI -----------------------------------------------------------------------------------------
def _pairs(values: list[str], what: str) -> dict:
    out = {}
    for v in values or []:
        key, eq, rest = v.partition("=")
        if not eq:
            sys.exit(f"run.py: {what} takes KEY=VALUE, got {v!r}")
        out[key] = rest
    return out


def impl_of(args) -> tuple[dict, dict]:
    impl = python_impl()
    given = {k: shlex.split(v) for k, v in _pairs(args.impl, "--impl").items()}
    impl.update(given)
    subst = python_subst() if not given else {}
    subst.update({k: v for k, v in _pairs(args.subst, "--subst").items()})
    return impl, subst


def expected_of(trace: str) -> Path:
    p = Path(trace)
    return p.with_name(p.name.removesuffix(".jsonl") + ".expected.jsonl")


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("run", "check"):
        s = sub.add_parser(name)
        s.add_argument("trace")
        if name == "check":
            s.add_argument("expected", nargs="?")
        s.add_argument("--impl", action="append", metavar="CLI=COMMAND")
        s.add_argument("--subst", action="append", metavar="PATH=TOKEN")
        if name == "run":
            s.add_argument("-o", "--out")
    s = sub.add_parser("diff"); s.add_argument("a"); s.add_argument("b")
    s = sub.add_parser("record"); s.add_argument("trace", nargs="+")
    args = p.parse_args(argv)

    if args.cmd == "record":
        for t in args.trace:
            with open(expected_of(t), "w", encoding="utf-8") as f:
                write_lines(replay(read_lines(t)), f)
            print(f"recorded {expected_of(t)}")
        return 0
    if args.cmd == "diff":
        found = divergence(read_lines(args.a), read_lines(args.b), names=(args.a, args.b))
        print(found or "no divergence")
        return 1 if found else 0
    impl, subst = impl_of(args)
    trace = read_lines(args.trace)
    got = replay(trace, impl, subst)
    if args.cmd == "run":
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                write_lines(got, f)
        else:
            write_lines(got, sys.stdout)
        return 0
    expected = read_lines(args.expected or expected_of(args.trace))
    # A result line goes through JSON once on its way to disk; compare like with like.
    got = json.loads(json.dumps(got, ensure_ascii=False))
    found = divergence(expected, got, split(trace)[1], names=("expected", "got"))
    print(found or f"{args.trace}: {len(got) - 1} steps, no divergence")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
