+++
id = "01M3ESC9G3BNCG8JH0QAR0PCRR"
kind = "decision"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-26T12:00:00Z"
refs = ["claude-mem:sum:2792", "claude-mem:sum:2793"]
+++
Chose Python stdlib over Deno+Hono for the coordinator/fleet scripts and dashboard server: they must run on every machine with zero added deps (python3 is on all NixOS hosts). Reconsider only if an API layer (POSTed events, SSE) is needed.
