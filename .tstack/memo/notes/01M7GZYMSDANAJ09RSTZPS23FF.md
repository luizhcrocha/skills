+++
id = "01M7GZYMSDANAJ09RSTZPS23FF"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "bbcba162-c0b0-4a65-ac2b-039d1cb0c2f8/interactive"
at = "2026-11-16T01:36:09Z"
+++
Finding an agent's Rex tab by grepping rex capture for 'Session: <name>' can match your own tab's scrollback; it closed this session once (2026-11-15). /proc env REX_BLOCK goes stale after restore. Check the block is not rex whoami's before block.close.
