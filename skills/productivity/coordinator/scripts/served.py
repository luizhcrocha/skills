#!/usr/bin/env python3
"""What this machine serves, and whose it is: the ports `tailscale serve` exposes, each with the process
behind it, and whether a fleet's own link says what it is.

    served.py            every served port: its address, whether it answers, the process, its directory,
                         and the fleet whose session started it

A fleet names its dev servers and purpose-built pages with `state.py DIR link`; this finds the rest,
so a server nobody recorded still shows on the pages. The fleet dashboards themselves are left out.
Lookups are cached for a few seconds: the dashboard server asks on every poll.
"""
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleets  # noqa: E402

SERVED_S, PROBE_S = 30, 10
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl: float, make):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    value = make()
    _cache[key] = (time.monotonic(), value)
    return value


def up(url: str) -> bool:
    """Whether something accepts connections where `url` points, on this machine."""
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    host = "127.0.0.1" if (parts.hostname or "").endswith(".ts.net") or parts.hostname in (None, "localhost") else parts.hostname

    def probe() -> bool:
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            return False
    return _cached(f"up:{host}:{port}", PROBE_S, probe)


def _tailnet() -> list[dict]:
    """[{port, url, target}] for every HTTPS port `tailscale serve` exposes."""
    try:
        out = subprocess.run(["tailscale", "serve", "status", "--json"], capture_output=True, text=True, timeout=5)
        status = json.loads(out.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    found = []
    for host_port, web in (status.get("Web") or {}).items():
        handler = ((web or {}).get("Handlers") or {}).get("/") or {}
        target = handler.get("Proxy")
        if not target:
            continue
        port = int(host_port.rsplit(":", 1)[1]) if ":" in host_port else 443
        found.append({"port": port, "url": f"https://{host_port}/", "target": target})
    return sorted(found, key=lambda x: x["port"])


def _listeners() -> dict[int, int]:
    """local port -> pid of the process listening on it."""
    try:
        out = subprocess.run(["ss", "-ltnpH"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    ports = {}
    for line in out.splitlines():
        cols = line.split()
        pid = re.search(r"pid=(\d+)", line)
        if len(cols) >= 4 and pid:
            try:
                ports.setdefault(int(cols[3].rsplit(":", 1)[1]), int(pid.group(1)))
            except ValueError:
                continue
    return ports


def _ancestry(pid: int) -> list[int]:
    chain = []
    while pid > 1 and len(chain) < 32:
        chain.append(pid)
        try:
            pid = int((Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return chain


def owner(pid: int, cwd: str, entries: list[dict]) -> str | None:
    """The fleet whose session started `pid` (it or a parent writes into the session's tasks/), or whose
    session directory holds its working directory."""
    chain = set(_ancestry(pid))
    for e in entries:
        session = str(Path(e["dir"]).resolve().parent.parent)
        if cwd == session or cwd.startswith(session + "/"):
            return e["id"]
        if chain & {p["pid"] for p in fleets.processes(e["dir"])}:
            return e["id"]
    return None


_said: dict[tuple, str | None] = {}


def mentioned_by(port: int, pid: int, entries: list[dict]) -> str | None:
    """The fleet whose session or workers first wrote this port's address in their transcripts: who
    started a server that left no trace in its parent processes (the ones who relay an address write
    it later). Only full addresses count (`ts.net:PORT`, `127.0.0.1:PORT`, `localhost:PORT`). Kept for
    as long as the same process serves the port."""
    key = (port, pid)
    if key in _said:
        return _said[key]
    import spend
    patterns = [a for f in (f"ts.net:{port}", f"127.0.0.1:{port}", f"localhost:{port}") for a in ("-e", f)]
    first = []
    for e in entries:
        transcript = spend.transcript_of(e["dir"])
        paths = [str(p) for p in (transcript, transcript.with_suffix("") / "subagents") if transcript and p.exists()]
        if not paths or port == 443:
            continue
        try:  # the first matching lines of each file are its earliest mentions
            out = subprocess.run(["grep", "-rhF", "-m", "2", *patterns, *paths], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        stamps = re.findall(r'"timestamp":\s*"([^"]+)"', out)
        if stamps:
            first.append((min(stamps), e["id"]))
    _said[key] = min(first)[1] if first else None
    return _said[key]


def _discover() -> list[dict]:
    if os.environ.get("FLEET_DISCOVER") == "0":  # tests: the machine's servers are not theirs to see
        return []
    entries = fleets.live()
    dashboards = {urlsplit(e["url"]).port for e in entries}
    listeners = _listeners()
    found = []
    for s in _tailnet():
        if s["port"] in dashboards:
            continue
        local = urlsplit(s["target"]).port
        pid = listeners.get(local) if local else None
        cwd, command = "", ""
        if pid:
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
                command = (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            except OSError:
                pass
        fleet = (owner(pid, cwd, entries) or mentioned_by(s["port"], pid, entries)) if pid else None
        found.append({**s, "pid": pid, "cwd": cwd, "command": command[:200], "fleet": fleet})
    return found


_lock = threading.Lock()
_latest: dict = {"at": 0.0, "value": [], "busy": False}


def _refresh() -> None:
    try:
        value = _discover()
    except Exception:  # noqa: BLE001 - a failed look leaves the last one; the page must keep serving
        value = None
    with _lock:
        if value is not None:
            _latest["value"] = value
        _latest["at"], _latest["busy"] = time.monotonic(), False


def discovered(wait: bool = False) -> list[dict]:
    """Every served port but the fleets' dashboards, with the process behind it and its fleet. Looking
    takes about a second, so it runs in the background: this returns the last look at once and starts
    the next when it is older than SERVED_S. `wait` looks now (the CLI)."""
    if wait:
        _refresh()
    with _lock:
        stale = time.monotonic() - _latest["at"] >= SERVED_S and not _latest["busy"]
        if stale:
            _latest["busy"] = True
        value = _latest["value"]
    if stale and not wait:
        threading.Thread(target=_refresh, daemon=True).start()
    return [{**s, "up": s["pid"] is not None} for s in value]


def links_of(state: dict) -> list[dict]:
    """The fleet's own links as the page shows them: each with whether it answers now."""
    return [{**link, "up": up(link["url"])} for link in state.get("links", []) if isinstance(link, dict) and isinstance(link.get("url"), str)]


def main() -> None:
    for s in discovered(wait=True):
        print(f"{s['url']}  {'up' if s['up'] else 'down'}  {s['fleet'] or '(no fleet)'}  pid {s['pid'] or '-'}  {s['cwd']}")
        if s["command"]:
            print(f"    {s['command']}")


if __name__ == "__main__":
    main()
