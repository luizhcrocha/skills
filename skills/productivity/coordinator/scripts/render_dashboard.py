#!/usr/bin/env python3
"""Render the coordinator fleet dashboard from a state file.

    render_dashboard.py STATE_JSON OUT_HTML [--fragment]

Writes a full HTML document for serving over the tailnet (serve_dashboard.py);
name the output index.html so the served URL is the bare host:port.
--fragment writes the bare page fragment (no doctype or <html>) that the
Artifact tool expects instead.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REQUIRED = {
    "project": str, "goal": str, "status": str, "now": str, "started": str,
    "roadmap": list, "agents": list, "roadblocks": list, "events": list,
}
STATUSES = {"running", "paused", "blocked", "done"}
AGENT_STATUSES = {"queued", "running", "blocked", "done", "failed", "stopped"}
STEP_STATUSES = {"done", "current", "pending", "blocked"}


def fail(msg: str) -> None:
    sys.stderr.write(f"render_dashboard: {msg}\n")
    sys.exit(1)


def validate(state: dict) -> None:
    for key, typ in REQUIRED.items():
        if key not in state:
            fail(f"state is missing '{key}'")
        if not isinstance(state[key], typ):
            fail(f"'{key}' should be {typ.__name__}")
    if state["status"] not in STATUSES:
        fail(f"status '{state['status']}' not in {sorted(STATUSES)}")
    ids = set()
    for a in state["agents"]:
        for k in ("id", "name", "task", "status", "lane", "milestone"):
            if k not in a:
                fail(f"agent {a.get('id', '?')} is missing '{k}'")
        if a["status"] not in AGENT_STATUSES:
            fail(f"agent {a['id']} status '{a['status']}' not in {sorted(AGENT_STATUSES)}")
        if a["id"] in ids:
            fail(f"duplicate agent id '{a['id']}'")
        ids.add(a["id"])
        a.setdefault("tokens", 0)
        a.setdefault("duration_ms", 0)
        a.setdefault("skill", "none")
        a.setdefault("model", "opus")
        a.setdefault("brief", "")
        a.setdefault("report", "")
    for m in state["roadmap"]:
        for k in ("id", "title", "steps"):
            if k not in m:
                fail(f"milestone {m.get('id', '?')} is missing '{k}'")
        for s in m["steps"]:
            if s.get("status") not in STEP_STATUSES:
                fail(f"step {s.get('id', '?')} status not in {sorted(STEP_STATUSES)}")
            if s.get("agent") and s["agent"] not in ids:
                fail(f"step {s['id']} points at unknown agent '{s['agent']}'")
    for r in state["roadblocks"]:
        for k in ("id", "title", "severity", "needs", "since", "resolved"):
            if k not in r:
                fail(f"roadblock {r.get('id', '?')} is missing '{k}'")
    for e in state["events"]:
        for k in ("at", "kind", "text"):
            if k not in e:
                fail(f"event is missing '{k}': {e}")


def main(argv: list[str]) -> None:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        fail("usage: render_dashboard.py STATE_JSON OUT_HTML [--fragment]")
    standalone = "--fragment" not in argv
    state_path, out_path = Path(args[0]), Path(args[1])

    try:
        state = json.loads(state_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read state: {exc}")
    validate(state)

    state["updated"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")

    template = (Path(__file__).resolve().parent.parent / "assets" / "dashboard.html").read_text()
    payload = json.dumps(state, ensure_ascii=False).replace("</", "<\\/")
    if "/*__STATE__*/" not in template:
        fail("template has no /*__STATE__*/ placeholder")
    html = template.replace("/*__STATE__*/", payload, 1)

    if standalone:
        html = (
            "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
            "<style>:root{padding-block:env(safe-area-inset-top,0) env(safe-area-inset-bottom,0)}"
            "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n"
            "</head>\n<body>\n" + html + "\n</body>\n</html>\n"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html)
    print(f"rendered {out_path} ({len(state['agents'])} agents, updated {state['updated']})")


if __name__ == "__main__":
    main(sys.argv[1:])
