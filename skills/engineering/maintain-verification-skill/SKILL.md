---
name: maintain-verification-skill
description: "Audit a verify-<app> skill and feature map against the app as it is now, with one live pass, then one change of proven fixes. Use for \"audit the verify skill\", a failed verify run, or UI churn."
---

# Maintain a verification skill

A feature map rots the moment the app changes. This is the upkeep loop for a skill made by `tstack:create-verification-skill`, or any project-local verification skill with a feature map. The unit of rigor is the feature, not every sentence: cover every feature file from source and exercise every feature live, without proving every bullet. Adapted from poteto's pstack (MIT).

## Outcomes

Pick one, and say which:

- **clean**: every feature got source and live coverage; nothing worth changing. No jj change.
- **changed**: one jj change of proven doc, harness or map corrections.
- **blocked**: coverage could not finish, or a proven fix could not land safely. Say exactly what blocked it.

## Edit scope

Only the verification skill's own directory (its SKILL.md, `features/`, and the helper scripts it owns). Product code stays untouched during a run: a behaviour the map describes that the app no longer does is either doc drift (fix the map) or a product regression (report it; the map keeps describing the intended behaviour).

## Pass

0. **Locate the target.** The project-local skill whose body has Launch and Drive sections and a feature map, usually `.claude/skills/verify-*/`. Several candidates → ask which one; none → stop and point at `tstack:create-verification-skill` rather than inventing a target.

1. **Index hygiene.** Read the feature map README and glob its sibling files. Fix missing, extra, duplicate or dead entries. Lightweight; no generated inventory.

2. **Source wave.** One read-only subagent per feature file, all spawned in one message, each playing the Researcher role ([MODELS.md](../../productivity/coordinator/MODELS.md)), `run_in_background: true`. Each explains "how does this user-facing feature work?" from source (`tstack:how`'s explorer brief fits), flags likely doc drift with `file:line` citations, and returns one concise live-verification recipe. Readers never drive the app and never edit files. Return shape: feature summary / source entry points / likely drift or none / one recipe.

3. **Reconcile.** Every feature file has a returned summary. Merge overlapping recipes into as few app states as practical. Spot-check cited drift; skip re-proving clean claims. Sweep recent churn for user-facing surfaces missing from the map (`jj log -r 'latest(::@ ~ root(), 50)' --stat` over the app's routes, commands and menus); require a concrete source path before calling one missing.

4. **Live pass.** Required even when source looks clean. You own all driving: never a subagent, so one pair of hands touches the instance. Follow the verification skill's own launch model: one long-lived instance driven serially for servers and UIs, or a fresh isolated session per drive for short-lived CLIs (the skill's Launch section decides, not this one). Exercise every feature at least once, and hold three invariants the whole pass, whatever the failure:
   1. Never drive an instance you have not health-checked since it last did something surprising: doctor before the first drive, doctor on each fresh session where sessions are the unit, doctor again after any failed drive. Where doctor cannot see the failure (a wedged UI on a healthy process), reset to a known state or relaunch rather than hoping.
   2. Evidence captured so far survives every cleanup, checked at its named location, not assumed.
   3. Nothing a drive started outlives its usefulness: failed-iteration residue (processes, tmux sessions, browser tabs you opened) is cleaned whether the session is stuck, exited or shared. For a shared instance, clean the residue, not the instance.

   A doctor failure caused by skill drift is drift: fix it under Edit scope and retry once, restarting only what the fix invalidated, before calling the pass `blocked`. A feature that cannot be reached is `verified-unreachable` only with the concrete prerequisite (auth, entitlement, OS, external state) and the route attempted; a prerequisite the map omits is drift. Any harness fix from triage gets re-driven live before it lands. Final teardown happens after the last drive of the run, re-proofs included, so nothing outlives the run (evidence stays, per the skill).

5. **Triage.** Wrong or missing user-POV description → doc drift, fix it. Working behaviour the harness cannot drive → harness gap, fix it; a harness fix follows the same helpers rule as generation (scripts executable, invocation shown in the skill body). App behaviour that is actually broken → product gap: record it for the user, and keep it out of this change.

6. **Land or stop.** For changed: one jj change of proven corrections, every changed file re-read first, described in the repo's style (`jj describe -m`, then `jj new`); under `/tuca-mode` it goes through the Land playbook. For clean or blocked: no change; report the outcome and the coverage honestly.

Keep concise run notes (features covered, unreachable prerequisites, confirmed drift, outcome) in the session scratchpad; they stay out of the change.

**Reply:** the outcome, a table of features (source coverage, live result: verified, verified-unreachable with its prerequisite, or failed), the drift fixed, product gaps found, and the change id when there is one.
