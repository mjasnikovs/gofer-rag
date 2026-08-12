# Ingestion noise audit

First written 2026-08-11 against the corpus byte count. Rewritten 2026-08-12 after measuring the thing that
actually matters. Nothing here is estimated.

Goal: this RAG should hand the LLM only what the answer needs. Any char that is not the answer is noise.

## The metric changed, and it changed the answers

The first version of this document ranked noise by **share of corpus**. That is the wrong denominator. The LLM never
sees the corpus. It sees the ~8200 chars of the kept top 5, and nothing else. A category that is 12% of the corpus but
never lands in a kept set costs nothing. A category that is 1% of the corpus but rides on every class-reference page
costs on every answer.

Measuring share of context instead (`scripts/diag-context-noise.ts`, 50 eval questions, real retrieval path) reordered
the whole list and killed three of the six findings outright.

| Finding | Share of corpus | Share of context | Verdict |
| --- | --- | --- | --- |
| 1. Chunk overlap | 11.87% | 7.47% | **fixed** |
| 4. C# / GDScript duplication | 2.64% | 7.48% | **fixed** |
| 3. Bracketed URLs | 2.26% | ~1.1% | open, blocked on a decision |
| 6. Section headers | 0.61% | ~1.3% | open, leave alone |
| 2. "No description" boilerplate | 0.92% | **0.00%** | dead — never retrieved |
| 5. Prose-free index chunks | 16.60% | 26% | dead — false positive |

## Corpus now

| Metric | Before | After |
| --- | --- | --- |
| Chunks | 8889 | **7783** |
| Chars | 13,985,089 | **11,934,969** |
| Chunk chars min / median / max | 27 / 1726 / 2611 | 27 / 1723 / 2583 |
| Chapters | 1586 | 1586 |

`chunkChars` 1800, `overlapChars` 240, `rerankKeep` 5.

## Fixed — finding 1, chunk overlap

`splitToBudget()` copied the tail of every finished chunk into the head of the next one. Measured: 7212 of 7212
successor chunks carried a literal copy, 1,659,378 chars, 11.87% of the corpus.

The seam it guarded against mostly does not exist. Paragraph packing never cuts a paragraph in half. Only the
oversized-paragraph hard split can cut mid-sentence, and that produced **102 of 8889** chunks (1.1%). So the corpus
paid 11.87% duplication to protect 1.1% of chunks.

The real cost was worse than the byte count. Only 3 kept sets in 50 questions held two chunks of one chapter, so the
copy was almost never duplicated inside a single answer. Instead, nearly every kept chunk **opened** with a
mid-sentence fragment of its neighbour. 7.47% of everything the answer LLM read was that garbled lead-in.

Fix: `ingest/chunk.ts` carries overlap only out of the hard-split loop. A paragraph seam copies nothing.

### The fix the first draft proposed would have been a disaster

That draft suggested setting `config.overlapChars` to 0. `overlapTail()` did `text.slice(-overlap)`, and in JavaScript
`slice(-0)` is `slice(0)` — the whole string. Every successor chunk would have carried a near-complete copy of its
predecessor. Measured with `scripts/diag-chunk-variants.ts`:

| Variant | Chunks | Chars | Duplicated |
| --- | --- | --- | --- |
| current (overlap 240) | 8889 | 13,985,089 | 11.87% |
| `overlapChars = 0` | **88,559** | **189,990,567** | 0.03% |
| overlap on hard-split only | 8004 | 12,319,385 | 0.00% |

A 1258% blowup. Never "disable" a knob without reading what reads it.

## Fixed — finding 4, C# / GDScript duplication

The Godot docs show the same example once per language in a tab widget. `htmlToText()` flattens the widget, so both
copies land in the same chunk separated by a bare `GDScript` / `C#` marker line.

7.48% of the LLM context — the same size as the overlap duplication, and invisible in the corpus-byte ranking, where
it sat fourth at 2.64%.

Fix: `ingest/scrub.ts` drops the C# half at ingest. This is a **deliberate trade, not a free win**: a C# question now
gets GDScript samples. None of the 50 eval questions ask about C#, so the eval suite cannot see that loss at all.

Chapters naming C# in their own title are exempt. "C# API differences to GDScript" is 22 tab pairs whose entire
purpose is the side-by-side. 25 of the corpus's 894 C# markers sit in such chapters, and those 25 are what remains.

