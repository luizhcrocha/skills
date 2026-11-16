# Bug hunt

The [review](SKILL.md) option for a diff over about 2,000 changed lines (lockfiles and generated files left out), where two readers would skim. It hunts defects, not standards, instead of or after the two axes.

**Cost, stated when you offer it.** An estimate for 2,000 lines: about 7 slices, 14 readers and 7 second looks at about 60k tokens each, plus one prover per kept claim at about 80k, so about 1.5 million tokens, five to ten times the two axes. Run it only on a yes, or when the coordinator's Integrate rule calls for it.

1. **Slices.** Cut the diff into slices of about 300 lines along module seams (one module and its tests per slice), never mid-function.
2. **Readers that over-report.** Two `general-purpose` Reviewers ([models.md](../../../docs/models.md)) per slice, in parallel, each told to list every place the code could be wrong (a claim: file and line, what breaks, the input that breaks it), with no filtering: a false claim costs one look, a missed one ships.
3. **A second look.** One fresh Reviewer per slice reads both lists against the code and keeps the claims it cannot rule out, each with why.
4. **Claim-only provers.** One Verifier ([models.md](../../../docs/models.md)) per kept claim, given the claim alone (not the reader's reasoning), writes a failing test or a repro that shows it. A claim no prover can show is reported as unproven, not as a finding.

Report the proven findings, then the unproven claims. Record it as a `reviewed` event ([LEDGER.md](LEDGER.md)) with the proven count.
