#!/usr/bin/env python3
"""Serve a dashboard directory over the tailnet, with HTTPS.

    serve_dashboard.py DIR          start (or report the running) server, print its URL
    serve_dashboard.py DIR --stop   stop the server for DIR

A local file server binds a free port on 127.0.0.1, and `tailscale serve`
exposes it as https://<magicdns-name>:<port>/ with a certificate Tailscale
provisions for this machine, reachable from any device on the tailnet and
from nowhere else. Several coordinators on one machine each get their own
port, recorded in DIR/server.json.

If `tailscale serve` is refused (HTTPS certificates not enabled for the
tailnet, or this user is not the Tailscale operator), the server binds the
machine's Tailscale IPv4 directly and the URL is plain http, with a warning.
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


def warn(msg: str) -> None:
    sys.stderr.write(f"serve_dashboard: {msg}\n")


def tailscale_exe() -> str:
    return shutil.which("tailscale") or "/Applications/Tailscale.app/Contents/MacOS/Tailscale"


def tailscale_self() -> tuple[str, str]:
    try:
        out = subprocess.run([tailscale_exe(), "status", "--json"], capture_output=True, text=True, check=True).stdout
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


def free_port(*addresses: str) -> int:
    """A port that is free on every given address, so the local server and the tailnet listener can share the number."""
    for _ in range(50):
        with socket.socket() as probe:
            probe.bind((addresses[0], 0))
            port = probe.getsockname()[1]
        try:
            for addr in addresses[1:]:
                with socket.socket() as check:
                    check.bind((addr, port))
        except OSError:
            continue
        return port
    fail("could not find a free port")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def tailscale_serve(port: int) -> bool:
    result = subprocess.run(
        [tailscale_exe(), "serve", "--bg", f"--https={port}", f"http://127.0.0.1:{port}"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        warn(f"tailscale serve refused ({result.stderr.strip() or result.stdout.strip()}); falling back to plain http on the Tailscale IP")
        return False
    return True


def tailscale_unserve(port: int) -> None:
    subprocess.run([tailscale_exe(), "serve", f"--https={port}", "off"], capture_output=True, text=True)


def start_worker(root: Path, bind_ip: str, port: int) -> int:
    log = open(root / "server.log", "ab")
    proc = subprocess.Popen(
        [sys.executable, "-u", __file__, "--worker", str(root), bind_ip, str(port)],
        stdout=log, stderr=log, start_new_session=True,
    )
    return proc.pid


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
        if existing:
            if alive(existing["pid"]):
                os.kill(existing["pid"], signal.SIGTERM)
            if existing.get("tls"):
                tailscale_unserve(existing["port"])
            print(f"stopped {existing['url']}")
        record.unlink(missing_ok=True)
        return

    if existing and alive(existing["pid"]):
        print(existing["url"])
        return

    host, ipv4 = tailscale_self()
    port = free_port("127.0.0.1", ipv4)
    if tailscale_serve(port):
        pid = start_worker(root, "127.0.0.1", port)
        url, tls = f"https://{host}:{port}/", True
    else:
        pid = start_worker(root, ipv4, port)
        url, tls = f"http://{host}:{port}/", False
    record.write_text(json.dumps({"pid": pid, "port": port, "url": url, "tls": tls}, indent=2) + "\n")
    print(url)


def worker(root: str, bind_ip: str, port: int) -> None:
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, fmt, *args):
            pass

    ThreadingHTTPServer((bind_ip, port), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3], int(sys.argv[4]))
    else:
        main(sys.argv[1:])
