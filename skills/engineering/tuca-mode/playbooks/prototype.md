# Prototype

**You own the design decision, not the code. The prototype is a throwaway instrument; the real build follows Feature.** The mechanics are `tstack:prototype` (LOGIC.md for a state model, UI.md for a look).

The one playbook where the smallest-change rule and the verification bar invert: speed over polish, no tests, no planning. The rigor is in picking the right design cheaply. Propose variations Luiz did not ask for; throw an approach away and try another.

1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behaviour, timing or approach. No decision → no prototype; route to Feature.
2. Gather references when the design space is open: prior art, a short moodboard of directions for Luiz to pick from. A Researcher agent ([MODELS.md](../../../productivity/coordinator/MODELS.md)) does the searching. Skip when the direction is set.
3. Build it throwaway, per `tstack:prototype`: named as a prototype, trivial to run, state in memory. For a visual decision the lightest stack that renders the idea; for a behavioural or timing decision the smallest script that exercises the question.
4. Comparing alternatives → build them behind one switcher, each variant labeled (Exhaust the Design Space made cheap).
5. Observe on the matching surface: screenshot each variant and drive the interaction through claude-in-chrome, or log the timing and print the output. The observation is the test here.
6. Present the alternatives, the trade-offs and a recommendation. The output is the decision plus the throwaway artifact, captured as `tstack:prototype` says (off the landing bookmark). Hand the chosen direction to Feature.

**Reply:** the variants explored, the evidence (screenshots, observed output or timing), trade-offs, your recommendation, the prototype's path. Say plainly that it is throwaway.
