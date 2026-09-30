# Incident & Postmortem Context

Not a separate source, a **cross-cutting angle**. Incidents often motivate defensive code ("we added this check after the X outage"), so if the target looks defensive (null checks, retry logic, timeout handling, rate limiting, feature flags), specifically hunt for incident history across every available source:

- **Long-form docs** (Quip, Confluence, Google Drive, the repo's docs): search for postmortems mentioning the target file, feature, or error string
- **Issue tracker** (Jira, Wrike, GitHub Issues): look for tickets labeled `incident`, `sev-*`, `postmortem-action-item`, `reliability`
- **Chat** (Slack, Teams): search `#sev-*` and `#incident-*` channels around the dates the target code was added
- **Source control**: change descriptions like "fix for incident", "add defensive check", "revert" followed by "re-apply with..." are strong signals
- **Observability** (Axiom, Cloudflare): alerts, monitors and dashboards created as postmortem action items; the log or metric window of the incident
- **Error tracking** (error logs in Axiom, Workers exceptions): error classes whose first-seen/last-seen window aligns with the target's ship date, stack traces through the target
- **Product analytics** (BigQuery, Amplitude, Hex): product-analytics events that classify an error condition (client-reported failures, user-visible retry events, etc.) often spike during an incident window. A drop in that event count after the target PR ships is circumstantial support that the target code resolved the user-visible symptom, even when observability and error-tracking signal is noisy.
- **Agent memory** (memo, the claude-mem archive, fleet ledgers): `gotcha` and `decision` notes naming the incident, and sessions that worked it

If you find an incident link, fetch the full postmortem. Postmortems typically have an "Action Items" section that ties directly to code changes. When multiple sources corroborate (an alert appears in a Jira ticket, which appears in a Quip postmortem, which appears in a Slack thread that links to the target PR, and the error-event count drops after the fix), the evidence is especially strong.

Worth spending time on when the code's defensive character makes an incident-driven origin plausible. Skip it for code that doesn't look defensive.

The company data rule holds here as in every company source: report the incident's engineering rationale (what failed, the action item, the date, who decided in role terms), never client names, case details or personal data.