The reversible alternative, if this turns out to matter: keep both blocks, tag the block language at ingest, filter at
serve time by what the question looks like.

## Dead — finding 2, "no description" boilerplate

The Godot class reference stubs unwritten entries with a fixed sentence plus a contributing URL. 755 sentences,
128,224 chars, 0.92% of the corpus, concentrated in 199 chunks.

**0.00% of the LLM context across 50 questions.** The reranker never picks those chunks, because nobody asks a
question they match. The first draft called this "a cheap win with low blast radius". It is not a win at all. Do not
spend code on it.

## Dead — finding 5, prose-free index chunks

Chunks where under 10% of non-empty lines are sentences. 1428 chunks, 16.6% of the corpus, 26% of the LLM context —
by volume the largest single block, and the first draft's biggest open item.

All 64 prose-free kept chunks were dumped and read (`--prose-free`). **Zero were junk.** Every one was a code sample
or a class-page intro:

```
rank 2  [Kinematic character (2D)]  Q: How do I move a character with the keyboard?
> GDScript / extends CharacterBody2D / const GRAVITY = 200.0 / func _physics_process(delta): ...

rank 1  [Area2D]  Q: How do I detect when two objects collide?
> Area2D / Inherits: CollisionObject2D < Node2D < CanvasItem < Node < Object / A region of 2D space that ...
```

The heuristic detects "contains code", not "is noise". Code is the answer to a how-do-I question. The locale-code
dumps that motivated the finding exist in the corpus but are never retrieved — same reason as finding 2.

## Open — findings 3 and 6, and why they may be ungradable

| Finding | Chars | Share of corpus | Share of context |
| --- | --- | --- | --- |
| 3. Bracketed URLs | 316,229 | 2.26% | ~1.1% |
| 6. Section headers | 85,122 | 0.61% | ~1.3% |

Finding 3 is blocked on a product decision, not on code: some answers legitimately want a doc URL. Decide whether
citations come from chapter metadata instead of inline text.

Finding 6 should probably be left alone. `Inherits:` is the class hierarchy — real signal, and the larger half. Only
the bare `Description` / `Tutorials` labels are pure structure.

Both carry the same warning. **Their run-to-run drift is as large as their total size.** Three runs on one unchanged
database:

| Run | Bracketed URLs | Section headers |
| --- | --- | --- |
| 1 | 1.13% | 1.24% |
| 2 | 1.05% | 1.29% |
| 3 | 1.12% | 1.28% |

LLM query expansion is nondeterministic, so a different pool is retrieved every run. Only step changes an order of
magnitude past that drift are readable — overlap 7.47% → 0.01% and C# 7.48% → 0.00% were. Neither of these would be.

## Result

| Category | Before | After |
| --- | --- | --- |
| Overlap head copy | 7.47% | 0.01% |
| C# blocks | 7.48% | 0.00% |
| Bracketed URLs | ~1.1% | ~1.1% (untouched) |
| Section headers | ~1.3% | ~1.3% (untouched) |
| Boilerplate | 0.00% | 0.00% |

About 15 points of the five-slot budget went from duplicated text to real content, at an unchanged ~8200 chars per
answer. Corpus 8889 → 7783 chunks.

Corpus shrink was never the win. The win is what fills the 5 reranked slots.

## Before changing anything else

Re-read the memory note `gofer-rag-ab-method`. It now records five confounds, two of them found while doing this
work:

- **The fundamentals score is noise.** Three runs on an unchanged database scored 10, 8, 9 while top-3 held at 16/20
  and present at 18/20 every time. Its 0.5-logit gate is finer than the reranker's own batch noise (0.23 mean, 1.2
  max). Grade a corpus change on top-3 and coverage, never on that score.
- **The rerank backend must not change inside an arm.** In-process ONNX (CPU) and `scripts/rerank-box.ts` (GPU)
  produce different kept sets.

Measuring tools:

- `scripts/diag-context-noise.ts` — noise as a share of what the LLM reads. `--verbose`, `--prose-free`.
- `scripts/diag-chunk-variants.ts` — chunk-shape variants on the real EPUB, no embedding, ~1 min.

Eval suite: `scripts/eval-retrieval.ts`, `eval-fundamentals.ts`, `eval-realistic.ts`, `eval-paraphrase.ts`,
`eval-coverage.ts`. Run them through `scripts/rerank-box.ts` — 5.5 min instead of 40+.
