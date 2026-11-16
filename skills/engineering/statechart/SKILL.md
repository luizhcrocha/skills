---
name: statechart
description: "Check a TLA+ model of a system that moves between states, such as a product flow, a protocol, or a service, and draw it as a Mermaid statechart. The report gives the shortest path to each state that breaks a rule. Use for /statechart, or to show a bug as a path through states."
disable-model-invocation: true
---

# Statechart

The chart shows how a system moves between states, in the words of the reader: the person who decides whether the behavior is right.

## Run

In a scratch folder outside the repo, write a TLA+ spec and its config, then run:

```sh
<skill dir>/scripts/statechart SPEC.tla [--config FILE] [--view FILE] [--out DIR]
```

`scripts/statechart.ts` is TypeScript, so run it with a runtime that executes TypeScript. The first run installs TLC and Java with mise and needs the network.

## Write the spec

- Write each rule the reader agrees to as an INVARIANT, about a screen, a result, a stored value or a message. If the model has no variable for a rule, add one. Never weaken a rule to make it hold.
- Write `Next` as a disjunction of the actions, such as `YouPressPlay \/ YouPressStop`. Otherwise TLC names every step `Next`.
- A state with no step out breaks `NoDeadlock`, even a correct end state. When an INVARIANT or a PROPERTY already has that name, the rule is `CHECK_DEADLOCK`. Add to `Next` an action that is true only in the end states and changes nothing, such as `Done == phase \in {"paid", "failed"} /\ UNCHANGED vars`, and label it in `step()`.
- TLC goes past a state that breaks a rule, so the chart shows the states after a bug, and a model with no limit on its states can run without end. Keep the constants small, or add a CONSTRAINT.

## Write the view

The judgment is yours: the words on each state and arrow, the phases and their colors, the title, and the report to the reader. The chart's part goes in a view module, passed with `--view`.

`state(vars)` returns the reader's words for a model state. Its type picks the chart's form:

- A string gives a flat chart: `export const state = (v) => (v.paid ? "Paid" : "Paying");`
- An array gives parent states: `export const state = (v) => v.main.split(".");`
- An object gives one parallel region per key: `export const state = (v) => ({ Playback: v.playback, Volume: v.volume });`

Label each state with what the reader sees or cares about, such as "Paying" or "Lease held, write pending", never a variable name. In `vars`, a TLA+ sequence is an object with keys from 1, so `v.pc[1]` is `pc[1]`, and a set is an array.

`step(action, from, to)` gets the TLC action name and the values before and after, and returns the arrow's label: what the user sees happen, such as "you press play" or "the connect fails", in place of the code or the TLA+ action. Give two actions that end the same in the chart the same label, so they share one arrow. When a value no label shows decides where a step goes, name the result, such as "the roster read fails".

The command calls `state()` and `group()` at most once per model state and `step()` at most once per step, and the chart and the report share those answers, so make each export depend only on its arguments. A step that stays in one label draws no arrow, so split the label when the reader must see that step.

Read [references/view.md](references/view.md) when a step occurs only under a condition, when you color phases or add a title, or when the chart passes about 20 arrows.

## Read the report

The command runs TLC on the config as written, with one worker, then removes each rule that breaks and reruns until no rule breaks. After the first break, each run stops at 100,000 distinct states. A run that reaches that bound or stops on an error lists the rules it did not check under "Rules not checked", unmarked on the chart: each can hold or break. To check one, remove the rules that break from the config, or make the model smaller.

A chart state that breaks a rule has the class `breaks`, or `mayBreak` when only some model states behind it break the rule. The Legend names the rules of each mark.

Read [references/tlc.md](references/tlc.md) when the chart has regions, when the config has a VIEW, SYMMETRY, CONSTRAINT or ACTION_CONSTRAINT, when a property's counterexample differs from plain TLC's, or to read `tlc.out` or a `tlc-RULE.out`.

## Show the chart

Show `chart.mmd` to the user as a `mermaid` code block. The chart's budget is 500 states, counted by TLC on the config as written. Above it, the chart draws only the paths to the rules that break, and with no break there is no `chart.mmd`. Each rule is still checked, and the report gives the state count and each bug path. To see the whole graph, make the model smaller.

Render with Pele, and with another renderer only when the user asks. For an image, or a chart too large to read as text, follow [references/render.md](references/render.md).

## Hand off

You are done when the person who decides has:

- each chart and its Mermaid text;
- one line per bug: the rule, the reader's sentence for that rule, and the path as the report numbers it, with which state breaks which rule when one mark names two;
- the steps the chart hides, when `step()` returns `null`;
- what the model leaves out;
- the command that makes the files again, with a new `--out` folder.

When the model describes code, replay each bug path against the real code, as a test or a live repro, one step per action. If a bug does not occur, treat the model as wrong until you show that it is not.
