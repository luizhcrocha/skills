+++
id = "01M3PGJEG7FJD32NHP06WW7ZA3"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-29T12:00:00Z"
refs = ["claude-mem:sum:3377", "claude-mem:sum:3388"]
+++
In agent shells `ls` is aliased to eza (zsh); eza piped through head hung for hours when the parent's stdin was a never-closing socket. Fixed by a wrapper closing stdin unless --stdin; use `command ls` otherwise.
