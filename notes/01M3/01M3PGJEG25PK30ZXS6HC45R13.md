+++
id = "01M3PGJEG25PK30ZXS6HC45R13"
kind = "fact"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-09-29T12:00:00Z"
refs = ["claude-mem:sum:3039", "claude-mem:sum:3563", "claude-mem:sum:3613"]
+++
Coordinator cost is mostly re-reading its own context (~99% cache hits; one read 391M cached vs 670k written), ~3-4% of fleet spend. Savings come from fewer/shorter turns, not cheaper models; Sonnet 5.5 (not haiku) only pays on read-heavy, short-result legwork.
