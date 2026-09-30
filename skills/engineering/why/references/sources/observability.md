# Infrastructure Observability (Axiom, Cloudflare)

## What this source contains

The runtime record: what actually happened in production, as opposed to what was planned or discussed.

- **Logs and traces.** Events and spans per request. They hold the error conditions that motivated defensive code, and the slow paths behind timeouts and retries.
- **Metrics.** Counters, gauges, histograms the team instrumented. A metric's *presence* is itself evidence: someone thought this number worth watching.
- **Monitors and alerts.** Conditions the team decided warranted waking someone up. An alert on `rate_limit_hit > 10/min` is direct evidence the team worried about that threshold.
- **Dashboards.** Curated views: the charts show what the team considers important for a subsystem.
- **Deploy and platform config.** `wrangler.toml`/`wrangler.jsonc` limits, cron triggers, observability settings, and their history.

It answers "what was the production reality around the time this code was written?", which often explains the code's shape.

## Company data rule

This is a company source. Search it freely; report only the engineering rationale: the signal, the threshold, the date, who set it in role terms. Client names, case details and personal data found in log lines stay out of your findings: report counts, error classes and time windows, never raw log lines.

## How to search it

Neither tool is an MCP server here: they come through the repo's skills and CLIs. Look for them first; a missing tool or credential is a gap, reported as such.

**Axiom**, when the repo carries its skills (`.agents/skills/axiom-sre`, `.agents/skills/query-metrics`, or the same under `.claude/skills`): read the skill's SKILL.md and follow its rules, which include never printing a secret.

1. `scripts/init` (in the axiom-sre skill directory), then `scripts/discover-axiom` for the datasets. Query only dataset names discovery printed.
2. `scripts/axiom-query` with APL, **time-bounded** to a window bracketing the change (typically 30 days before and after): error strings, symbols, route names, with counts per day rather than raw rows.
3. `scripts/discover-alerts` for monitors whose query or threshold matches what the code enforces.
4. Metrics: the query-metrics skill's scripts discover metrics, tags and values in an `otel:metrics:v1` dataset, then query the trajectory around the change date.

No Axiom skill in the repo and no `axiom` CLI: report Axiom as "no access from this session".

**Cloudflare**, when the repo deploys Workers (a `wrangler.toml`/`wrangler.jsonc`):

1. The config and its history (the source-control investigator owns history; read the current limits, crons, `observability` block here).
2. `wrangler tail <worker> --format json` streams live logs only: useful for "does this still happen", never for history.
3. Workers observability (logs and traces kept by Cloudflare, queried in the dashboard or its API): history within its retention window. Without a way to query it from this session, name it as a gap.

`wrangler` comes from the repo (`npx wrangler`, its dev environment); an unauthenticated `wrangler` is "needs login".

## What good evidence looks like here

- An alert whose query and threshold match the constraint the code enforces (code clamps to 100, the alert fires above 100/min)
- A dashboard created by the target's author, with charts matching what the code measures or guards against
- A metric or log count spiking just before the change merged, and stable after
- Log lines with the error pattern the defensive code prevents, in the window before the change

## Common pitfalls

- **Correlation is not causation.** A spike before a change and calm after is suggestive, not definitive. Other changes may have landed in the same window.
- **Overfitting to the chart you found.** Dashboards are made by people and carry their framing. A chart named "retry success rate" shows the team cared about retries, not that a specific line exists because of it.
- **Vanished telemetry.** Retention is short (Workers observability especially). No data from the relevant window is a gap, not a null result.
- **Noise at scale.** Narrow by dataset, service, field and time; aggregate instead of dumping.
- **Instrumented ≠ caused.** A metric's existence says someone measured it, not that the code was added because of it. Cross-reference change dates.

## What to return

For each relevant item:
- Type (log pattern / trace / metric / alert / dashboard / config)
- Dataset, alert or worker name, and the exact query you ran
- Time window queried
- A compact numeric summary (counts, rates, first/last seen), never raw rows
- Temporal correlation with the target's change date
- Relevance: what it suggests about the target, and how strong the connection is
