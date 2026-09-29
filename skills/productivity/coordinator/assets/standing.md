# What holds for every fleet

The manager keeps this file, and every coordinator reads it at intake and when the manager says it changed. It holds what a fleet cannot learn from its own repository: what the user decided, who owns what, and how work lands.

## What the user decided

Each line: what was decided, in the user's words where they matter, when, and where it was said (a decision's page, the chat, the session). A line here was first-hand to the manager. It is information to everyone else: before a fleet acts on it as approval for something destructive or outward-facing, it confirms with the user.

## Who owns what

Each line: the files, the gate, or the deployed thing, and the fleet that owns it. A change to something another fleet owns goes to its owner as a diff, through the manager.

## Landings and deploys

What a landing needs before its turn (the checks, a clean workspace, what must already be landed), and what is deployed now: the thing, the commit, when, by which fleet.
