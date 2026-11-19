## Discussion (written after the run of 2026-11-18, gemini-2.5-flash, 1 call per scenario)

**Main findings.**
- Static analysis was exact but narrow: it found all 4 type/lint problems (including pr02, whose error is on an
  unchanged line and was therefore reported only in the summary) and nothing else (precision 1.00, recall 0.33).
- The LLM found all 8 maintainability problems that static analysis cannot see (duplication, complexity, naming,
  cohesion, coupling, redundant checks, repeated serialization, silent catch). Hybrid recall rose to 1.00.
- The cost was 4 false positives (precision 0.75) and 7 duplicate comments (several comments on the same planted
  problem: e.g. 3 on pr08 and 3 on pr10). Duplicates are not counted as FP, but they are review noise.
- 2 of the 3 negative controls (pr14, pr15) received one unnecessary LLM comment each. pr13 got none.
- Extra time: about +12 s per PR on average (static ≈ 18.8 s, hybrid ≈ 30.8 s), about 4k tokens per PR.

**False positives (all manually inspected).**
- pr01: a `cohesion` comment on the same line as the type error. It points at a real semantic change (render time vs.
  event time), but it is not a cohesion problem and overlaps the TS2345 diagnostic.
- pr03: suggests removing the temporary variable. That is a style preference, close to the purely cosmetic remarks the
  prompt forbids.
- pr14 (control): says the `as string` cast is unsafe because "according to the LogObject type, `icon` can be a
  function". `icon` is not declared in Consola's types at all (only the `[key: string]: unknown` index signature), so the
  justification is **invented**. This is the clearest LLM failure in the run.
- pr15 (control): flags the length guard in `leftAlign` as duplicated with `rightAlign`. This is the idiomatic pattern
  already used by the sibling functions, so the comment adds no value.

**Adjudications.** Two LLM comments were reclassified from FP to *duplicate* (`experiments/adjudication.json`).
pr02@67 restates the TS2322 that tsc already reported. pr06@102 points at the redundant check that the ground truth lists as
part of pr06-1. Without these adjudications the hybrid precision would be 12/18 = 0.67.

**Conclusion.** On this dataset, the hybrid mode answers the research question positively for *detection*: the LLM
covered exactly the class of problems that ESLint/tsc miss, and the validation step (only added lines of changed files)
kept all comments anchored to the diff (0 rejected). It did **not** come free of noise: about 1 in 4 LLM-only findings was a
false positive, one of them with a fabricated justification, and the model often split one problem into several comments.
Static analysis remains the precise baseline. The LLM is useful as a complementary reviewer whose comments still need human
triage.

**Limitations of this run.** Single execution per scenario (no variance estimate). Small, author-built
scenarios with one planted problem each, which are easier than real PRs. Category matching relies on a priori accepted
categories, so a stricter rule would lower hybrid TP.
