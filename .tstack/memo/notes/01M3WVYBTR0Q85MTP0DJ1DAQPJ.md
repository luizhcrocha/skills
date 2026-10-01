+++
id = "01M3WVYBTR0Q85MTP0DJ1DAQPJ"
kind = "decision"
scope = "project:luizhcrocha/skills"
by = "188230b9-476b-43a2-a5b8-1b0d66377be2/interactive"
at = "2026-10-01T23:14:11Z"
refs = ["hooks/tstack-hook"]
+++
No self-forwarding tstack-hook and no update notice: the hook stays each session's own copy; restart long-running fleet sessions after a release. Only bin/fleet forwards to the newest copy. Keeps the classifier's self-modification check strict.
