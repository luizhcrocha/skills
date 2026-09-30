# Error / Exception Tracking (error logs in Axiom, Cloudflare Workers errors)

## What this source contains

The archive of things that went wrong. For defensive, corrective or error-handling code it often holds the direct motivation: the specific exceptions, stack traces and frequencies that pushed someone to add a check, catch, retry or fallback.

There is no dedicated error tracker (no Sentry) today. The errors live in:

- **Axiom**: log events at error level, exceptions with their stack traces, error spans in traces.
- **Cloudflare Workers**: uncaught exceptions and failed invocations (Workers observability, `wrangler tail` live), with the outcome (`exception`, `exceededCpu`, `exceededMemory`, `canceled`) per invocation.

The most valuable thing it provides is **temporal correlation**: "error class X first appeared 2024-01-02, peaked at 500/day, and stopped after the deploy of 2024-01-15 that shipped the defensive check."

## Company data rule

This is a company source. Search it freely; report only the engineering rationale: the error class, its counts, its time window. Client names, case details and personal data carried in error payloads stay out of your findings: report the exception type, the message template with values elided, and the frame that passes through the target.

## How to search it

Axiom and Cloudflare come through the repo's skills and CLIs, as in the observability playbook: `scripts/init` and `scripts/discover-axiom` in the axiom-sre skill before any query; `wrangler` from the repo. Missing tool or credential → gap ("no access", "needs login").

1. **Group the errors.** Without a tracker's grouping, group yourself: APL over the error-level events in a window around the change, `summarize count() by <exception type or message template>, bin(_time, 1d)`. The target's function, file, error strings it checks for, and exception classes it catches are the filters.
2. **First seen and last seen** per group, against the change date: did the error start before the change, and stop after the deploy that carried it?
3. **Stack traces.** Pull a handful of events of the matching group: does the trace pass through the target, and do its fields match the conditions the target defends against?
4. **Deploys.** Line up the change's merge date with the deploy that shipped it (the Worker's deployment history, the repo's CI runs): a release carries many changes.
5. **Workers outcomes.** For Worker code, the per-invocation outcome counts show CPU and memory limits hit, a common motive for chunking, streaming or early returns.

## What good evidence looks like here

- An error group whose first seen is shortly before the target's change and last seen shortly after
- Stack traces that pass through or land on the target function, showing the exact failure it defends against
- An `exceededCpu`/`exceededMemory` run that stops after a change reworking the target's loop or buffer
- The target's change description or PR naming the error message or the query that found it

## Common pitfalls

- **Grouping drift.** Your own grouping by message template breaks when the message changes. An error that "stops" may have been renamed; look for a new group right after.
- **Deploy correlation is noisy.** A deploy contains many changes; the error stopping there doesn't prove the target fixed it. Cross-reference the exact change.
- **Silent fixes.** The error may stop because upstream changed, not because of the defensive code.
- **Sampling and retention.** Logs may be sampled; Workers observability keeps days, not months. A low count or an empty window is a gap to name, not a null result.

## What to return

For each relevant error group:
- Exception type and message template (values elided)
- Where: dataset or worker, the exact query
- First seen / last seen, counts per day around the change
- A representative stack frame through the target (file:line, no payload)
- Correlation with the target's change and deploy dates
- Relevance and strength: direct / circumstantial / weak
