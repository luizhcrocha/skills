# Issue / Ticket Tracker (Jira, Wrike, GitHub Issues)

## What this source contains

- Issues and tasks describing features, bugs, and their motivation
- Epics, parent tasks and projects (broader initiative → specific tickets)
- Comments (clarifications, scope changes, "why we're doing this" rationale)
- Labels, components, custom fields (e.g. `compliance`, `customer-request`, `perf`) that signal the type of motivation
- Status history that explains scope changes
- Linked PRs, commits and attachments (specs, PRDs)

The tracker is where the product or business forcing function lives: the "we're doing this because the client asked" or "this is for the Q3 compliance initiative" layer.

## Company data rule

This is a company source. Search it freely; report only the engineering rationale: the decision, the constraint, the date, who decided in role terms. Client names, case details, personal data and ticket contents stay out of your findings: paraphrase, and cite the ticket id so a reader with access can check it.

## How to search it

Use whichever of these the session has. Tool names below are the servers' documented ones; confirm them in your tool list (ToolSearch with `jira`, `wrike`), since a prefix like `mcp__claude_ai_Atlassian__` varies by connection. A server that answers with a login prompt or exposes only `authenticate`: stop and report "needs login".

**Jira** (Atlassian Rovo MCP, through claude.ai or the `data` plugin's `atlassian` server; not connected in the session this playbook was written in):

1. **Linked tickets first.** Ticket keys in change descriptions or PR bodies (`ENG-1234`): `getJiraIssue`, read the description and every comment.
2. **JQL search.** `searchJiraIssuesUsingJql` with `text ~ "<feature or symbol>"`, narrowed by `project`, `labels`, `created >= <date>`. Try several phrasings. `search` (Rovo) searches Jira and Confluence together in natural language.
3. **Walk the tree.** From a sub-task, fetch the parent and the epic: sub-tasks are tactical, parents carry the why. `getJiraIssueRemoteIssueLinks` shows linked PRs and pages.
4. **Labels, components, fix versions.** They hint at the category of motivation and tie work to a deadline.

**Wrike** (Wrike MCP; not connected in the session this playbook was written in):

1. **Search tasks.** `wrike_search_tasks` by the feature name, symbol or business term, then the task itself for its description, status and parent folder or project.
2. **Comments.** `wrike_get_task_comments`: decisions are usually recorded in comments, not in the description.
3. **The project around it.** The folder or project a task sits in often names the initiative that motivated it.

**GitHub Issues** (`gh`, run from the repo's main workspace):

```
gh issue list --state all --search "<feature or symbol>" --limit 50
gh issue view <n> --comments
gh pr view <n> --json closingIssuesReferences
gh search issues "<phrase>" --owner <org>
```

## What good evidence looks like here

- A description stating the business problem ("the client needs X because of their audit", reported in role terms)
- A comment recording a decision: "We went with approach B because approach A would require touching the billing service"
- A parent or epic titled like an initiative: "Q3 Enterprise Readiness", "Reduce Payment Failures"
- An attached spec or PRD
- Labels like `incident-followup`, `compliance`, `perf-regression`

## Common pitfalls

- **Scope drift.** The ticket the PR references may have been closed and reopened with a different scope. Read the whole history.
- **Mechanical templates.** Some teams require "Why" sections but fill them with boilerplate. Generic text ("improve user experience") is probably not a real answer.
- **Stale tickets.** Old tickets often reflect a version of the plan that changed. Check dates and cross-reference with the code's ship date.
- **Duplicate chains.** Follow duplicate-of links back to the canonical ticket.
- **No access.** If you can't open an issue or project, note it as a gap rather than guessing.

## What to return

For each relevant ticket:
- Tracker and ticket ID, title in neutral terms
- The motivation, paraphrased, with the comment or field it came from
- Labels, parent or epic, project
- Created and closed dates; the author in role terms
- Link to the ticket
