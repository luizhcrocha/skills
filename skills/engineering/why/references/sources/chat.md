# Team Chat (Slack, Microsoft Teams)

## What this source contains

- Real-time discussions of problems and decisions
- Incident channels where fire-drill decisions were made
- Design threads where tradeoffs were debated
- Questions answered by senior engineers that never reached a doc
- Post-merge discussions that explain why something was revisited
- DMs and group chats (searchable here only as far as the logged-in user's access reaches)

Chat is frequently where the real decisions got made, especially for smaller changes that didn't warrant a doc. It's also the most ephemeral source: threads get deleted, channels archived, retention cuts history off.

## Company data rule

This is a company source. Search it freely; report only the engineering rationale: the decision, the constraint, the date, who decided in role terms. Client names, case details, personal data and message contents stay out of your findings: paraphrase, and cite the permalink so a reader with access can check it.

## How to search it

Confirm the tools in your tool list (ToolSearch with `slack`, `teams`). A server that answers with a login prompt or exposes only `authenticate`: stop and report "needs login". Never make up findings for a source you could not search.

**Slack** (the slack plugin's MCP; connected when this playbook was written):

- `slack_search_public_and_private` (or `slack_search_public` when private access is refused): `keywords` are AND'd single words or "quoted phrases"; people, channels and dates go in `filters` (`from:<@U…>`, `in:<#C…>`, `after:YYYY-MM-DD`, `before:…`, `is:thread`). `sort: "timestamp"` for a date window.
- `slack_read_thread` (`channel_id`, `message_ts` of the parent) for the whole thread; `slack_read_channel` for the messages around a hit.
- `slack_search_channels` to find the likely channels by name.

**Microsoft Teams** (the Microsoft 365 MCP; not connected when this playbook was written): `chat_message_search` across chats and channels by keyword; `teams_list_channel_messages` to read a channel around a date, with the replies of a hit.

Queries that tend to pay off, in either tool:

1. **Author-bounded.** Messages from the change's author around its date. Limits scope dramatically and often hits gold.
2. **Keywords** for the feature name and key symbols, with casual phrasings and misspellings.
3. **PR or change links.** Search for the PR URL, `/pull/<number>`, or the short change id.
4. **Error strings.** If the code handles a specific error, search for it. Incident threads often surface.
5. **Channel-scoped.** Engineering, project, incident (`#incident-*`, `#sev-*`) and the owning team's channels.
6. **Thread traversal.** When you find a relevant message, read the whole thread. The decision often lives in the replies.

## What good evidence looks like here

- A thread where tradeoffs were explicitly debated ("I was going to use A but B is better because...")
- An incident channel message describing the bug the code prevents
- A reviewer's question and an authoritative answer from the author or lead
- A reference to a meeting where a decision was made
- A product owner's message explaining a client ask (reported in role terms)

## Common pitfalls

- **Retention cliff.** Old messages may be gone. If nothing turns up before a certain date, note the cliff.
- **Unsearched DMs.** Decisions made in DMs you cannot reach stay invisible. That's a known limitation; say so.
- **Jokes as decisions.** Chat is casual. "Lol just do the thing" isn't a decision, even if it preceded the commit. Look for considered discussion.
- **Context collapse.** A single message often reads differently in its thread. Always read the thread.
- **Auth failures.** Not authenticated → stop and report that the source wasn't searchable.

## What to return

For each relevant thread:
- Tool and channel name
- Permalink or thread ID
- Participants, in role terms
- Date range of the discussion
- The decision or constraint, paraphrased
- Context: what discussion or incident it was part of
