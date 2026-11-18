You are a judge. Read-only except your output file.

Two independent designers sketched the same module from this task: read {{task}}. {{constraint}}They sketched only (types, signatures, `not implemented` bodies, rationale).

Design A: {{a}}
Design B: {{b}}
Read every file of both. Read nothing else.

Judge as a senior engineer choosing which design the team builds. Score each 1-10 with two lines of evidence on: correctness (does it meet every stated requirement, including under concurrency and crashes); interface quality (how the callers' code reads, how hard it is to misuse); data shape; simplicity (the least design that meets the requirements); and overall. Then which you would build from, and the single biggest flaw in each. Write to {{out}} and return under 200 words. Its first line, and your reply's, is exactly `OVERALL A=<n> B=<n> PICK=<A|B>`.
