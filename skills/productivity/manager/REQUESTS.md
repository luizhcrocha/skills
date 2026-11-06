# Asks across fleets

Read from the manager's [SKILL.md](SKILL.md) when several fleets need the same answer from the user, and when the user wants a kind of routine act to stop asking on every fleet.

## The same question from several fleets

When cards from several fleets need the same answer from the user, ask it once on your page: one decision, or one grilling with one question per matter. Only that asking card holds the question's words, so write it with what each fleet's card needs to know. Then tell each fleet, in your answer to its decision, which card and question to point its own card at. Each fleet keeps its card open and withdraws it only after the user answers (the coordinator's SESSIONS.md, "With a manager"). Relay the answer to those fleets as you relay any other. Never merge a `permission` or `rule` card: each is asked in its own fleet. Never make one card that two fleets own: it would hold two sets of words, and the cloud has no path between fleets.

For example, infra's d3 and billing's d7 both ask whether the legal terms stay in Postgres. You open grilling G5 and make it Q2. You tell infra "point d3 at manager/G5#q2" and billing "point d7 at manager/G5#q2". The user answers Q2 with (b). You relay it, and each fleet withdraws its card with the resolution "answered on manager/G5 Q2: (b) keep Postgres". Had the user answered on billing's d7 instead, that answer settles d7: the user's answer outranks the pointer.

A later change adds the card field (`asked_on: "FLEET/ID"` or `"FLEET/ID#qN"`) and lists a pointed card under its asking card instead of in the open count. Until then, each fleet notes the pointer in its card's why or its log.

## A standing approval for every fleet

When the user wants a kind of routine act to stop asking on every fleet, each team records it from the owner's own answer on that team's page: a team's cloud refuses an approval whose ref names another fleet's card, so no approval is copied from your page.

1. Agree the rule's exact wording with the user on your page (a decision when it is a choice), with its limits: spend over a stated cap (none stated: none allowed), a change of anyone's access, deleting data, and anything irreversible are still asked every time. One rule per approval.
2. Tell each fleet it concerns, with the wording word for word: each coordinator opens a card on its own page with `approval_question` and `approval_rule` set to that wording (the coordinator's APPROVALS.md, its DASHBOARD.md row "The user approves a kind of act once", and its PROGRAMS-CARDS.md, "The owner answers on the card"), and the owner answers yes there. Only that answer backs the team's approval.
3. The fleets record acts under it as notices, which reach you as fyi news.

To revoke it: the owner revokes it on each team's page (Revoke), and that team's coordinator records it. Nothing revokes it everywhere at once.
