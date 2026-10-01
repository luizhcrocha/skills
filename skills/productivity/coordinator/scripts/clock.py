"""The fleet's one clock: every script reads the time through here.

$FLEET_NOW, an ISO 8601 instant with its offset ("2026-09-30T09:00:00+00:00"), stops the clock at
that instant: the oracle (fleet/oracle) replays a trace step by step with it, so what a command
stamps and every age it measures (a stale Now line, a chat nobody reads) is the same on every run.
Unset, it is the machine's clock. Timers that only pace a loop (time.monotonic, sleeps) stay real.
"""
import os
from datetime import datetime, timezone


def now() -> datetime:
    """The current instant, aware: $FLEET_NOW when it is set, else the machine's clock, in UTC."""
    fixed = os.environ.get("FLEET_NOW")
    if fixed:
        at = datetime.fromisoformat(fixed)
        return at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def stamp() -> str:
    """now() as the ledger writes it: local time with its offset, to the second."""
    return now().astimezone().isoformat(timespec="seconds")


def time() -> float:
    """now() as seconds since the epoch, for ages measured against file times and stamps."""
    return now().timestamp()


def instant(text) -> float | None:
    """The instant an ISO 8601 stamp names, as seconds since the epoch (a stamp without an offset is
    UTC); None when it does not parse. Stamps are compared as instants, never as strings: two offsets
    (a DST change, a moved machine) misorder the strings."""
    try:
        at = datetime.fromisoformat(str(text).strip())
    except ValueError:
        return None
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).timestamp()


def at_or_after(a, b) -> bool:
    """Whether stamp `a` is at or after stamp `b`, as instants; as strings when either does not parse."""
    x, y = instant(a), instant(b)
    return x >= y if x is not None and y is not None else str(a) >= str(b)


def order(text) -> tuple:
    """A sort key that puts stamps in time order, and those that do not parse after them, as strings."""
    at = instant(text)
    return (0, at, "") if at is not None else (1, 0.0, str(text))
