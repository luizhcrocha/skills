# Product Analytics Warehouse (BigQuery, Amplitude, Hex)

## What this source contains

The product and data view, as observability is the infra view: what users did, which experiments ran, how feature usage evolved, where a threshold constant came from.

- **Product analytics events.** Amplitude events and the warehouse tables they land in: feature invocations, clicks, accepts and rejects, client-reported errors.
- **Usage and billing data.** For cost- or volume-driven decisions.
- **Experiments and feature flags.** Exposure and outcome data. The schema is company-specific: probe before assuming names.
- **Warehouse metadata.** BigQuery's `INFORMATION_SCHEMA` (tables, columns, jobs with their bytes and duration): "was this query expensive?", "when did load spike?"
- **Analyses.** Hex projects where someone explored the data before a change. Read them when the Hex server is connected; otherwise name them as a gap.

## Company data rule

This is a company source. Search it freely; report only the engineering rationale: aggregates, distributions, dates, who decided in role terms. Client names, identifiers, personal data and row contents stay out of your findings: report counts, percentiles and first/last-seen timestamps, never rows.

## How to search it

These are the `data` plugin's MCP servers (`bigquery`, `amplitude`, `hex`; not connected in the session this playbook was written in). Confirm the tools in your tool list (ToolSearch with `bigquery`, `amplitude`, `hex`). A server that exposes only `authenticate`/`complete_authentication` needs a login only the user can do: stop and report "needs login (<server>)". Never block waiting for it.

**Orient before querying.** Schemas are company-specific. List datasets and tables, read the columns, before trusting a name (BigQuery: `INFORMATION_SCHEMA.TABLES` and `.COLUMNS`; Amplitude: its event and property listing tools).

**Time-bound every query.** Event tables are huge and unconstrained scans time out or cost money. Filter on the event timestamp with a window bracketing the change, typically about 30 days before and after. Use partitioned columns in BigQuery.

Patterns that tend to pay off:

1. **Usage trajectory.** Daily counts of the relevant event across the window. A step from zero to steady volume within a day or two of the merge is strong circumstantial evidence the change launched the feature; a decay to zero suggests a deprecation.
2. **Threshold origin.** Median / p99 / max of the relevant property in the 14 days *before* the change. A p99 that matches the target's constant suggests the number was chosen from data.
3. **Experiment or flag lookup.** Find the exposure data, then exposure counts by variant for the flag near the change date.
4. **Query history for migrations and perf rewrites.** BigQuery `INFORMATION_SCHEMA.JOBS` filtered on the query text naming the table or symbol, in a tight window, sorted by bytes processed or duration.
5. **Pipeline lineage.** If the target reads or writes a modeled table, the model's own history (in its repo) often carries the rationale: hand that lead to the source-control investigator.

## What good evidence looks like here

- An error-classifying event's count drops to near zero in the days after a defensive change
- An experiment's exposure data shows a concluded decision for the target's flag around the change date
- A pre-change p99 that equals the constant in the code

## Common pitfalls

- **Instrumented ≠ caused.** An event's existence means someone logged it, not that the code exists because of it. Pair with a change or PR citation.
- **Silent instrumentation changes.** A step in event volume may be a new event starting to be logged. Check for instrumentation changes in the same window.
- **Schema drift.** Properties evolve; a column today may not have existed when the target was written.
- **Retention cliff.** A window older than the data's retention is a gap, not a null result. Name it.
- **Unconfirmed tables.** Reporting from a table whose existence you never confirmed is the classic failure. Probe first.

## What to return

For each relevant finding:
- Type (product event / experiment exposure / usage or billing / query history / analysis)
- Server, fully qualified table or event name, and the exact query
- Time window queried
- A compact numeric summary (counts, percentiles, first/last-seen timestamps), never rows
- Temporal correlation with the target's change date
- Relevance and strength: direct / circumstantial / weak
