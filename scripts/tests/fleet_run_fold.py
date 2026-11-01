#!/usr/bin/env python3
"""A stand-in for fleet-run with the cloud's real answer: $FOLD_PROGRAMS holds the programs so far, the one on stdin
joins them, all run again through a fleet checkout's real prelude and fold (fleet_fold.mjs), and this prints what the
last came to, as the client prints a program's outcome. Exit 0 completed, 2 a program that threw. `--types` is no use
here: nothing but the test calls this."""

import json
import os
import subprocess
import sys
from pathlib import Path

FOLD = Path(__file__).resolve().parent / "fleet_fold.mjs"
log = Path(os.environ["FOLD_PROGRAMS"])
programs = json.loads(log.read_text()) if log.exists() else [{"name": "setup", "body": "return records.apply(ops);\n"}]
programs.append({"name": f"p{len(programs)}", "body": sys.stdin.read()})
done = subprocess.run(["node", str(FOLD), os.environ["FOLD_CHECKOUT"]], capture_output=True, text=True, check=False, timeout=60,
                      input=json.dumps({"gate": os.environ["FOLD_GATE"], "programs": programs}))
if done.returncode != 0:
    sys.exit(done.stderr)
last = json.loads(done.stdout)[-1]
if "thrown" in last:
    print(last["thrown"], file=sys.stderr)
    sys.exit(2)
log.write_text(json.dumps(programs))
print(json.dumps({"status": "completed", "ops": last["applied"], "result": last["returned"]}))
