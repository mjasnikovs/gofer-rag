# The passage cut: a settable ceiling, and what a smaller one costs

Written 2026-08-19, when `godot_docs_search` was measured at 23.5% of the
consuming agent's total tool output. Nothing here is estimated.

## The problem was not the number, it was the ordering

gofer needed fewer passages and had an obvious lever: it already sliced the
returned array (`rag-retrieve.mjs:110`) with a cap that never bound, because it
was set to 10 and this package never returns more than 8.

Lowering that cap would have been wrong. `rankCandidates` appends title pins
*after* the keep-limit break, and a pin is there precisely because that named
chapter's chunk scored below everything the fill loop kept — named chapters are
exempt from the chapter cap, so the only way out of the kept set is a lower
score. Pins therefore always sort last, and `slice(0, n)` removes the rescues
first. The pin is worth e2e 95 -> 98/100 (commit `4f6a042`).

Sorting the returned array by score does not help either: it is a no-op for
positions 1..`rerankKeep` for the same reason, and equally useless to a slicer.

So the fix is to make slicing unnecessary. `maxPassages` is a hard ceiling
applied before pinning, with room reserved for one pin.

## What was built

- `scripts/pools.ts` + `scripts/capture-pools.ts` — the capture/replay harness.
  It is the one this repo's source comments have cited since 2026-08-06
  ("225 captured pools, paired, no LLM in the loop") without it ever having been
  committed. Every retrieval change since has paid to rebuild it.
- `test/fixtures/pools.ndjson` — 83 questions (the union of the fundamentals,
  paraphrase, retrieval and realistic sets, deduplicated), scored on the GPU box,
  316 KB. Full text is dropped; what survives is which of the question's symbol
  tokens each chunk contains, which is lossless for the only thing the cut reads
  text for.
- `test/cut.test.ts` — 8 tests, 4172 assertions, 208 ms, no models and no
  network. Until it existed, everything CI knew about the cut was three
  hand-built cases.
- `scripts/ab-cut.ts` — every arm, paired, in about a second.
- `scripts/diag-gap.ts` is **deleted**. All 8 of its hardcoded questions were
  already in the eval sets (6 paraphrase, 2 retrieval), so the harness subsumes
  it with a strictly stronger view that needs no models.

## The default did not change

`rerankKeep` is still 5 and `maxPassages` defaults to no ceiling, so the default
path is unchanged. That is not an assertion, it is checked: replaying the frozen
pools through `git show HEAD:src/core/query.ts` and through the new code gives
**identical kept sets on 83 of 83 questions**.

Those 83 are the exact union of every eval set — 85 cases, 83 unique, nothing
missing. So identical kept sets implies identical readings for `eval-retrieval`,
`eval-paraphrase`, `eval-realistic` and `eval-fundamentals`' rank/top-3/present,
because every one of those is a predicate over `kept`. The two readings that are
not: `eval-fundamentals`' margin, which comes from `scored` (untouched code
path), and `eval-coverage`'s candidate stage, which never calls
`rankCandidates` at all.

`eval-retrieval` was re-run through the box to confirm end to end: **10/10, the
recorded baseline**. The rest of `test:evals` was NOT re-run — the GPU box and
the 27B could not both be resident (free VRAM sat at 993 and 968 MiB against the
launcher's 1000 MiB bar, and `RERANK_BOX_REQUIRED=1` correctly refused rather
than falling back to the ~20s/query CPU path). Given the coverage argument above
that run is confirmatory, not informative, but it is a run that did not happen.

## What a ceiling costs

`bun run scripts/ab-cut.ts`. Frozen pools, box backend, corpus 7671 rows.
Every reading below was identical across three independent captures, so none of
it is expansion noise.

| arm | psg/call | share of bytes | retrieval | paraphrase | fundamentals | realistic | top-3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 4.75 | 100% | 8/8 | 20/22 | 18/20 | 25/30 | 18/20 |
| max 5 | 4.69 | 99% | 8/8 | 20/22 | 18/20 | 25/30 | 18/20 |
| **max 4** | **3.77** | **79%** | 8/8 | 20/22 | 18/20 | 25/30 | 18/20 |
| max 3 | 2.86 | 60% | 8/8 | 19/22 | 18/20 | 24/30 | 18/20 |
| max 2 | 1.93 | 40% | 8/8 | 19/22 | 15/20 | 23/30 | 15/20 |
| gap 2.5 | 3.96 | 84% | 8/8 | 20/22 | 17/20 | 25/30 | 17/20 |
| gap 2.0 | 3.45 | 73% | 8/8 | 20/22 | 17/20 | 24/30 | 17/20 |
| gap 1.5 | 2.80 | 59% | 8/8 | 20/22 | 17/20 | 24/30 | 17/20 |
| gap 1.0 | 2.05 | 43% | 8/8 | 20/22 | 16/20 | 22/30 | 16/20 |
| gap 1.5 if titled | 4.42 | 93% | 8/8 | 20/22 | 18/20 | 24/30 | 18/20 |
| gap 2.0 if titled | 4.54 | 96% | 8/8 | 20/22 | 18/20 | 24/30 | 18/20 |
| max 3 + gap 1.5 | 2.25 | 47% | 8/8 | 19/22 | 17/20 | 23/30 | 17/20 |
| max 4, no pin slot | 3.77 | 79% | 8/8 | 20/22 | 18/20 | 24/30 | 18/20 |
| max 3, no pin slot | 2.86 | 60% | 8/8 | 19/22 | 18/20 | 23/30 | 18/20 |
| max 2, no pin slot | 1.93 | 40% | 8/8 | 19/22 | 15/20 | 21/30 | 15/20 |

