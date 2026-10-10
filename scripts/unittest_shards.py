#!/usr/bin/env python3
"""Run a unittest suite in parallel: `python3 -m unittest discover`, sharded across worker processes.

    unittest_shards.py -s DIR [-p PATTERN] [-j N] [-v]

The tests are discovered as `unittest discover -s DIR -p PATTERN` finds them, cut into units (a test
class; a class of more than CHUNK tests with no class or module fixture is cut into chunks of CHUNK),
and each unit runs in a fresh `python3` process, at most N at a time, the slowest first. A worker loads
its tests by id, so a module whose tests an id cannot rebuild runs whole, as one unit: one that defines
`load_tests` (its tests may carry state on the instance, a parameter, that loading by id would drop), or
one holding a test whose id is not module.Class.method or is not unique. Each unit's
output is printed whole when it ends (with -v always, else only when it failed), then the totals in
unittest's own words: `Ran N tests in Xs`, then `OK` or `FAILED (failures=a, errors=b)`. Exit 0 when
every test passed, 1 when one failed, 5 when none was found (unittest's code).

N is the cap `jobs()` gives: $TSTACK_TEST_JOBS when set (run_limits.env_jobs(); scripts/gates sets it), else a
quarter of the cores, at most one per MB_PER_JOB of available memory. "Slowest first" reads the
durations of the last run from $XDG_CACHE_HOME/tstack/unittest-durations.json, a hint only.

TMPDIR: when it is not set, the run takes a fresh directory on a tmpfs (tmp_root()) and removes it
after, even on SIGTERM, SIGINT or SIGHUP, since the tests' jj and git repos and SQLite files fsync, and on the btrfs disk those fsyncs
were most of the suites' wall time (2026-10-09: test_memo's model test and janitor_audit 64 s on disk,
20 s on tmpfs). Stdlib only.
"""
import argparse
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_limits import env_jobs  # noqa: E402

CHUNK = 8  # tests per unit when a class is cut
MB_PER_JOB = 250  # what one worker may hold: a bun test worker ~200 MB, a shard with the CLIs it spawns ~60 MB (2026-10-09)
CACHE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "tstack" / "unittest-durations.json"


