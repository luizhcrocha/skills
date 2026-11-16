# Messaging other sessions

tuca-mode's rule for messaging a fleet's coordinator or the manager, from this session or any that serves no fleet. With no `fleet` on PATH, no fleet exists to message.

A direct message wakes the session it reaches, and each wake re-reads its whole context. So message a fleet only when it must act: once, to the fleets affected (check `fleet waiting` and their ledgers first), every item for one fleet in one message. Never relay what another session already sent.

Release notes, FYIs and rule changes go to `fleet news post --from <this session's name> [--to <fleets>] --kind release|fyi|rule [--keep] "..."`, which wakes nobody.

The manager is not a mailbox: it keeps landings, the gate and cross-fleet judgement.
