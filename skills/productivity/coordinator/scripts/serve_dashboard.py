#!/usr/bin/env python3
"""Serve a dashboard directory over the tailnet, with HTTPS.

    serve_dashboard.py DIR          start (or report the running) server, print its URL
    serve_dashboard.py DIR --restart  replace the running worker, keeping its URL (port and scheme)
    serve_dashboard.py DIR --stop   stop the server for DIR

Besides the files, the server carries the chat (chat.py): GET /events streams
chat messages and state.json changes as server-sent events, POST /chat takes
the user's messages, POST /chat/preview answers who a text would reach
without storing it, GET /chat?after=N lists them. Only this machine's tailnet
login may post, and only over https; the policy is recorded in server.json.

A local file server binds a free port on 127.0.0.1, and `tailscale serve`
exposes it as https://<magicdns-name>:<port>/ with a certificate Tailscale
provisions for this machine, reachable from any device on the tailnet and
from nowhere else. Several coordinators on one machine each get their own
port, recorded in DIR/server.json; a later start or --restart reuses that
port, so the user's link survives, unless the port is taken (then a warning).

If `tailscale serve` is refused (HTTPS certificates not enabled for the
tailnet, or this user is not the Tailscale operator), the server binds the
machine's Tailscale IPv4 directly and the URL is plain http, with a warning.
"""
import json
import os
import shutil
import select
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chat  # noqa: E402


def fail(msg: str) -> None:
    sys.stderr.write(f"serve_dashboard: {msg}\n")
    sys.exit(1)


def warn(msg: str) -> None:
    sys.stderr.write(f"serve_dashboard: {msg}\n")


def tailscale_exe() -> str:
    return os.environ.get("TAILSCALE") or shutil.which("tailscale") or "/Applications/Tailscale.app/Contents/MacOS/Tailscale"


