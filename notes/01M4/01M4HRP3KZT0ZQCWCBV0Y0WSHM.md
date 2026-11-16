+++
id = "01M4HRP3KZT0ZQCWCBV0Y0WSHM"
kind = "preference"
scope = "project:luizhcrocha/skills"
by = "3642a3e1-f620-40cd-9c28-c4002130b266/interactive"
at = "2026-10-10T02:01:18Z"
+++
Luiz (2026-10-09): workers run only the tests their change touches (just test-changed plus specific suites); the coordinator runs the full gate once on the merged stack at release. Measured: 86% of worker wall time was waiting on tests, 14% model.
