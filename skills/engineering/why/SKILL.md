---
name: why
description: Find out why code is the way it is, from every record that could say so, as a cited, confidence-tiered answer. Use for "why does X work this way", "why did we pick Y", where a threshold or guard came from, regressions and postmortems, and before changing code whose reasons are unknown.
---

# Why

Investigate the motivation behind code: what forces gave it its shape. `how` answers what the code does and how it works; `why` answers why it is that way. Adapted from poteto's pstack (MIT).

Work as a **careful, cautious, precise investigator**: say what the record shows, what you infer from it, and what nobody wrote down. [references/epistemics.md](references/epistemics.md) is the confidence framework; the synthesizer follows it.

## 1. Target and question

The **target** is a chunk of code, a pattern, a feature or a named decision. The **question** is a rationale, a tradeoff, a motivating edge case, an external constraint, dead code, or a broad history sweep. A vague referent ("why do we do it this way?") gets your best reading from the conversation (open files, recent edits, what was just discussed), stated in one line so the user can redirect; then proceed.

## 2. Code anchor

Anchor the investigation in concrete code before anyone searches. Build inline:

```
jj log -r '::@' -- <path>                             # changes touching the file, newest first
jj file annotate <path> | sed -n '<start>,<end>p'     # last-touch change per line (annotate has no range flag)
jj show <change>                                      # a change's full description and diff
jj log -r 'description(substring-i:"<word>")'         # changes whose description names it
```

PRs: `gh pr list --search <commit sha> --state all` and `gh pr view <n> --json title,body,author,mergedAt,closingIssuesReferences,comments,reviews`. Run `gh` from the main workspace: a secondary jj workspace has no `.git`. In a repo without jj, the git equivalents (`git log --follow`, `git blame -L`).

The anchor: file paths and line ranges, key symbols, the changes touching the target (change id, commit id, date, first line), PR numbers, ticket ids named in descriptions or PRs. Every investigator gets it.

## 3. Discover the sources

List what this session can reach: the tools in the session's tool list, the deferred tools named in system reminders (load a schema with ToolSearch, e.g. `select:<name>` or a keyword like `jira`), servers reported as failed to connect, and the CLI sources the repo offers (`gh`, the Axiom skills under `.agents/skills` or `.claude/skills`, `wrangler` in its package or dev environment). Map each to one evidence category; one that fits two goes where its primary evidence is, and the ambiguity goes in the coverage map.

| # | Category | Sources | Playbook |
|---|---|---|---|
| 1 | Source control history | jj, `gh` PRs, code comments, tests | [code-archaeology.md](references/sources/code-archaeology.md) |
| 2 | Issue / ticket tracker | Jira (Atlassian MCP), Wrike MCP, GitHub Issues (`gh`) | [issue-tracker.md](references/sources/issue-tracker.md) |
| 3 | Long-form documents | the repo's docs, ADRs and `CONTEXT.md`; Quip, Confluence, Google Drive, Claude Docs | [docs.md](references/sources/docs.md) |
| 4 | Real-time team chat | Slack, Microsoft Teams | [chat.md](references/sources/chat.md) |
| 5 | Infrastructure observability | Axiom (skills, scripts, API), Cloudflare (`wrangler tail`, Workers observability) | [observability.md](references/sources/observability.md) |
| 6 | Error / exception tracking | error logs in Axiom, Cloudflare Workers errors | [errors.md](references/sources/errors.md) |
| 7 | Product analytics warehouse | BigQuery, Amplitude, Hex (the `data` plugin's servers) | [analytics.md](references/sources/analytics.md) |
| 8 | Agent memory | memo, the claude-mem archive (`recall`), fleet ledgers' decisions | [agent-memory.md](references/sources/agent-memory.md) |

Source control, the repo's docs and agent memory always have a source. A server that exposes only `authenticate` needs a login the user must do: record the category as "needs login (<server>)", never block on it. A server that failed to connect is "not connected".

## 4. Investigate: the full sweep

The sweep runs on every question, however small, recent or well documented the target looks: you gather the anchor, the investigators gather the evidence, and the answer comes from the synthesizer. Cost is paid on purpose here: a finding the record holds in a place you did not expect is the point.

One investigator per category that has a source, all spawned in one message: `general-purpose` agents on the default Sonnet (`model: "sonnet"`), in the background. One investigator owns one category; never ask one to cover two. Subagents inherit the session's MCP tools, so the MCP-backed categories work from a subagent; the brief tells them to write nothing.

Each gets:

1. [references/investigator-prompt.md](references/investigator-prompt.md), filled in.
2. Its category's playbook from the table.
3. [references/sources/incident-postmortem.md](references/sources/incident-postmortem.md) as well, when the target looks defensive (null checks, retries, timeouts, rate limits, feature flags, egress guards, OOM handlers).
4. The code anchor and the user's question, verbatim.

A category is skipped only with a written reason that goes in Sources Consulted: no source in this session (a gap, not a choice), needs login, not connected, or **provably** irrelevant ("error tracking skipped: a build-time script with no runtime path"). "Probably irrelevant" is not a reason. Done when every category has an investigator's findings or a written reason.

## 5. Synthesize

When every investigator has returned, spawn one synthesizer: `general-purpose` on the default Opus (`model: "opus"`), with [references/synthesizer-prompt.md](references/synthesizer-prompt.md) filled in: all findings (null results included), the skipped categories with their reasons, the code anchor, the question, and [references/epistemics.md](references/epistemics.md). It spot-checks citations and writes nothing.

## 6. Present

Present the synthesizer's output with light edits for clarity or conversation context. The confidence language stays as written: a hedge is a finding. Company sources stay at the level of engineering rationale (a decision, a constraint, a date, who decided in role terms); client names, case details, personal data and document contents stay out of the answer, whatever the findings carried.

The structure is the synthesizer's: The Question, The Code in Question, What We Found, What We Can Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted (one line per category, the empty and skipped ones with their reason), Confidence Summary. When the question precedes changing this code, add a **Preserve / Change / Avoid / Risk** set drawn from the findings, ready for planning.

A durable rationale the answer established (a decision and its reason, not recorded anywhere a later session reads) becomes a memo note of kind `decision` (the `memo` skill), unless memo already has it.

**Recency bias** is the failure to watch for: the newest change is rarely the whole reason. The current shape is usually an accretion of earlier decisions; trace back.
