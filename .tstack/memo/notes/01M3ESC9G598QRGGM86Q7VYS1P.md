+++
id = "01M3ESC9G598QRGGM86Q7VYS1P"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-26T12:00:00Z"
refs = ["claude-mem:sum:2788", "claude-mem:sum:2783"]
+++
The Skill tool refuses user-invoked skills (e.g. implement) for workers with an error pointing to SKILL.md by path, so briefs should tell workers to read the SKILL.md. Skill resolution must check both ~/.claude and project-local .claude.
