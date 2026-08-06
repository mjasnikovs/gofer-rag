// Fundamentals eval: the beginner questions a Godot tutorial chapter literally
// teaches. Written because the other evals could not see the failure they were
// masking — "How do I connect a signal to a method in GDScript?" passed
// eval-retrieval while "Using signals" sat at kept rank 5 of 5 with a 0.10-logit
// margin over the next candidate, four of the five slots taken by class-
// reference pages (measured 2026-08-06 on captured pools). A question a
// beginner asks must be answered by the chapter that teaches it, near the top,
// with room to spare — so the gate here is stricter than "present in kept":
//
//   PASS = the expected chapter is in the TOP 3 kept
//          AND leads the first non-expected candidate below it by >= 0.5 logits
//
// The margin is measured over retrieveDetailed().scored — every candidate the
// real reranker scored, so it says how much slack the result has, not just
// which side of the cut it landed on. Reranker logits are quantized and NOT
// batch-invariant (mean |delta| 0.23, max 1.2 from re-batching identical
// pairs), which is exactly why "present at rank 5" is not a result worth
// shipping and 0.5 is the floor.
//
//   bun run scripts/eval-fundamentals.ts             quiet: failures + summary line
//   bun run scripts/eval-fundamentals.ts --verbose   every question, rank, margin, kept set
//
// Needs the llama.cpp server up (docker start llama-turboquant) — most of these
// questions name no chapter title, so they go through LLM query expansion.

import {loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieveDetailed} from '../src/core/query'
import {loadTable} from '../src/store/db'
import {cases} from './fundamentals-cases'
import type {RankedChunk} from '../src/types'

// ============================================================================
// THIS EVAL DOES NOT PASS ITS OWN TARGET, AND THAT IS THE POINT OF IT.
//
// The target was 18/20. Measured 2026-08-06 it sits at 13-15/20, and the
// question it was written for still fails:
//
//   How do I connect a signal to a method in GDScript?
//     kept: 4.02 Cross-language scripting | 3.94 Object | 3.93 Signal
//           | 3.68 Using signals | 1.97 Heads up display     rank 4, margin 0.10
//
// Five fixes were measured against 225 captured, pre-scored pools (20
// fundamentals, the repo's own 65 hand-written questions, 120 templated
// class-ref questions + 20 off-topic). Two shipped. THE OTHER FOUR ARE DEAD —
// do not spend another session on them:
//
//   F4  expansion gating. A matched title suppresses LLM expansion, and here
//       the match is the bare word "GDScript", so the question loses expansion
//       for nothing. Fixing it buys NOTHING: forcing expansion on lifts this
//       question's margin 0.10 -> 1.43 but leaves it at rank 4, because the
//       terms lift the class pages it is losing to too (Signal 4.02 -> 4.39).
//       Six rules probed (expand-always, title-coverage >= 0.33/0.40/0.50, a
//       how-to test, and how-to-or-coverage): every one 14/20 fundamentals,
//       and the three aggressive ones also lose 4 class-ref hits.
//   F7  scoring tutorial chapters above class-reference pages before the cut.
//       ZERO outcome flips at bonuses 0.5/1/1.5/2/3, gated and ungated. It
//       does move "Using signals" to rank 2 — but the margin is a property of
//       the reranker's scores, not of the ordering, so reordering cannot buy
//       it. No ranking-policy tweak can; stop trying.
//   F2  headings preserved at ingest (ingest/html.ts) and used as chunk split
//       points. This one WORKS on the target question — the chunk
//       "## Connecting a signal via code" comes into existence and "Using
//       signals" goes rank 4 -> RANK 1, 3.68 -> 4.45. It was still reverted:
//       class-ref hits 116 -> 114 and an off-topic question stopped being
//       refused (18/20 -> 17/20). Reopen this ONLY with a plan for those two
//       class-ref losses; another ranking heuristic will not do it.
//   F3  F2 plus keeping a listing with the sentence that introduces it.
//       Worse again: class-ref 112/120, fundamentals 11/20.
//
// The metric itself is part of the story. Across base -> F2 -> F2+F3 the
// expected chapter's RANK improved monotonically (in top 3: 16 -> 17 -> 18,
// present at all: 18 -> 18 -> 19) while this margin gate fell monotonically
// (14 -> 13 -> 11). Sharper chunks sharpen the competing class-reference
// chunks too, so separation shrinks as correctness improves. A rank-only gate
// would have called F2+F3 the winner. Both readings are printed below; judge
// a future fix on both, not on the one number.
// ============================================================================

const TOP_N = 3
const MIN_MARGIN = 0.5
// Measured 13/20 and 15/20 on two live passes (2026-08-06) — the spread is
// expansion nondeterminism, same corpus and code. 12 is the floor that a real
// regression breaks; it is NOT the 18 this set was written to reach. Raising
// this to 18 is the goal, not a knob to turn.
const FUNDAMENTALS_MIN = 12

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')

if (verbose) console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

// Rank of the expected chapter within kept (1-based, -1 = absent) and its lead
// over the first candidate below it that is NOT from an expected chapter.
function score(expect: RegExp, kept: RankedChunk[], scored: RankedChunk[]): {rank: number; margin: number} {
    const rank = kept.findIndex(c => expect.test(c.chapter))
    if (rank === -1) return {rank: -1, margin: -Infinity}
    const hit = kept[rank]!
    const below = scored.slice(scored.findIndex(c => c.id === hit.id) + 1)
    const next = below.find(c => !expect.test(c.chapter))
    return {rank: rank + 1, margin: next ? hit.score - next.score : Infinity}
}

let passes = 0
let present = 0
let inTopN = 0
let ms = 0
for (const c of cases) {
    const t0 = performance.now()
    const {kept, scored} = await retrieveDetailed(c.question)
    ms += performance.now() - t0
    const {rank, margin} = score(c.expect, kept, scored)
    const pass = rank !== -1 && rank <= TOP_N && margin >= MIN_MARGIN
    if (rank !== -1) present++
    if (rank !== -1 && rank <= TOP_N) inTopN++
    if (pass) passes++
    if (verbose || !pass) {
        const m = margin === Infinity ? 'inf' : margin === -Infinity ? '-' : margin.toFixed(2)
        console.log(`${pass ? 'PASS' : 'FAIL'}  rank ${rank === -1 ? '-' : rank}  margin ${m}  ${c.question}`)
        if (!pass || verbose)
            console.log(`    kept: ${kept.length ? kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ') : '(nothing above threshold)'}`)
    }
}

if (verbose) {
    console.log('\n=== summary ===')
    console.log(`in kept at all: ${present}/${cases.length}   in top-${TOP_N}: ${inTopN}/${cases.length}   top-${TOP_N} with margin >= ${MIN_MARGIN}: ${passes}/${cases.length}   retrieve mean ${(ms / cases.length / 1000).toFixed(1)}s`)
}

const ok = passes >= FUNDAMENTALS_MIN
console.log(`fundamentals: ${ok ? 'PASS' : 'FAIL'}  ${passes}/${cases.length} top-${TOP_N} margin>=${MIN_MARGIN} (min ${FUNDAMENTALS_MIN}; top-${TOP_N} ${inTopN}/${cases.length}; present ${present}/${cases.length}; target 18)`)
process.exit(ok ? 0 : 1)
