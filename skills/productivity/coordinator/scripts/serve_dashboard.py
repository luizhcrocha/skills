#!/usr/bin/env python3
"""Serve a dashboard directory over the tailnet.

    serve_dashboard.py DIR          start (or report the running) server, print its URL
    serve_dashboard.py DIR --stop   stop the server for DIR

Binds a free port on this machine's Tailscale IPv4, so the page is reachable
from any device on the tailnet at http://<magicdns-name>:<port>/ and from
nowhere else. Several coordinators can run at once: each directory gets its
own port, recorded in DIR/server.json.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
from pathlib import Path


def fail(msg: str) -> None:
    sys.stderr.write(f"serve_dashboard: {msg}\n")
    sys.exit(1)


def tailscale_self() -> tuple[str, str]:
    exe = shutil.which("tailscale") or "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    try:
        out = subprocess.run([exe, "status", "--json"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        fail(f"tailscale status failed: {exc}")
    status = json.loads(out)
    if status.get("BackendState") != "Running":
        fail(f"tailscale is {status.get('BackendState')}, not Running")
    me = status["Self"]
    ipv4 = next((ip for ip in me.get("TailscaleIPs", []) if ":" not in ip), None)
    if not ipv4:
        fail("no Tailscale IPv4 address on this machine")
    return me["DNSName"].rstrip("."), ipv4


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main(argv: list[str]) -> None:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        fail("usage: serve_dashboard.py DIR [--stop]")
    root = Path(args[0]).resolve()
    if not root.is_dir():
        fail(f"{root} is not a directory")
    record = root / "server.json"
    existing = json.loads(record.read_text()) if record.exists() else None

    if "--stop" in argv:
        if existing and alive(existing["pid"]):
            os.kill(existing["pid"], signal.SIGTERM)
            print(f"stopped {existing['url']}")
        record.unlink(missing_ok=True)
        return

    if existing and alive(existing["pid"]):
        print(existing["url"])
        return

    host, ipv4 = tailscale_self()
    with socket.socket() as probe:
        probe.bind((ipv4, 0))
        port = probe.getsockname()[1]

    log = open(root / "server.log", "ab")
    proc = subprocess.Popen(
        [sys.executable, "-u", __file__, "--worker", str(root), ipv4, str(port)],
        stdout=log, stderr=log, start_new_session=True,
    )
    url = f"http://{host}:{port}/"
    record.write_text(json.dumps({"pid": proc.pid, "port": port, "ip": ipv4, "url": url}, indent=2) + "\n")
    print(url)


def worker(root: str, ipv4: str, port: int) -> None:
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, fmt, *args):
            pass

    ThreadingHTTPServer((ipv4, port), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3], int(sys.argv[4]))
    else:
        main(sys.argv[1:])
