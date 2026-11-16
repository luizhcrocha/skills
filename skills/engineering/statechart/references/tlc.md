# TLC edge cases

Rules for reading the chart and its report beyond the basics in [SKILL.md](../SKILL.md).

## Marks in a regions chart

A state gets a mark when each combination of region states that includes it can break a rule. When a combination can break a rule and none of its states has a mark, each state in that combination gets a mark.

## VIEW and SYMMETRY

With a VIEW or a SYMMETRY, TLC counts states that it treats as the same as one state, and the chart draws that one state. An arrow can lead to it rather than to the state that the step reaches, and the report says so.

## CONSTRAINT and ACTION_CONSTRAINT

TLC checks the rules in each state past a CONSTRAINT or an ACTION_CONSTRAINT, but it does not explore that state or check it for deadlock, so a deadlock in such a state does not show. When TLC's shortest path for a rule ends in such a state, the chart draws that state, and the report gives that path. The chart does not draw the other states past the bound.

TLC also checks the rules after each step that an ACTION_CONSTRAINT excludes, even when it reaches the next state another way. When TLC's shortest path for a rule ends with such a step, the chart draws that step.

## The 100,000-state bound and properties

The bound adds a module that changes TLC's order of the variables, so for a property TLC can find a different counterexample than a run without the bound.

## TLC output

`tlc.out` is what TLC printed on the config as written. When the chart does not show the bug path of a rule that breaks, `tlc-RULE.out` is what TLC printed for the run that found it.

When TLC repeats its first warning, plain TLC prints it twice, but `tlc.out` shows it once, because TLC leaves the second copy out of the output that this command reads. That happens only when Java runs with `-XX:+UseParallelGC`, since otherwise TLC's first warning is its advice to pass that flag, which it prints once.