def _meminfo_mb(field: str) -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith(f"{field}:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def mem_available_mb() -> int | None:
    return _meminfo_mb("MemAvailable")


def mem_total_mb() -> int | None:
    return _meminfo_mb("MemTotal")


def jobs(mb_per_job: int = MB_PER_JOB) -> int:
    """Worker processes for one suite: $TSTACK_TEST_JOBS, else cores/4, at most one per mb_per_job of available memory."""
    if given := env_jobs():
        return given
    n = max(2, (os.cpu_count() or 4) // 4)
    avail = mem_available_mb()
    if avail is not None:
        n = min(n, avail // mb_per_job)
    return max(1, n)


def tmp_root() -> Path | None:
    """A tmpfs directory this user may write in, with room to spare: $XDG_RUNTIME_DIR (capped by the system), else /dev/shm."""
    for d in (os.environ.get("XDG_RUNTIME_DIR"), "/dev/shm"):
        if not d or not os.path.isdir(d) or not os.access(d, os.W_OK):
            continue
        try:
            fs = next((line.split()[2] for line in Path("/proc/self/mounts").read_text().splitlines()
                       if line.split()[1] == d), None)
            st = os.statvfs(d)
        except OSError:
            continue
        if fs == "tmpfs" and st.f_bavail * st.f_frsize > 1 << 30:
            return Path(d)
    return None


# -- the units ----------------------------------------------------------------------------------
class _Loader(unittest.TestLoader):
    """discover's loader, marking each module's suite with its module's name, so that a module can run whole."""

    def loadTestsFromModule(self, module, *args, **kwargs):
        suite = super().loadTestsFromModule(module, *args, **kwargs)
        try:
            suite.shard_module = module.__name__
        except AttributeError:
            pass
        return suite


def _tests(suite, module: str | None = None):
    """(module name, test) for each test, the module the one whose suite holds it; a load_tests module keeps
    what its load_tests built, whatever other modules' suites it took them from."""
    for t in suite:
        if isinstance(t, unittest.TestSuite):
            inner = module if module and _has_load_tests(module) else getattr(t, "shard_module", module)
            yield from _tests(t, inner)
        else:
            yield module, t


def _has_load_tests(module: str) -> bool:
    return hasattr(sys.modules.get(module), "load_tests")


def _by_id(test) -> bool:
    """Whether loading `test`'s id builds this test again: a plain TestCase method, named module.Class.method."""
    return (isinstance(test, unittest.TestCase) and not isinstance(test, unittest.FunctionTestCase)
            and test.id() == f"{type(test).__module__}.{type(test).__qualname__}.{test._testMethodName}")


def _has_fixture(cls: type) -> bool:
    mod = sys.modules.get(cls.__module__)
    return (cls.setUpClass.__func__ is not unittest.TestCase.setUpClass.__func__
            or cls.tearDownClass.__func__ is not unittest.TestCase.tearDownClass.__func__
            or hasattr(mod, "setUpModule") or hasattr(mod, "tearDownModule"))


class Unit(NamedTuple):
    name: str  # in the report and the durations cache
    ids: list[str]  # the names the worker loads: test ids, or a module's name when it runs whole
    tests: int


def units(start: str, pattern: str) -> tuple[list[Unit], list[unittest.TestCase]]:
    """The units, in discovery's order, and the tests discovery could not load (unittest's _FailedTest)."""
    found = list(_tests(_Loader().discover(start, pattern=pattern)))
    broken = [t for _, t in found if type(t).__module__ == "unittest.loader"]
    by_module: dict[str | None, list[unittest.TestCase]] = {}
    for module, t in found:
        if type(t).__module__ != "unittest.loader":
            by_module.setdefault(module, []).append(t)
    out: list[Unit] = []
    for module, tests in by_module.items():
        ids = [t.id() for t in tests]
        if module and (_has_load_tests(module) or not all(map(_by_id, tests)) or len(set(ids)) < len(ids)):
            out.append(Unit(module, [module], len(tests)))
            continue
        by_class: dict[type, list[str]] = {}
        for t in tests:
            by_class.setdefault(type(t), []).append(t.id())
        for cls, ids in by_class.items():
            name = ids[0].rsplit(".", 1)[0]
            if len(ids) <= CHUNK or _has_fixture(cls):
                out.append(Unit(name, ids, len(ids)))
            else:
                n = math.ceil(len(ids) / CHUNK)
                size = math.ceil(len(ids) / n)
                out += [Unit(f"{name}[{k + 1}/{n}]", ids[i:i + size], len(ids[i:i + size]))
                        for k, i in enumerate(range(0, len(ids), size))]
    return out, broken


# -- running ------------------------------------------------------------------------------------
def worker(top: str, result_path: str, ids: list[str], verbose: bool) -> int:
    sys.path[0] = ""  # as under `python3 -m unittest`: the working directory, not this script's
    sys.path.insert(0, top)  # as discover does
    suite = unittest.TestLoader().loadTestsFromNames(ids)
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2 if verbose else 1).run(suite)
    Path(result_path).write_text(json.dumps({
        "run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
        "skipped": len(result.skipped), "expected failures": len(result.expectedFailures),
        "unexpected successes": len(result.unexpectedSuccesses)}))
    return 0 if result.wasSuccessful() else 1


BAD = ("failures", "errors", "unexpected successes")  # the counts that fail a run, as wasSuccessful() reads them
_live: set[subprocess.Popen] = set()  # the workers running now, killed when the run is stopped
_live_lock = threading.RLock()
_stopping = False


def run_unit(top: str, unit: Unit, verbose: bool, tmp: str) -> tuple[Unit, dict, float, str]:
    t0 = time.monotonic()
    fd, result_path = tempfile.mkstemp(prefix="shard-", suffix=".json", dir=tmp)
    os.close(fd)
    with _live_lock:
        if _stopping:
            Path(result_path).unlink(missing_ok=True)
            return unit, {}, 0.0, ""
        proc = subprocess.Popen([sys.executable, __file__, "--worker", top, result_path, *(["-v"] if verbose else []),
                                 "--", *unit.ids], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        _live.add(proc)
    try:
        out = proc.communicate()[0].decode("utf-8", "replace")
    finally:
        with _live_lock:
            _live.discard(proc)
    try:
        counts = json.loads(Path(result_path).read_text())
    except (OSError, ValueError):
        counts = {"run": unit.tests, "errors": 1}  # the worker died before it could write its counts
    finally:
        Path(result_path).unlink(missing_ok=True)
    if proc.returncode != 0 and not any(counts.get(k) for k in BAD):
        counts["errors"] = counts.get("errors", 0) + 1  # it wrote its counts, then died
    return unit, counts, time.monotonic() - t0, out


def _stop(signum, _frame) -> None:
    """SIGTERM, SIGINT or SIGHUP: kill the workers, start no more, and exit through main's cleanup."""
    global _stopping
    with _live_lock:
        _stopping = True
        for proc in _live:
            proc.kill()
    raise SystemExit(128 + signum)


def load_cache() -> dict[str, float]:
    """The durations of the last runs, by unit (unittest_shards) or file (bun_files): a hint for the order only."""
    try:
        return json.loads(CACHE.read_text())
    except (OSError, ValueError):
        return {}


def save_cache(update: dict[str, float]) -> None:
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        merged = {**load_cache(), **update}
        tmp = CACHE.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(merged, sort_keys=True))
        os.replace(tmp, CACHE)
    except OSError:
        pass


def main(argv: list[str]) -> int:
    if argv[:1] == ["--worker"]:
        top, result_path, rest = argv[1], argv[2], argv[3:]
        verbose = rest[:1] == ["-v"]
        return worker(top, result_path, rest[rest.index("--") + 1:], verbose)
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-s", "--start", required=True, help="the directory discovery starts in (and its top level)")
    p.add_argument("-p", "--pattern", default="test*.py")
    p.add_argument("-j", "--jobs", type=int, default=None, help="worker processes (default: jobs(), see above)")
    p.add_argument("-v", "--verbose", action="store_true", help="print every unit's output, not only a failed one's")
    args = p.parse_args(argv)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _stop)
    own_tmp = None
    if not os.environ.get("TMPDIR") and (root := tmp_root()):
        own_tmp = tempfile.mkdtemp(prefix="tstack-tests-", dir=root)
        os.environ["TMPDIR"] = own_tmp
        tempfile.tempdir = None
    try:
        return _run(args)
    finally:
        if own_tmp:
            shutil.rmtree(own_tmp, ignore_errors=True)


def _run(args) -> int:
    t0 = time.monotonic()
    start = os.path.abspath(args.start)
    plan, broken = units(start, args.pattern)
    cache = load_cache()
    where = os.path.relpath(start)  # the cache's key: two suites may both have a test_state.StepTest
    known = [cache[f"{where}:{u.name}"] / u.tests for u in plan if f"{where}:{u.name}" in cache and u.tests]
    per_test = sum(known) / len(known) if known else 1.0
    plan.sort(key=lambda u: cache.get(f"{where}:{u.name}", per_test * u.tests), reverse=True)
    n = args.jobs or jobs()
    total = {"run": 0, "failures": 0, "errors": 0, "skipped": 0, "expected failures": 0, "unexpected successes": 0}
    failed: list[str] = []

    if broken:  # an import error: report it as unittest does, from this process
        result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.TestSuite(broken))
        total["run"] += result.testsRun
        total["errors"] += len(result.errors)
        failed += [t.id() for t, _ in result.errors]

    print(f"unittest_shards: {sum(u.tests for u in plan)} tests in {len(plan)} units, {n} at a time "
          f"(TMPDIR={os.environ.get('TMPDIR') or tempfile.gettempdir()})", flush=True)
    durations: dict[str, float] = {}
    with ThreadPoolExecutor(max(1, n)) as pool:
        futures = [pool.submit(run_unit, start, u, args.verbose, tempfile.gettempdir()) for u in plan]
        for fut in as_completed(futures):
            unit, counts, secs, out = fut.result()
            name, ids, bad = unit.name, unit.ids, any(counts.get(k) for k in BAD)
            durations[f"{where}:{name}"] = round(secs, 2)
            for k in total:
                total[k] += counts.get(k, 0)
            print(f"--- {name}: {'FAIL' if bad else 'ok'} ({counts.get('run', 0)} tests, {secs:.1f}s)", flush=True)
            if bad or args.verbose:
                sys.stdout.write(out if out.endswith("\n") or not out else out + "\n")
            if bad:
                rerun = name if "[" not in name else " ".join(ids)
                print(f"    rerun in {start}: python3 -m unittest -v {rerun}", flush=True)
                failed.append(name)
    save_cache(durations)
    print("-" * 70)
    print(f"Ran {total['run']} tests in {time.monotonic() - t0:.3f}s\n")
    extra = [f"{k}={total[k]}" for k in ("failures", "errors", "skipped", "expected failures", "unexpected successes") if total[k]]
    if failed:
        print(f"FAILED ({', '.join(extra)})")
        print("failed units: " + ", ".join(failed))
        return 1
    if total["run"] == 0:
        print("NO TESTS RAN")
        return 5
    print("OK" + (f" ({', '.join(extra)})" if extra else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
