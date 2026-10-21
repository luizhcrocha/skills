#!/usr/bin/env python3
"""An eval for `memo recall`: build a gold set from finished fleet rows, then score any memo against it.

Standard library only. Subcommands, in the order a rebuild runs them (README.md):

  sample   fleet ledgers -> rows.jsonl     finished worker rows with a lane, by stratum, fixed seed
  pool     rows -> pooled.jsonl            union of recall's hits per row, among notes dated before the row's start
  packets  pooled -> reader files          one Markdown packet per batch of rows, for the U/N readers
  gold     pooled + labels -> gold.jsonl   the readers' labels joined to the rows
  agree    two label sets                  raw agreement and Cohen's kappa on the notes both labelled
  score    gold + a recall command         P@3, abstention rates, latency

The gold set holds note and task text (client names, case details): it lives outside the repo, by default
~/.local/state/tstack/memo-eval/.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

HOME = Path.home()
STATE = HOME / ".local/state/tstack/memo-eval"
REPOS = HOME / "repos"
CMS = str(REPOS / "coelhorocha/custom-mcp-servers")
TSTACK = str(REPOS / "luizhcrocha/skills")
PICASSO = str(REPOS / "luizhcrocha/picasso")
SEED = 20261021

# (stratum, fleets, repo the rows worked in, rows taken). The custom-mcp-servers stratum is every fleet on that
# repo except infra, which has a stratum of its own; ui (luizhcrocha/fleet) and manager are left out.
STRATA = [
    (
        "custom-mcp-servers",
        [
            "perf",
            "ui-coordinator",
            "pipeline",
            "agent-tooling",
            "casos-work",
            "jev-search",
            "tests",
            "teses-positionings",
            "integrations",
            "file-upload",
        ],
        CMS,
        40,
    ),
    ("tstack", ["notes", "skills"], TSTACK, 10),
    ("infra", ["infra"], CMS, 5),
    ("picasso", ["picasso"], PICASSO, 5),
]
RESERVE = {"custom-mcp-servers": 10, "tstack": 3, "infra": 1, "picasso": 1}
# A row qualifies only when its repo's store already held this share of today's notes at the row's start: a row
# replayed against a store that barely existed tests nothing but the forward cut.
STORE_SHARE = 0.25
POOL_DEPTH, POOL_KEEP = 50, 10
# Cross-repo rows (advisor ruling for e1, 2026-10-21): real rows have about 1 no-answer in 15, too few to measure
# abstention, so some rows not taken from a stratum have their task asked of another repo's store, the pairs whose
# subjects overlap least and whose store already held a quarter of its notes at the row's start (picasso's rows all
# started before custom-mcp-servers' store did). (stratum the task comes from, store asked, rows). Scored apart.
CROSS = [("custom-mcp-servers", PICASSO, 8), ("picasso", TSTACK, 7)]

# SELECTOR.md's frozen dev set (skills-f5): never sampled.
DEV_ROWS = {
    "perf:i10",
    "perf:i46",
    "perf:i74",
    "ui-coordinator:a29",
    "ui-coordinator:a105",
    "ui-coordinator:a161",
    "ui-coordinator:a236",
    "ui-coordinator:a260",
    "notes:w2",
    "notes:w3",
}

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_HIT_RE = re.compile(r"^([0-9A-HJKMNP-TV-Z]{26}) \S+ \[")
_ABSTAIN_RE = re.compile(r"^memo: nothing( fits| on .*)$")


class Run(NamedTuple):
    output: str
    seconds: float


def ulid_ms(ulid: str) -> int:
    """The creation time, in Unix milliseconds, that a ULID's first ten characters carry."""
    if not _ULID_RE.match(ulid):
        raise ValueError(f"not a ULID: {ulid!r}")
    ms = 0
    for ch in ulid[:10]:
        ms = ms * 32 + _CROCKFORD.index(ch)
    return ms