Refusals held at 3/5 in **every** arm, which is structural rather than measured:
rank 1 satisfies every ceiling >= 1 and every gap >= 0, so no policy in this
family can empty a non-empty set. (3/5 is the reranker threshold alone — the
other two off-topic cases are the LLM gate's job and are not replayable here.)

> Re-running `ab-cut.ts` today prints 4/5, not the 3/5 in this table. The
> `answerFloor` gate landed on 2026-09-11 and is part of `defaultCut()`, so it
> applies to every arm here equally and the comparison between arms is unchanged.
> It is not in the cut family this page argues about: it reads rank 1's score and
> empties the set, which is exactly the thing ceilings and gaps cannot do. The
> measurement that set it is `scripts/ab-floor.ts`.

### The pin reservation pays for itself

`rankCandidates` reserves up to half a ceiling's slots for pins. That rule was
invented, not measured, so `pinReserve: 0` was added to make the counterfactual
runnable — it is "just take the top N by score", which is what a consumer's
`slice(0, n)` would have produced. The `no pin slot` rows above are that arm:

| ceiling | realistic, with the reservation | without | bytes with | bytes without |
| --- | --- | --- | --- | --- |
| 4 | 25/30 | 24/30 | 514586 | 514993 |
| 3 | 24/30 | 23/30 | 390088 | 390637 |
| 2 | 23/30 | 21/30 | 259704 | 260305 |

One labelled case at a ceiling of 4 or 3, two at a ceiling of 2 — and it costs
*negative* bytes every time, because a pinned chunk is a shorter chunk than the
score-ranked one it displaces. The invented rule stands, and it is now the
measured reason a consumer should set `maxPassages` rather than slice.

A ceiling this tight cannot always represent everything a question named.
"whats the difference between Area2D and StaticBody2D" names two classes, and at
`maxPassages: 3` two of the slots go to the top-scoring physics overview chunks,
so one of the two classes drops:

```
default     Physics introduction | PhysicsBody2D | Area2D | StaticBody2D | RigidBody2D    2/2 named
max 3       Physics introduction | PhysicsBody2D | StaticBody2D[pin]                      1/2 named
max 3, no pin slot
            Physics introduction | PhysicsBody2D | Area2D                                 1/2 named
```

Checked because the pin set is chosen before the ceiling truncates `kept`, which
looked like it might orphan a named chapter. It does not: coverage is 1/2 either
way, so the reservation swaps *which* class survives rather than costing one. It
is a capacity limit of a three-slot ceiling on a two-class question, not a defect
in the cut.

**A ceiling of 4 is free**: 21% of the bytes for zero labelled losses.
**A ceiling of 3 costs two cases** for another 19 points:

```
paraphrase: How do I make one node notify another when something happens?
realistic:  my game freezes for a second when i load a new level
```

## The gap family is closed

The rule was written down before the numbers existed: an arm ships only if it
costs zero across all four sets *and* saves >= 25% of the bytes.

No gap arm qualifies. Every global gap costs `fundamentals` 18 -> 17 —
"How do I make a variable editable in the inspector?" dies at every G from 2.5
down. The title-gated arms protect that but only reach 93-96% of the bytes,
nowhere near the bar.

The prediction was half wrong and is recorded as such: a global gap of 1.5 was
predicted to cost paraphrase and realistic. Paraphrase held at 20/22. It cost
fundamentals and realistic instead.

A flat count cap dominates the gap family outright — max 3 and gap 1.5 sit at
almost the same byte volume (60% vs 59%) while the gap arm loses a fundamentals
case the count arm keeps. **Do not reopen this without new information.**

## The fixture is checked against the text it replaced

The committed fixture stores, per candidate, which of the question's symbol
tokens the chunk contained — not the chunk. That is lossless for the one thing
`rankCandidates` reads text for, but only for how it reads text *today*, and a
future change could silently encode a wrong golden file rather than failing.

So `capture-pools.ts --scores` now runs both forms through the cut while the full
text is still in hand and refuses to write the fixture if they disagree. Current
capture: **faithful on all 83 pools**. Note this is not something the parity
check could have caught — that compares old code against new code on the *same*
reconstructed input, so a broken reconstruction would have made both sides
equally wrong and left them agreeing.

## What is still unmeasured

Every eval in this repo scores "is the expected chapter present in `kept`", so
a smaller cut can only lower them. They measure the *cost* of a cut and never
its benefit. The only instrument that could reward a smaller cut is
`scripts/eval-answers.ts` (grounded / answers / cited), which needs the 27B, is
not in `test:evals`, has no gate, and self-judges. That is the missing
instrument, and it is why this package does not pick a default for its consumer.

**The loss table and the byte table come from different distributions.** Losses
are measured on the 83 labelled questions here, which are natural-language. The
consumer's real traffic is keyword piles — 130 of 130 of its cached searches
were — and those have no ground truth, so only their bytes can be measured, never
their losses. "A ceiling of 4 is free" is therefore free *on natural questions*.
It is the best available evidence, not a measurement of the consumer's own
traffic.

**The LLM refusal gate is not replayable here.** Two of the five off-topic cases
score above the reranker threshold and are refused by the answer model instead,
so the 3/5 that holds across every arm is the threshold gate alone. Shrinking the
context should only make a refusal more likely, never less, but that direction is
argued rather than measured.
