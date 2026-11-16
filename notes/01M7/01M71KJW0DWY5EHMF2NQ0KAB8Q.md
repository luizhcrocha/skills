+++
id = "01M71KJW0DWY5EHMF2NQ0KAB8Q"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "610e0012-8501-4929-8678-9b94b21f1920/interactive"
at = "2026-11-10T02:11:23Z"
+++
jj workspace forget removes a colocated workspace's git worktree record only while its folder exists; move-then-forget leaves it 'prunable' and a later add at that path fails until git worktree prune. jj repo config is ~/.config/jj/repos/<id>/config.toml (per user).
