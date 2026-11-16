+++
id = "01M7JAR9XEY20GB37256SXRCAE"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "e8f155c8-6c58-43fc-b7c4-d318cfbbe25b/interactive"
at = "2026-11-16T14:04:10Z"
+++
Rex tab labels ignore the terminal title, so tabs need 'rex window rename'. An agent renames its Claude session by rex send '/rename X' + send-key enter to its own block; Claude Code queues it until the turn ends (skill rename-yourself).
