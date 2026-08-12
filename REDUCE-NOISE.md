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
| 3. Bracketed URLs | 2.26% | ~1.1% | **fixed** |
| 2. "No description" boilerplate | 0.92% | 0.00% | **fixed** with finding 3 |
| 6. Section headers | 0.61% | ~1.3% | open, leave alone |
| 5. Prose-free index chunks | 16.60% | 26% | dead — false positive |
| 7. Code indentation stripped | n/a | n/a | **fixed** — corruption, not noise |

## Corpus now

| Metric | Before | After |
| --- | --- | --- |
| Chunks | 8889 | **7671** |
| Chars | 13,985,089 | **11,935,338** |
| Chapters | 1586 | 1586 |

The chunk count rose from 7582 after findings 4 and 7 landed: 7582 → 7636 is the prose the C# cut had been eating,
7636 → 7671 is code blocks becoming their own paragraphs.

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

### The first cut was made on the text, and it ate prose

`dropCsharpTabs()` originally worked on the flattened text, where a tab has no end tag, so it had to guess: the block
ran to the next language marker or the next line of "real prose", prose being six-plus words ending in `.!?`.
`htmlToText()` hard-wraps paragraphs. The opening lines of the paragraph after a tab almost never end in punctuation,
so they were eaten with the code.

Measured on the real EPUB: **404 of the 894 blocks over-ate**, at least 935 prose lines and ~60k chars. In "Creating
your first script" the whole paragraph explaining `extends` disappeared, and the shipped chunk read:

```
GDScript
extends Sprite2D
Godot uses to manage your application's memory.
```

The fix is to cut on the HTML, before flattening, where the pane has a real closing tag. Sphinx emits exactly one
spelling: `<div class="highlight-csharp notranslate">`, matched to its close by div depth, paired with the `<p>C#</p>`
tab label. 890 panes go. The 136 panes with no label are not tabs — they are the only sample on their page, and they
stay.

This is the one arm here that moved the harness past its noise floor: fundamentals top-3 **16/20 → 19/20**, present
18/20 → 19/20, against a reading that had been 16 and 18 in every previous run.

## Fixed — finding 3, bracketed URLs (and finding 2 with it)

`htmlToText()` keeps every link target inline as `[https://...]`, beside the link text it already kept. 3954 of them,
316,229 chars, 2.26% of the corpus and ~1.1% of the context.

There was no decision to make. The answer prompt never mentions citations, and `query()` builds its `sources` from
chapter metadata, not from the passage text. Nothing downstream reads them.

**Cutting the target alone is not enough.** Sampling the text around all 3954 found two shapes where it leaves
something worse than what was there:

| Count | Shape | What cutting only the URL leaves |
| --- | --- | --- |
| 687 | `...no description for this method. Please help us by contributing one [url]!` | `Please help us by contributing one!` |
| 200+ | `GH-80813 [url]` | `GH-80813` |

Both are removed whole, which is also what finally kills finding 2 — the "no description" boilerplate is the first of
those shapes. A third shape keeps its text: `Third Person Shooter (TPS) Demo [url]` IS the answer to "is there a demo
project".

Finding 2 on its own was still not worth code. It measured 0.00% of the LLM context: the reranker never picks those
chunks, because nobody asks a question they match. It got removed only because it was in the way of finding 3.

### Two bugs found doing this

**Surrogate pairs.** The hard split cut by UTF-16 code unit, so a boundary landing on an emoji produced half a pair.
That is not valid JSON and the embedding box rejects the entire batch. Latent since the hard split was written; only
fires when the chunking changes enough to land on one. Fixed in `ingest/chunk.ts`.

**Blank lines are load-bearing.** A first cut of the URL scrub removed every whitespace-only line to clean up lines
that had held nothing but a link. Blank lines are the paragraph separator `splitToBudget()` splits on, so every
chapter became one giant paragraph and the whole corpus went down the hard-split path — which legitimately carries
overlap. Overlap noise went straight back to 6.34% of context and answers grew to 9694 chars. The scrub now works line
by line and only drops a line that scrubbing emptied.

## Fixed — finding 7, code indentation was destroyed

Not noise. Corruption, and it was in every code sample in the book.

`htmlToText()` collapsed `[ \t]+` to one space and then stripped what was left at the head of a line. It did that
inside `<pre>` too, so all 3940 code blocks came out at column zero:

```
func _physics_process(delta):
pass
```

GDScript is indent-based. Finding 5 below establishes that code samples are most of what the reranker keeps, so this
was wrong on exactly the chunks that reach the answer LLM.

Fix: `ingest/html.ts` lifts each `<pre>` out before the whitespace passes and puts it back after. Code blocks also get
a blank line on each side, so a sample is its own paragraph — the unit `splitToBudget()` packs by — instead of being
glued to the prose around it and cut in half at a budget boundary.

The harness cannot see this. It grades which chunks come back, not whether the code inside them is valid. Two runs on
the rebuilt store gave identical numbers, one below the C# arm on fundamentals top-3 and realistic — and that gap sits
inside the re-index noise of confound 3, not above it. Shipped on the argument, not the score: broken GDScript is
broken whether or not the eval suite can read it.

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

## Open — finding 6, section headers

85,122 chars, 0.61% of the corpus, ~1.1% of the context. Leave it alone. `Inherits:` is the class hierarchy — real
signal, and the larger half. Only the bare `Description` / `Tutorials` labels are pure structure.

There is also a measurement problem. **Its run-to-run drift is as large as its total size.** Three runs on one
unchanged database gave 1.24%, 1.29%, 1.28%, and bracketed URLs behaved the same way at 1.13%, 1.05%, 1.12%. LLM query
expansion is nondeterministic, so a different pool is retrieved every run.

Only step changes an order of magnitude past that drift are readable in this harness. Overlap 7.47% → 0.01% and C#
7.48% → 0.00% were. The URL scrub was shipped anyway, because "nothing reads these" is an argument that does not need
the harness to agree.

## Result

| Category | Before | After |
| --- | --- | --- |
| Overlap head copy | 7.47% | 0.00% |
| C# blocks | 7.48% | 0.08% |
| Bracketed URLs | ~1.1% | 0.00% |
| Boilerplate | 0.00% | 0.00% |
| Section headers | ~1.3% | ~1.1% (untouched) |
| **Union, safe set** | **9.82% + 7.48% C#** | **1.13%** |

About 16 points of the five-slot budget went from duplicated text to real content, at an unchanged ~8400 chars per
answer. Corpus 8889 → 7671 chunks, 13.99M → 11.94M chars.

Corpus shrink was never the win. The win is what fills the 5 reranked slots.

Eval suite, whole run, GPU box, `--repeats 7`:

| Eval | Before findings 4 and 7 | C# cut in HTML | + code indentation |
| --- | --- | --- | --- |
| retrieval | 10/10 | 10/10 | 10/10 |
| fundamentals top-3 | 16/20 | **19/20** | 18/20 |
| fundamentals present | 18/20 | **19/20** | 18/20 |
| paraphrase | 20/22 | 20/22 | 20/22 |
| realistic | 30/33 | 29/33 | 28/33 |
| coverage | 100% | 100% | 100% |
| coverage lowercase | 98.0% | 98.1% | 98.4% |

Top-3 16 → 19 is the only reading here that clears the noise floor: it had been exactly 16 in ten prior runs. The
last column was measured twice on its own store and came back identical both times, so its two one-point drops are
stable within that store — but they still straddle a re-index, which confound 3 says moves pools on its own.

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