def tailscale_status() -> dict:
    try:
        out = subprocess.run([tailscale_exe(), "status", "--json"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        fail(f"tailscale status failed: {exc}")
    status = json.loads(out)
    if status.get("BackendState") != "Running":
        fail(f"tailscale is {status.get('BackendState')}, not Running")
    return status


def tailscale_self(status: dict) -> tuple[str, str]:
    me = status["Self"]
    ipv4 = next((ip for ip in me.get("TailscaleIPs", []) if ":" not in ip), None)
    if not ipv4:
        fail("no Tailscale IPv4 address on this machine")
    return me["DNSName"].rstrip("."), ipv4


def post_policy(status: dict, tls: bool) -> str:
    """Who may POST /chat: this machine's tailnet login over https, nobody over plain http or when it is unknown."""
    user_id = status.get("Self", {}).get("UserID")
    login = status.get("User", {}).get(str(user_id), {}).get("LoginName") if user_id is not None else None
    return f"login:{login}" if tls and login else "closed"


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


def start_worker(root: Path, bind_ip: str, port: int, policy: str, hosts: list[str], wait: float = 5) -> int:
    """Start the worker and return its pid once it accepts connections; fail with the tail of its log otherwise."""
    log_path = root / "server.log"
    with open(log_path, "ab") as log:
        proc = subprocess.Popen(
            [sys.executable, "-u", __file__, "--worker", str(root), bind_ip, str(port), policy, *hosts],
            stdout=log, stderr=log, start_new_session=True,
        )
    deadline = time.monotonic() + wait
    while proc.poll() is None and time.monotonic() < deadline:
        try:
            socket.create_connection((bind_ip, port), timeout=0.2).close()
            return proc.pid
        except OSError:
            time.sleep(0.05)
    if proc.poll() is None:
        proc.kill()
    proc.wait()
    tail = log_path.read_text(errors="replace").splitlines()[-15:]
    raise WorkerFailed("\n".join(tail))


class WorkerFailed(Exception):
    """The worker never accepted connections; carries the tail of server.log."""


def port_free(addr: str, port: int, wait: float = 0) -> bool:
    """Whether `port` can be bound on `addr`, retrying up to `wait` seconds while a stopped worker releases it."""
    deadline = time.monotonic() + wait
    while True:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((addr, port))
                return True
            except OSError:
                if time.monotonic() >= deadline:
                    return False
        time.sleep(0.1)


def stop_worker(pid: int, wait: float = 3) -> None:
    if not alive(pid):
        return
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + wait
    while alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)


def start(root: Path, record: Path, existing: dict | None) -> None:
    """Start a worker, on the recorded port and scheme when there is a record, so the user's link survives."""
    status = tailscale_status()
    host, ipv4 = tailscale_self(status)
    want_tls = existing.get("tls", True) if existing else True
    port = existing and existing["port"]
    if port and not port_free("127.0.0.1" if want_tls else ipv4, port, wait=3):
        if want_tls:
            tailscale_unserve(port)
        port = None
    port = port or free_port("127.0.0.1", ipv4)
    tls = want_tls and tailscale_serve(port)
    policy = post_policy(status, tls)
    if policy == "closed" and tls:
        warn("could not read this machine's tailnet login; the chat is read-only")
    try:
        pid = start_worker(root, "127.0.0.1" if tls else ipv4, port, policy, [f"{host}:{port}", f"127.0.0.1:{port}"])
    except WorkerFailed as exc:
        record.unlink(missing_ok=True)
        if tls:
            tailscale_unserve(port)
        fail(f"the worker on port {port} never accepted connections; server.log ends with:\n{exc}")
    url = f"{'https' if tls else 'http'}://{host}:{port}/"
    if existing and existing.get("url") != url:
        warn(f"address changed: {existing.get('url')} is now {url}")
    record.write_text(json.dumps({"pid": pid, "port": port, "url": url, "tls": tls, "post": policy}, indent=2) + "\n")
    print(url)


def main(argv: list[str]) -> None:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        fail("usage: serve_dashboard.py DIR [--restart | --stop]")
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
        if "--restart" not in argv:
            print(existing["url"])
            return
        stop_worker(existing["pid"])
    start(root, record, existing)


MAX_POST_BYTES = 16 * 1024
PING_S = 15
POLL_S = 0.3


def writer_refusal(policy: str, login: str | None) -> str | None:
    """Why the post policy refuses a client with this tailnet login, or None when it may write.

    POST /chat refuses with it and GET /events announces it in `hello`, so the two cannot disagree."""
    if policy == "closed":
        return "chat is read-only on this address; open the https address"
    if policy.startswith("login:") and (login or "").lower() != policy[len("login:"):].lower():
        return f"only {policy[len('login:'):]} can write here"
    return None


def hello(policy: str, login: str | None) -> dict:
    denied = writer_refusal(policy, login)
    event = {"write": False, "reason": denied} if denied else {"write": True}
    return {**event, "you": login} if login else event


def post_refusal(policy: str, hosts: set[str], headers) -> tuple[int, str] | None:
    """Why POST /chat is refused under `policy` with these request headers, as (status, error), or None.

    The body is checked by the caller; these are the checks that need no body."""
    denied = writer_refusal(policy, headers.get("Tailscale-User-Login"))
    if denied:
        return 403, denied
    if (headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
        return 415, "send the message as application/json"
    origin = headers.get("Origin")
    if origin is not None:
        url = urlsplit(origin)
        if url.scheme not in ("http", "https") or url.netloc.lower() not in hosts:
            return 403, "cross-origin post refused"
    length = headers.get("Content-Length") or "0"
    if not length.isdigit():
        return 400, "bad Content-Length"
    if int(length) > MAX_POST_BYTES:
        return 413, f"a message is at most {MAX_POST_BYTES // 1024} KiB"
    return None


def worker(root: str, bind_ip: str, port: int, policy: str = "open", *hosts: str) -> None:
    """Serve DIR, answering only requests whose Host is one of `hosts` (host:port), by default this port
    on 127.0.0.1 and localhost, so a page on another name (DNS rebinding) cannot reach the chat."""
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    if policy not in ("open", "closed") and not policy.startswith("login:"):
        fail(f"unknown post policy '{policy}'; use login:<tailnet login>, closed or open before any host")
    allowed = {h.lower() for h in hosts} or {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, fmt, *args):
            pass

        def send_json(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def unknown_host(self) -> bool:
            if (self.headers.get("Host") or "").lower() in allowed:
                return False
            self.close_connection = True
            self.send_json(421, {"error": "unknown host"})
            return True

        def do_HEAD(self):
            if not self.unknown_host():
                super().do_HEAD()

        def do_GET(self):
            if self.unknown_host():
                return
            url = urlsplit(self.path)
            if url.path == "/chat":
                self.send_json(200, {"messages": chat.read(root, after_param(url.query))})
            elif url.path == "/events":
                self.stream_events(resume_point(self.headers.get("Last-Event-ID"), url.query))
            else:
                super().do_GET()

        def stream_events(self, after: int) -> None:
            """hello first, then replay then live: every chat message after `after`, state.json on connect and
            on change, a ping."""
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            sent_state, pinged, tail = None, time.monotonic(), chat.Tail(root, after)
            try:
                greeting = hello(policy, self.headers.get("Tailscale-User-Login"))
                self.wfile.write(f"event: hello\ndata: {json.dumps(greeting, ensure_ascii=False)}\n\n".encode())
                while True:
                    raw = read_bytes(Path(root) / "state.json")
                    if raw != sent_state and (state := parse_state(raw)) is not None:
                        self.wfile.write(f"event: state\ndata: {state}\n\n".encode())
                        sent_state = raw
                    for m in tail.read():
                        self.wfile.write(f"event: chat\nid: {m['id']}\ndata: {json.dumps(m, ensure_ascii=False)}\n\n".encode())
                    if time.monotonic() - pinged >= PING_S:
                        self.wfile.write(b": ping\n\n")
                        pinged = time.monotonic()
                    self.wfile.flush()
                    if client_gone(self.connection, POLL_S):
                        return
            except OSError:  # the client left (broken pipe, reset), or the store cannot be read
                return

        def do_POST(self):
            if self.unknown_host():
                return
            route = urlsplit(self.path).path
            if route not in ("/chat", "/chat/preview"):
                self.send_json(404, {"error": "not found"})
                return
            refusal = post_refusal(policy, allowed, self.headers)
            if refusal:
                self.close_connection = True
                self.send_json(refusal[0], {"error": refusal[1]})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
            except ValueError:
                body = None
            if not isinstance(body, dict):
                self.send_json(400, {"error": "the body is not a JSON object"})
                return
            text, re = body.get("text"), body.get("re")
            if not isinstance(text, str) or (re is not None and (not isinstance(re, int) or isinstance(re, bool))):
                self.send_json(400, {"error": "text must be a string and re a message id"})
                return
            try:
                if route == "/chat/preview":  # what POST /chat would store for this text now; stores nothing
                    resolved = chat.address(root, "user", text, re, allow_user=True)
                    self.send_json(200, {"to": resolved["to"], "parts": resolved["parts"]})
                    return
                message = chat.append(root, "user", text, re, self.headers.get("Tailscale-User-Login"), allow_user=True)
            except chat.ChatError as exc:
                self.send_json(400, {"error": str(exc)})
                return
            except OSError as exc:
                self.send_json(500, {"error": f"could not store the message: {exc.strerror or exc}"})
                return
            self.send_json(201, message)

    server = ThreadingHTTPServer((bind_ip, port), Handler)
    server.daemon_threads = True
    server.serve_forever()


def read_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def parse_state(raw: bytes | None) -> str | None:
    """state.json as one line of JSON, or None while it is missing or half written."""
    try:
        return json.dumps(json.loads(raw), ensure_ascii=False) if raw else None
    except ValueError:
        return None


def client_gone(conn: socket.socket, wait: float) -> bool:
    """Wait up to `wait` seconds; true when the client has closed its end, so the stream can end at once."""
    readable, _, _ = select.select([conn], [], [], wait)
    if not readable:
        return False
    try:
        if conn.recv(1, socket.MSG_PEEK) == b"":
            return True
    except OSError:
        return True
    time.sleep(wait)  # the client sent bytes a stream does not read; keep the pace instead of spinning
    return False


def resume_point(last_event_id: str | None, query: str) -> int:
    try:
        return int(last_event_id)
    except (TypeError, ValueError):
        return after_param(query)


def after_param(query: str) -> int:
    try:
        return int(parse_qs(query).get("after", ["0"])[0])
    except ValueError:
        return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3], int(sys.argv[4]), *sys.argv[5:])
    else:
        main(sys.argv[1:])