def parse_recall(output: str) -> list[str]:
    """The note ids a `memo recall` printed, in order; [] when it abstained ("memo: nothing fits", master's
    "memo: nothing on '...'", or no output). Anything else is an error, never an abstention."""
    ids = []
    for line in output.splitlines():
        if not line.strip():
            continue
        if m := _HIT_RE.match(line):
            ids.append(m.group(1))
        elif _ABSTAIN_RE.match(line):
            continue
        else:
            raise ValueError(f"unreadable recall output line: {line!r}")
    return ids


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def score(gold: list[dict], runs: dict[str, Run], k: int = 3) -> dict:
    """Score one recall command's runs against the gold rows.

    A row with a useful (U) note is an answer row, one with none a no-answer row. Per answer row, P@k is the useful
    notes among the first k hits over k slots; a hit dated after the row's start (the forward cut) is neither hit nor
    miss: it leaves the k hits and takes its slot with it. A row whose every hit is cut is left out of every rate,
    and counted. An abstention (no hit printed) returns 0 hits, so P@k = 0. A hit no reader labelled counts as not
    useful, and is counted."""
    precisions, latencies = [], []
    abstained = {"answer": 0, "none": 0}
    totals = {"answer": 0, "none": 0}
    cut = unjudged = all_cut = 0
    for row in gold:
        run = runs[row["id"]]
        latencies.append(run.seconds)
        hits = parse_recall(run.output)[:k]
        kept = [h for h in hits if ulid_ms(h) < row["start_ms"]]
        cut += len(hits) - len(kept)
        unjudged += sum(1 for h in kept if h not in row["pool"])
        if hits and not kept:
            all_cut += 1
            continue
        kind = "answer" if row["useful"] else "none"
        totals[kind] += 1
        if not hits:
            abstained[kind] += 1
        if kind == "answer":
            useful = set(row["useful"])
            precisions.append(sum(1 for h in kept if h in useful) / (k - (len(hits) - len(kept))))
    return {
        "rows": len(gold),
        "answer_rows": len(precisions),
        "no_answer_rows": totals["none"],
        "p_at_3": rate(sum(precisions), len(precisions)),
        "correct_abstain": rate(abstained["none"], totals["none"]),
        "false_abstain": rate(abstained["answer"], totals["answer"]),
        "p95_s": percentile(latencies, 95) if latencies else float("nan"),
        "max_s": max(latencies, default=float("nan")),
        "future_hits_cut": cut,
        "unjudged_hits": unjudged,
        "rows_all_cut": all_cut,
    }


def rate(n: float, d: int) -> float:
    return n / d if d else float("nan")


def cohen_kappa(a: list[str], b: list[str]) -> float:
    """Cohen's kappa of two raters' labels over the same items."""
    if len(a) != len(b) or not a:
        raise ValueError("two label lists of the same, non-zero length")
    n = len(a)
    observed = sum(1 for x, y in zip(a, b) if x == y) / n
    chance = sum((a.count(c) / n) * (b.count(c) / n) for c in set(a) | set(b))
    return 1.0 if chance == 1 else (observed - chance) / (1 - chance)


# --- the machine: ledgers, recall runs --------------------------------------------------------------------------


def ledgers() -> dict[str, str]:
    """Fleet name -> ledger dir: the fleet registry's entries (live and forgotten), then the host-served fleets."""
    home = Path(os.environ.get("FLEET_HOME") or HOME / ".local/state/fleet-board")
    found: dict[str, str] = {}
    for f in sorted(glob.glob(str(home / "*.json"))) + sorted(glob.glob(str(home / "names/*.json"))):
        entry = json.loads(Path(f).read_text())
        found.setdefault(Path(f).stem, os.path.realpath(entry["dir"]))
    taken = set(found.values())
    for d in sorted(glob.glob(str(HOME / ".local/state/fleet/*/state.json"))):
        real = os.path.realpath(os.path.dirname(d))
        if real not in taken:
            found.setdefault(os.path.basename(real), real)
    return found


_PATH_RE = re.compile(r"[\w.@~*{}+-]+(?:/[\w.@~*{}+-]*)+|[\w-][\w.-]*\.[A-Za-z]{1,5}\b")


def lane_paths(lane) -> list[str]:
    """The path-like words of a lane, globs cut off: ['bench/suites/x/**', 'g2.ts'] -> ['bench/suites/x', 'g2.ts']."""
    text = " ".join(lane) if isinstance(lane, list) else str(lane or "")
    out = []
    for tok in _PATH_RE.findall(text):
        tok = re.split(r"[*{]", tok)[0].strip("}~-").rstrip("/.")
        if tok and not tok.startswith("/") and re.search(r"[A-Za-z]", tok) and tok not in out:
            out.append(tok)
    return out


