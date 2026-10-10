"""What tstack's test runners share: the worker cap, $TSTACK_TEST_JOBS.

scripts/gates sets $TSTACK_TEST_JOBS for each suite it runs, fitted to the cores and the memory free;
unittest_shards.py, bun_files.py and the fleet oracle's replays read it here. Stdlib only.
"""
import os


def env_jobs() -> int | None:
    """$TSTACK_TEST_JOBS as a worker count, at least 1; None when it is unset or empty."""
    raw = os.environ.get("TSTACK_TEST_JOBS", "").strip()
    if not raw:
        return None
    try:
        return max(1, int(raw))
    except ValueError:
        raise ValueError(f"$TSTACK_TEST_JOBS must be a whole number, not {raw!r}") from None
