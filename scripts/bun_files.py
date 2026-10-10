#!/usr/bin/env python3
"""Run a bun test suite one file per process, N at a time: `bun test` without `--parallel`'s worker pool.

    bun_files.py [-j N] [--timeout S] [--root DIR] [-v] [-- BUN_TEST_ARGS...]

Run from the package (the directory with bunfig.toml). The files are bun's test files under --root (bunfig's
[test] root): `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. Each runs as `bun test BUN_TEST_ARGS ./FILE` in
its own process and session (run_limits.run_limited), so each file gets a fresh global, as `--parallel` (which
implies `--isolate`) gave it. Each file's output is printed whole when it ends (with -v always, else when it
failed), then the totals. Exit 0 when every file passed, 1 otherwise. SIGTERM, SIGINT or SIGHUP is sent on to
every running file's group, which is killed a second later if still there, and the runner exits 128+signal at
once: the files' sessions are their own, so a kill of the runner's group (scripts/gates' timeout, Ctrl-C) does
not reach them otherwise.

Why not `bun test --parallel`: on Bun 1.4.2 a worker's `spawnSync` loses its child's exit and the worker spins
at 100% CPU forever with the child a zombie (oven-sh/bun#34069; fixed on main after 1.4.2). `--isolate`, which
`--parallel` implies, makes it far more likely: the GC finalizes the finished files' stdio sinks inside a
spawnSync call and moves the private loop's poll count. On 2026-10-09 four `bun test --parallel=4` runs of
fleet/ at once wedged in 5 of 12 runs, and in the gate ws.test.ts held test-fleet-ts-own until its limit.
`--no-isolate` avoids it but fails 483 of fleet's 513 tests, which need a fresh global per file.

The backstop: a file whose process keeps one zombie child for WEDGE_S seconds while it spins (at least SPIN of a
core over that time) is that wedge. Zombies alone are not: preview.test.ts's async dev servers lie unreaped while
the loop is busy, a new one as an old one goes, and the first version of this check killed it. The wedge is killed and
run once more in a fresh process, and the report shows both runs. The rerun decides only when the wedged run had
failed no test before it wedged: a failure stays a failure whatever the rerun does. A second wedge, a test failure
or the per-file --timeout fails the file. N is $TSTACK_TEST_JOBS (run_limits.env_jobs()), else 4, never above 4.
"""
import argparse
import os
import re
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_limits import TIMEOUT, env_jobs, run_limited, stop_live  # noqa: E402
from unittest_shards import load_cache, save_cache  # noqa: E402

TEST_FILE = re.compile(r"(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$")
WEDGE_S = 20.0  # one zombie child held this long, while spinning: spawnSync lost its exit (a healthy one reaps at once)
SPIN = 0.5  # the share of a core the process burned over those seconds: the wedge spins at 80-100%
MOST = 4  # bun test --parallel's old fixed count; more was no faster (2026-10-09)
BUN = ("bun", "test")
COUNT = re.compile(r"^\s*(\d+) (pass|fail|skip|todo)$", re.M)
FAILED_TEST = re.compile(r"^(\(fail\)|✗) |^# Unhandled error between tests", re.M)  # bun's lines as a test fails
STOP_GRACE = 1.0  # seconds a file's group has after the runner's signal before SIGKILL


def files(root: Path) -> list[str]:
    return sorted(str(p) for p in root.rglob("*") if p.is_file() and TEST_FILE.search(p.name)
                  and "node_modules" not in p.parts)


def jobs() -> int:
    return min(MOST, env_jobs() or MOST)


def _cpu_s(pid: int) -> float | None:
    """The CPU seconds `pid` has used, user and system."""
    try:
        rest = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except OSError:
        return None
    return (int(rest[11]) + int(rest[12])) / os.sysconf("SC_CLK_TCK")


def _zombie_children(pid: int) -> dict[str, str]:
    """The zombie children of `pid`: their pid -> "name (pid)"."""
    out, kids = {}, []
    try:
        for task in Path(f"/proc/{pid}/task").iterdir():  # a child belongs to the thread that spawned it
            kids += (task / "children").read_text().split()
    except OSError:
        return out
    for kid in kids:
        try:
            stat = Path(f"/proc/{kid}/stat").read_text()
        except OSError:
            continue
        name, rest = stat[stat.index("(") + 1:stat.rindex(")")], stat[stat.rindex(")") + 2:]
        if rest.split()[0] == "Z":
            out[kid] = f"{name} ({kid})"
    return out


class Wedge:
    """run_limited's watch for one file: its reason when a zombie child has been held WEDGE_S seconds while the
    process spun (Bun's spawnSync wedge), else None."""

    def __init__(self) -> None:
        self.seen: dict[str, tuple[float, float | None]] = {}  # zombie pid -> (when first seen, the CPU seconds then)

    def __call__(self, proc: subprocess.Popen) -> str | None:
        now, cpu = time.monotonic(), _cpu_s(proc.pid)
        zombies = _zombie_children(proc.pid)
        self.seen = {z: self.seen.get(z, (now, cpu)) for z in zombies}
        for z, (since, cpu_then) in self.seen.items():
            if now - since >= WEDGE_S and cpu is not None and cpu_then is not None and cpu - cpu_then >= SPIN * (now - since):
                return (f"its child {zombies[z]} stayed a zombie for {now - since:.0f}s while it spun "
                        f"({cpu - cpu_then:.0f} CPU seconds)")
        return None


