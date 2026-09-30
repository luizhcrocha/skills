+++
id = "01M3PGJEG111KRBNTQRQY3SXVX"
kind = "fact"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-29T12:00:00Z"
refs = ["claude-mem:sum:3022", "claude-mem:sum:3027", "claude-mem:sum:3029"]
+++
Plan usage % on a personal plan is only in the status line's JSON input (rate_limits.five_hour/seven_day: used_percentage, resets_at). Hooks and CLI never get it; ccstatusline's ~/.cache/ccstatusline/usage.json lags 1-1.5 h. usage.py capture wraps the status line to record it.
