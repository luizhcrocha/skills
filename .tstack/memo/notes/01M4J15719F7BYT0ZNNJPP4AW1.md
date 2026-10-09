+++
id = "01M4J15719F7BYT0ZNNJPP4AW1"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "3642a3e1-f620-40cd-9c28-c4002130b266/interactive"
at = "2026-10-10T04:29:21Z"
+++
fleet's 'bun test --parallel' hangs under load: a worker busy-spins on a finished child that is never collected (oven-sh/bun#34069, fixed on main, not in 1.4.2). scripts/bun_files.py runs one bun test process per file as a workaround; remove it once Bun ships the fix.