def run_file(path: str, args: list[str], limit: float) -> tuple[str, int, str, str]:
    """Run one file: (path, exit code, verdict, output). verdict is ok, failed, wedged or timed out."""
    code, stopped, _, out = run_limited([*BUN, *args, f"./{path}"], limit, watch=Wedge(), grace=0)
    if stopped is None:
        return path, code, "ok" if code == 0 else "failed", out
    verdict, why = ("timed out", f"still running after {limit:g}s") if stopped == TIMEOUT else ("wedged", stopped)
    return path, code or 1, verdict, out + f"bun_files: {path} {verdict}: {why}; killed\n"


def run_with_retry(path: str, args: list[str], limit: float) -> tuple[str, int, str, str, float]:
    t0 = time.monotonic()
    path, code, verdict, out = run_file(path, args, limit)
    if verdict == "wedged":  # oven-sh/bun#34069: once more, in a fresh process
        first, failed_first = out, bool(FAILED_TEST.search(out))
        path, code, again, out = run_file(path, args, limit)
        out = first + f"bun_files: {path} ran again after Bun's spawnSync wedge (oven-sh/bun#34069)\n" + out
        if failed_first:
            verdict, code = f"failed, then wedged; the rerun {again}", 1
            out += f"bun_files: {path} failed a test before it wedged, so it fails whatever the rerun did\n"
        else:
            verdict = "ok after a wedge" if again == "ok" else again
    return path, code, verdict, out, time.monotonic() - t0


def _stop(signum: int, _frame) -> None:
    """SIGTERM, SIGINT or SIGHUP: pass it on to the running files' groups, kill what stays, and exit now."""
    print(f"\nbun_files: {signal.Signals(signum).name}: stopping the files still running", flush=True)
    stop_live(signum, STOP_GRACE)
    sys.stdout.flush()
    os._exit(128 + signum)


def main(argv: list[str]) -> int:
    if "--" in argv:
        i = argv.index("--")
        argv, bun_args = argv[:i], argv[i + 1:]
    else:
        bun_args = []
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-j", "--jobs", type=int, default=None, help=f"files at once (default $TSTACK_TEST_JOBS, else {MOST}; at most {MOST})")
    p.add_argument("--timeout", type=float, default=150, help="seconds a file may run (default 150)")
    p.add_argument("--root", default="test", help="where the test files are (bunfig's [test] root; default test)")
    p.add_argument("-v", "--verbose", action="store_true", help="print every file's output, not only a failed one's")
    args = p.parse_args(argv)

    t0 = time.monotonic()
    found = files(Path(args.root))
    if not found:
        print(f"bun_files: no test files under {args.root}")
        return 1
    n = min(MOST, args.jobs) if args.jobs else jobs()
    where = os.path.relpath(os.getcwd(), Path(__file__).resolve().parent.parent)
    cache = load_cache()
    found.sort(key=lambda f: cache.get(f"bun:{where}:{f}", 1.0), reverse=True)
    print(f"bun_files: {len(found)} files, {n} at a time, `bun test {' '.join(bun_args)}` each", flush=True)
    totals = {"pass": 0, "fail": 0, "skip": 0, "todo": 0}
    bad, wedges, durations = [], [], {}
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    before = [signal.signal(sig, _stop) for sig in signals]
    try:
        with ThreadPoolExecutor(max(1, n)) as pool:
            for fut in as_completed([pool.submit(run_with_retry, f, bun_args, args.timeout) for f in found]):
                path, code, verdict, out, secs = fut.result()
                durations[f"bun:{where}:{path}"] = round(secs, 2)
                counts = {kind: int(num) for num, kind in COUNT.findall(out)}
                for k in totals:
                    totals[k] += counts.get(k, 0)
                if "wedge" in verdict:
                    wedges.append(path)
                print(f"--- {path}: {verdict} ({counts.get('pass', 0)} pass, {counts.get('fail', 0)} fail, {secs:.1f}s)",
                      flush=True)
                if code != 0 or args.verbose or verdict != "ok":
                    sys.stdout.write(out if out.endswith("\n") or not out else out + "\n")
                if code != 0:
                    bad.append(f"{path} ({verdict})")
    finally:
        for sig, handler in zip(signals, before):
            signal.signal(sig, handler)
    save_cache(durations)
    print("-" * 70)
    print(f"{totals['pass']} pass, {totals['fail']} fail, {totals['skip']} skip across {len(found)} files "
          f"in {time.monotonic() - t0:.1f}s")
    if wedges:
        print(f"bun_files: Bun's spawnSync wedge (oven-sh/bun#34069) killed and reran: {', '.join(wedges)}")
    if bad:
        print("FAILED: " + ", ".join(bad))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
