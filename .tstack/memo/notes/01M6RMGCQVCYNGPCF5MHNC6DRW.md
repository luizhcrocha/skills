+++
id = "01M6RMGCQVCYNGPCF5MHNC6DRW"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "a39c4558-0e1f-4d8a-ad62-147691d3f6f3/interactive"
at = "2026-11-06T14:34:21Z"
+++
Fleet one-time grants are reserved in PreToolUse on purpose: parallel calls race for one grant. As its own hook process the fleet can't see a tstack-hook deny, so that call still spends its grant; a fix releases the reservation, never moves taking to PostToolUse.
