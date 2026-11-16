+++
id = "01M6QVZ8TCETQ22S9WTNJGXK1H"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "a39c4558-0e1f-4d8a-ad62-147691d3f6f3/interactive"
at = "2026-11-06T07:25:34Z"
+++
Registry.live() and fleets.py live() delete every top-level *.json in ~/.local/state/fleet-board that is not a live fleet entry. New state goes in a subfolder (gate/, names/, tabs/); fleet tab's tabs.json lost its record this way (fixed 2026-11-06).
