# Long-Form Documents (the repo's docs; Quip, Confluence, Google Drive, Claude Docs)

## What this source contains

- The repo's own docs: `docs/`, ADRs (`docs/adr/`), `CONTEXT.md`, design notes, READMEs, plans
- Specs, RFCs and PRDs
- Meeting notes from design reviews
- Postmortems
- Runbooks that may explain defensive code
- Strategy documents that set priorities

Documents are where the why is written out before it becomes code. A significant feature usually has one. The repo's own docs are always available, so this investigator always runs; the company tools add to them when connected.

## Company data rule

Quip, Confluence, Google Drive and Claude Docs are company sources. Search them freely; report only the engineering rationale: the decision, the constraint, the date, who decided in role terms. Client names, case details, personal data and document contents stay out of your findings: paraphrase, and cite the document link so a reader with access can check it. The repo's own docs are not company sources in this sense: quote them.

## How to search it

**The repo** (always):

```
rg -l -i '<feature|symbol|term>' docs/ CONTEXT.md '*.md'
rg -l -i 'status:|decision|consequences' docs/adr
```

Read the matching docs in full; an ADR's Context and Consequences sections carry the why. `CONTEXT.md` names the project's terms: search with its vocabulary.

Company tools: use whichever the session has, confirmed in your tool list (ToolSearch with `quip`, `confluence`, `drive`). A server that answers with a login prompt or exposes only `authenticate`: stop and report "needs login".

**Quip** (the Coelho Rocha MCP; connected when this playbook was written):

1. `quip_search_threads` with the feature name, symbol, error string, or business term; several phrasings. `onlyMatchTitles: true` narrows a noisy term.
2. `quip_get_thread` for a hit's title, links and dates; `quip_read_document` to read it in full (paged: follow `nextCursor`), `quip_document_outline` for a long one first.
3. `quip_list_comments`: decisions often land in comments on a spec.

**Confluence** (Atlassian Rovo MCP; not connected when this playbook was written): `searchConfluenceUsingCql` (`text ~ "<term>"`, narrowed by `space`, `lastmodified`), or `search` (Rovo, natural language across Jira and Confluence); `getConfluencePage` to read in full, `getConfluencePageDescendants` for sub-pages holding alternatives or appendices.

**Google Drive** (the Google Drive MCP; not connected when this playbook was written): its search tool with the term and a modified-date window, then its fetch tool to read the document in full.

**Claude Docs** (connected when this playbook was written; no search tool): find candidates by title with the `Artifact` tool's `list` action (`scope: "all"`), read one with its `read` tool, and its `query` tool lists a doc's comment threads.

For every hit:

1. **Read the full content, not the preview.** Rationale is often buried mid-document.
2. **Follow child pages and links** within the same tool: alternatives considered, appendices, implementation notes.
3. **Time-bound** when you know when the code shipped: a spec written just before is the strongest lead.

## What good evidence looks like here

- A doc with a "Problem statement" or "Motivation" section matching the target code's purpose
- An "Alternatives considered" or "Rejected approaches" section
- A postmortem that names the target code as the fix for a specific incident
- Meeting notes recording "we decided X because Y", tied to the same author or date range as the change
- An ADR filled out non-trivially (status, context, decision, consequences)

## Common pitfalls

- **Outdated docs.** Specs are often written before implementation and not updated. The doc may describe a plan that changed. Cross-check against the actual change.
- **Doc vs. reality drift.** A spec may say "we'll do X" but the code does Y. Flag the divergence. The synthesizer will surface the contradiction.
- **Boilerplate templates.** Some orgs require a "Why" section that gets filled with fluff. Look for specificity.
- **Unlinked docs.** The most relevant doc may not be linked from anywhere. Broad keyword searches help.
- **Multiple drafts.** If a topic has several docs, find the finalized or most recently updated one. Check dates.
- **No access.** If you can't open a page, note it as a gap.

## What to return

For each relevant doc:
- Title (neutral terms for a company doc) and link or repo path
- Author (role, for a company doc) and last-updated date
- The motivation: quoted from a repo doc, paraphrased from a company doc, with its section
- Relevant linked pages
- Whether the doc is final or draft
