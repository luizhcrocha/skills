# Observability

Infra observability is designed with the work, never added as a last lane. It comes from the model and the evidence; each seam table's observation row says how that option is observed. For each thing the work runs (a service, a worker, a scheduled job, a queue, a deploy), the page's Observability section answers:

- **Signals.** The logs, metrics and traces it emits, by name, with their fields or labels.
- **Destination.** The stack the repo already uses, found in Design step 1. A new tool or service is Luiz's decision.
- **Health.** What working means as a number (an error rate, a latency, a freshness bound, a queue depth), the alert that fires when it breaks, who receives it and through what channel.
- **Diagnosis.** The dashboard or query Luiz opens when the alert fires, and what it shows for each failure state the statechart names.
- **Cost.** Volume, retention and price for any high-volume signal.

Work that runs nothing writes `none` there, with the reason. Done when every running piece has all five answers and Luiz's decisions on them are in the dossier.