def tracked(repo: str) -> list[str]:
    files = subprocess.run(["git", "-C", repo, "ls-files"], capture_output=True, text=True, check=True).stdout
    paths = set()
    for f in files.splitlines():
        parts = f.split("/")
        paths.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
    return sorted(paths)


def resolves(path: str, paths: list[str]) -> bool:
    return any(p == path or p.endswith("/" + path) for p in paths)


def _start_ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def store_since(memo: str, repo: str, share: float) -> int:
    """The instant (ms) by which the repo's memo held `share` of the project notes it holds today."""
    out = subprocess.run(
        [memo, "--cwd", repo, "export", "--json"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout
    items = [json.loads(line) for line in out.splitlines() if line.strip()]
    times = sorted(ulid_ms(i["id"]) for i in items if str(i.get("scope", "")).startswith("project"))
    return times[min(len(times) - 1, math.ceil(share * len(times)))]


def cmd_sample(a) -> None:
    rng = random.Random(a.seed)
    found = ledgers()
    out = []
    left: dict[str, list[dict]] = {}
    for stratum, fleets, repo, n in STRATA:
        paths = tracked(repo)
        since = store_since(a.memo, repo, STORE_SHARE)
        cands = []
        for fleet in fleets:
            state = json.loads(Path(found[fleet], "state.json").read_text())
            for ag in state["agents"]:
                rid = f"{fleet}:{ag['id']}"
                lanes = lane_paths(ag.get("lane"))
                if (
                    ag.get("status") != "done"
                    or rid in DEV_ROWS
                    or ag["id"] == "advisor"
                    or not ag.get("task")
                    or not ag.get("started")
                    or _start_ms(ag["started"]) < since
                    or not any(resolves(p, paths) for p in lanes)
                ):
                    continue
                cands.append(
                    {
                        "id": rid,
                        "fleet": fleet,
                        "agent": ag["id"],
                        "stratum": stratum,
                        "repo": repo,
                        "started": ag["started"],
                        "start_ms": _start_ms(ag["started"]),
                        "task": ag["task"],
                        "lane": ag.get("lane"),
                        "lane_paths": lanes,
                    }
                )
        cands.sort(key=lambda r: r["id"])
        rng.shuffle(cands)
        take = n + RESERVE[stratum]
        if len(cands) < take:
            sys.exit(f"sample: {stratum} has {len(cands)} rows, needs {take}")
        for i, r in enumerate(cands[:take]):
            out.append(r | {"kind": "real", "batch": "primary" if i < n else "reserve"})
        left[stratum] = cands[take:]
        print(f"{stratum}: {len(cands)} candidate rows, took {n} + {RESERVE[stratum]} reserve", file=sys.stderr)
    cross_rng = random.Random(a.seed + 1)
    for stratum, store, n in CROSS:
        since = store_since(a.memo, store, STORE_SHARE)
        cands = [r for r in left[stratum] if r["start_ms"] >= since]
        cross_rng.shuffle(cands)
        if len(cands) < n:
            sys.exit(f"sample: {stratum} has {len(cands)} rows left for {store}, needs {n}")
        out += [
            r | {"id": "x:" + r["id"], "kind": "cross", "batch": "cross", "home": r["repo"], "repo": store}
            for r in cands[:n]
        ]
        print(f"cross: {n} of {len(cands)} {stratum} rows asked of {store}", file=sys.stderr)
    write_jsonl(a.out, out)


def recall(cmd: list[str], repo: str, words: list[str], timeout: float = 120) -> Run:
    t0 = time.monotonic()
    p = subprocess.run(
        [*cmd, "--cwd", repo, "--", *words], cwd=repo, capture_output=True, text=True, timeout=timeout, check=False
    )
    took = time.monotonic() - t0
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} exited {p.returncode}: {p.stderr.strip()[:300]}")
    return Run(p.stdout, took)


def cmd_pool(a) -> None:
    rows = read_jsonl(a.rows)
    out = read_jsonl(a.out) if a.keep and Path(a.out).exists() else []
    done = {r["id"] for r in out}
    for r in rows:
        if r["id"] in done:
            continue
        task = r["task"].split()
        lines: dict[str, str] = {}
        depth = str(POOL_DEPTH)
        queries = [
            (["recall", "--limit", depth], task, POOL_KEEP),
            (["recall", "--limit", depth], r["lane_paths"], POOL_KEEP),
            (["recall", "--live", "--limit", "3"], task, 3),
        ]
        for args, words, keep in queries:
            if not words:
                continue
            run = recall([a.memo, *args], r["repo"], words)
            before = [
                line
                for line in run.output.splitlines()
                if (m := _HIT_RE.match(line)) and ulid_ms(m.group(1)) < r["start_ms"]
            ]
            for line in before[:keep]:
                lines.setdefault(line[:26], line)
        out.append(r | {"pool": sorted(lines), "pool_lines": lines})
        print(f"{r['id']}: {len(lines)} notes", file=sys.stderr)
    write_jsonl(a.out, out)


def cmd_packets(a) -> None:
    rows = read_jsonl(a.pooled)
    if a.ids:  # in the order given
        by_id = {r["id"]: r for r in rows}
        rows = [by_id[i] for i in a.ids.split(",")]
    Path(a.dir).mkdir(parents=True, exist_ok=True)
    for b in range(0, len(rows), a.size):
        batch = rows[b : b + a.size]
        parts = [f"# Reader packet {a.prefix}{b // a.size + 1}: {len(batch)} rows\n"]
        for r in batch:
            parts.append(
                f"## Row {r['id']}\n\nRepo: {r['repo']}\nStarted: {r['started']}\n\nTask: {r['task']}\n\n"
                f"Lane: {json.dumps(r['lane'], ensure_ascii=False)}\n\nNotes ({len(r['pool'])}):\n"
            )
            parts.extend(f"- {line}" for line in r["pool_lines"].values())
            parts.append("")
        path = Path(a.dir, f"{a.prefix}{b // a.size + 1}.md")
        path.write_text("\n".join(parts) + "\n")
        print(path)


def load_labels(files: list[str]) -> dict[str, dict[str, str]]:
    labels: dict[str, dict[str, str]] = {}
    for f in files:
        for rid, notes in json.loads(Path(f).read_text()).items():
            labels.setdefault(rid, {}).update({i: str(v).strip().upper() for i, v in notes.items()})
    return labels


def cmd_gold(a) -> None:
    labels = load_labels(a.labels)
    out = []
    for r in read_jsonl(a.pooled):
        if r["id"] not in labels:
            continue
        got = labels[r["id"]]
        missing = [i for i in r["pool"] if got.get(i) not in ("U", "N")]
        if missing:
            sys.exit(f"gold: row {r['id']} has {len(missing)} unlabelled notes, first {missing[0]}")
        keep = {
            k: r[k]
            for k in (
                "id",
                "fleet",
                "agent",
                "stratum",
                "repo",
                "started",
                "start_ms",
                "task",
                "lane",
                "lane_paths",
                "batch",
                "pool",
            )
            if k in r
        }
        keep["kind"] = r.get("kind", "real")
        if "home" in r:
            keep["home"] = r["home"]
        keep["labels"] = {i: got[i] for i in r["pool"]}
        keep["useful"] = [i for i in r["pool"] if got[i] == "U"]
        out.append(keep)
    write_jsonl(a.out, out)
    for kind in ("real", "cross"):
        rows = [r for r in out if r["kind"] == kind]
        answer = sum(1 for r in rows if r["useful"])
        print(
            f"{kind}: {len(rows)} rows, {answer} with a U, {len(rows) - answer} no-answer; "
            f"{sum(len(r['pool']) for r in rows)} labelled notes",
            file=sys.stderr,
        )


def cmd_agree(a) -> None:
    first, second = load_labels(a.first), load_labels(a.second)
    rows = sorted(set(first) & set(second))
    pa, pb, ra, rb = [], [], [], []
    for rid in rows:
        ids = sorted(set(first[rid]) & set(second[rid]))
        pa += [first[rid][i] for i in ids]
        pb += [second[rid][i] for i in ids]
        ra.append("U" if "U" in first[rid].values() else "N")
        rb.append("U" if "U" in second[rid].values() else "N")
    same = sum(1 for x, y in zip(pa, pb) if x == y)
    print(f"rows {len(rows)}, notes {len(pa)}")
    print(
        f"note labels: raw {same}/{len(pa)} = {same / len(pa):.3f}, kappa {cohen_kappa(pa, pb):.3f} "
        f"(U: first {pa.count('U')}, second {pb.count('U')})"
    )
    rsame = sum(1 for x, y in zip(ra, rb) if x == y)
    print(f"row has a U: raw {rsame}/{len(ra)} = {rsame / len(ra):.3f}, kappa {cohen_kappa(ra, rb):.3f}")


def cmd_score(a) -> None:
    gold = read_jsonl(a.gold)
    cmd = a.command[1:] if a.command[:1] == ["--"] else a.command
    for repo in sorted({r["repo"] for r in gold}):  # one untimed call per repo brings its index up to date
        recall(cmd, repo, ["warm"])
    runs = {r["id"]: recall(cmd, r["repo"], r["task"].split()) for r in gold}
    sets = {kind: [r for r in gold if r.get("kind", "real") == kind] for kind in ("real", "cross")}
    reps = {kind: score(rows, runs) for kind, rows in sets.items() if rows}
    if a.json:
        print(json.dumps({"command": cmd} | reps))
        return
    print(f"command: {' '.join(cmd)} --cwd <row repo> -- <task words>")
    for kind, rep in reps.items():
        print(f"\n{kind} rows" + (" (a task asked of another repo's store)" if kind == "cross" else ""))
        print_report(rep)


def print_report(rep: dict) -> None:
    print(f"rows {rep['rows']}: {rep['answer_rows']} scored for P@3, {rep['no_answer_rows']} no-answer")
    print(f"P@3 over U rows    {rep['p_at_3']:.3f}")
    print(f"correct-abstain    {rep['correct_abstain']:.3f}")
    print(f"false-abstain      {rep['false_abstain']:.3f}")
    print(f"latency p95 / max  {rep['p95_s']:.3f} s / {rep['max_s']:.3f} s")
    print(
        f"hits after the row's start cut {rep['future_hits_cut']}; unjudged hits {rep['unjudged_hits']}; "
        f"answer rows with every hit cut {rep['rows_all_cut']}"
    )


def read_jsonl(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path: str, rows: list[dict]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    print(f"wrote {len(rows)} rows to {path}", file=sys.stderr)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="memo_eval", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--memo", required=True, help="the memo whose export dates each repo's store")
    s.add_argument("--out", default=str(STATE / "rows.jsonl"))
    s.add_argument("--seed", type=int, default=SEED)
    s = sub.add_parser("pool")
    s.add_argument("--rows", default=str(STATE / "rows.jsonl"))
    s.add_argument("--memo", required=True, help="the memo whose recall builds the pool")
    s.add_argument("--out", default=str(STATE / "pooled.jsonl"))
    s.add_argument("--keep", action="store_true", help="keep the rows already pooled in --out; pool only new ones")
    s = sub.add_parser("packets")
    s.add_argument("--pooled", default=str(STATE / "pooled.jsonl"))
    s.add_argument("--dir", required=True)
    s.add_argument("--ids", help="comma-separated row ids (default: every row)")
    s.add_argument("--size", type=int, default=10)
    s.add_argument("--prefix", default="p")
    s = sub.add_parser("gold")
    s.add_argument("--pooled", default=str(STATE / "pooled.jsonl"))
    s.add_argument("--labels", nargs="+", required=True, help="the first reader's label files")
    s.add_argument("--out", default=str(STATE / "gold.jsonl"))
    s = sub.add_parser("agree")
    s.add_argument("--first", nargs="+", required=True)
    s.add_argument("--second", nargs="+", required=True)
    s = sub.add_parser("score", usage="memo_eval score [--gold G] [--json] -- MEMO recall [ARGS...]")
    s.add_argument("--gold", default=str(STATE / "gold.jsonl"))
    s.add_argument("--json", action="store_true")
    s.add_argument("command", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    {
        "sample": cmd_sample,
        "pool": cmd_pool,
        "packets": cmd_packets,
        "gold": cmd_gold,
        "agree": cmd_agree,
        "score": cmd_score,
    }[a.cmd](a)


if __name__ == "__main__":
    main()
