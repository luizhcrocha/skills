# Eval

**You own the experiment design. Plan, blind, run, synthesize.** The harness is `claude plugin eval` (read `claude plugin eval --help` for the current flags): cases under the plugin's `evals/`, each a `case.yaml` or `prompt.md` plus `graders/*.md`, run with and without the plugin (the ablation arm) and scored.

**Blinding, held throughout:**

- The candidate never sees `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark` or `candidate` in a directory, file or prompt.
- The prompt reads as an organic request from Luiz: the goal, not the meta. No cue asking the candidate to list the skills or principles it applied; grade chain-following from what it did.
- Directory and slug names are project-shaped, what a person would pick.
- Graders know they grade; they see outputs by label, never by variant.
- Comparing two variants: one grader scores both on one scale in one pass.

**Steps:**

1. **Frame.** Name the variant under test and the behaviour that counts as success. Write 3 to 6 concrete grader criteria, kept out of anything the candidate sees.
2. **Set up the cases.** `claude plugin eval init --bare <name>` for a blank case, or `init` for the interview. Plant the context an organic task would have: a small project skeleton, the files a user would have.
3. **Author one organic prompt** per case: what Luiz would type.
4. **Run it.** `claude plugin eval <plugin path> --runs <n> --case <glob>`; Sonnet candidates by default (`--model sonnet`), Opus when the behaviour under test is judgement. The default ablation gives the no-plugin baseline. Set `--max-cost-usd` for a large suite.
5. **Verify the chain from transcripts, not self-report.** Read what each run actually opened and ran (the JSON result, `--json`, and the run transcripts); grade chain-following from the files read and the shape of the output.
6. **Read every output yourself**, end to end, and compare with the graders' verdicts. Disagreement means a biased grader or an ambiguous criterion; fix it and rerun that case.

**Reply:** the variant under test, the criteria, per-case notes, the scores with and without the plugin, your synthesis, and whether to promote the variant.
