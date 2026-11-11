+++
id = "01M71MCC3TW6K73RG3GX1ET4V4"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "610e0012-8501-4929-8678-9b94b21f1920/interactive"
at = "2026-11-10T02:25:19Z"
+++
A devenv saved env can't move between jj workspaces by rewriting the root: evaluated store paths (scripts, devenv-shell-env, tasks.json) embed DEVENV_ROOT, so a seeded env runs the sibling's code. Only handing over a whole workspace reuses its env.
