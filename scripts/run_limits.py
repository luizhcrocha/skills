"""What tstack's test runners share: the worker cap, $TSTACK_TEST_JOBS, and a command run under a limit.

scripts/gates sets $TSTACK_TEST_JOBS for each suite it runs, fitted to the cores and the memory free;
unittest_shards.py, bun_files.py and the fleet oracle's replays read it here. run_limited() runs a
command in its own process group and stops the whole group at a wall-clock limit or when a watch says
so: scripts/gates runs each suite with it, bun_files.py each test file. stop_live() stops every
command it is running, for a runner's signal handler. Stdlib only.
"""
import os
import signal
import subprocess
import threading
import time

TERM_GRACE = 10.0  # seconds a stopped group has to clean up after SIGTERM before SIGKILL
TIMEOUT = "timed out"  # run_limited's reason when the limit stopped the command
_live: set[subprocess.Popen] = set()  # what run_limited is running now
_live_lock = threading.RLock()  # an RLock: stop_live may run in a signal handler on a thread holding it
_stopping = False


def env_jobs() -> int | None:
    """$TSTACK_TEST_JOBS as a worker count, at least 1; None when it is unset or empty."""
    raw = os.environ.get("TSTACK_TEST_JOBS", "").strip()
    if not raw:
        return None
    try:
        return max(1, int(raw))
    except ValueError:
        raise ValueError(f"$TSTACK_TEST_JOBS must be a whole number, not {raw!r}") from None


def _signal_group(proc: subprocess.Popen, sig: int) -> bool:
    """Send `sig` to proc's group; False when the group is gone."""
    try:
        os.killpg(proc.pid, sig)
        return True
    except ProcessLookupError:
        return False


def _wait_group(proc: subprocess.Popen, deadline: float) -> None:
    """Wait until proc's group is empty or `deadline` passes; zombies of an unreaped leader count as gone."""
    while time.monotonic() < deadline:
        proc.poll()
        if not _signal_group(proc, 0):
            return
        time.sleep(0.05)


def kill_group(proc: subprocess.Popen, grace: float = 0.0) -> None:
    """SIGTERM proc's group and wait up to `grace` s for it to empty, then SIGKILL what is left; 0 kills at once."""
    if grace > 0:
        if not _signal_group(proc, signal.SIGTERM):
            return
        _wait_group(proc, time.monotonic() + grace)
    _signal_group(proc, signal.SIGKILL)


def run_limited(argv: list[str], limit: float, cwd=None, env: dict | None = None, nice: int = 0, watch=None,
                grace: float | None = None, poll: float = 0.5) -> tuple[int, str | None, float, str]:
    """Run argv in its own process group, its output read as it comes, so what a hung command printed before it hung
    survives the kill. At `limit` seconds, or when `watch(proc)`, asked every `poll` seconds, returns a reason, stop
    the whole group: SIGTERM, then SIGKILL after `grace` seconds (default TERM_GRACE; 0 kills at once). When it exits
    on its own, SIGKILL what it left behind in its group.

    Returns (exit code, why it was stopped: None, TIMEOUT or the watch's reason, seconds, output). `env` is added to
    this process's environment.
    """
    start = time.monotonic()
    with _live_lock:
        proc = subprocess.Popen(["nice", "-n", str(nice), *argv] if nice else argv, cwd=cwd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
                                env={**os.environ, **(env or {})})
        _live.add(proc)
        if _stopping:
            kill_group(proc)
    chunks: list[bytes] = []
    reader = threading.Thread(target=lambda: [chunks.append(c) for c in iter(lambda: proc.stdout.read1(65536), b"")],
                              daemon=True)
    reader.start()
    stopped = None
    try:
        deadline = start + limit
        while stopped is None:
            left = deadline - time.monotonic()
            try:
                proc.wait(timeout=max(0.0, min(left, poll) if watch else left))
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    stopped = TIMEOUT
                elif watch is not None:
                    stopped = watch(proc)
        kill_group(proc, (TERM_GRACE if grace is None else grace) if stopped else 0.0)
        proc.wait()
    finally:
        with _live_lock:
            _live.discard(proc)
    reader.join(5)
    proc.stdout.close()
    return proc.returncode, stopped, time.monotonic() - start, b"".join(chunks).decode("utf-8", "replace")


def stop_live(sig: int, grace: float = 1.0) -> None:
    """Send `sig` to the group of every command run_limited is running, and SIGKILL the groups still there after
    `grace` seconds. run_limited starts nothing after, so a runner's signal handler can call this, then exit."""
    global _stopping
    with _live_lock:
        _stopping = True
        procs = list(_live)
    for proc in procs:
        _signal_group(proc, sig)
    deadline = time.monotonic() + grace
    for proc in procs:
        _wait_group(proc, deadline)
        _signal_group(proc, signal.SIGKILL)
