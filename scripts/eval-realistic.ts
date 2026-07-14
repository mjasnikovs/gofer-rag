// Realistic-questions eval: how users ACTUALLY ask — vague symptom reports,
// misspellings, Godot-3 vocabulary, questions naming two classes at once,
// pasted error messages, and gamedev-adjacent off-topic. Every shape here is
// one the templated/paraphrase evals deliberately avoid, so this is the
// blind-spot hunter: expect misses, then diagnose them.
//
// Every `expect` was verified against the corpus (grep, 2026-07-14) — the
// chapters really do answer the question. Off-topic cases have no expect and
// run through the FULL query() (reranker gate + LLM gate), because realistic
// off-topic questions mention Godot words and won't score below the reranker
// threshold; refusing them is the LLM gate's job. Wants the llama server up
// (docker start llama-turboquant) for expansion AND the off-topic cases.
//
//   bun run scripts/eval-realistic.ts             quiet: fails + per-category summary
//   bun run scripts/eval-realistic.ts --verbose   every question, expansions, timings
//
// Baseline 29/33 (2026-07-14, GPU box, after near-title matching in
// titleSearch fixed the andriod-typo case — see db.ts nearTitles()). The 3
// stable misses are EXPANSION-VOCABULARY-BOUND — the 27B's term list lacks
// the docs' answer vocabulary, so the right chapter loses the pool or the
// rerank:
//   falls through the floor    needs "Continuous Collision Detection" /
//                              tunneling; model emits movement terms instead
//   freezes when loading       needs "Background loading" / threaded loading;
//                              some epochs emit ResourceLoader (then it can
//                              pass), others scene-change terms
//   how big can my world be    needs "Large world coordinates"; model invents
//                              FloatingPointPrecision
// Both remaining non-prompt levers were measured DEAD (2026-07-14): spell-
// correcting the question doesn't help (corrected BM25 still buries
// "Exporting for Android" under competing Android chapters — near-titles won
// instead), and fuzzy-grounding expansion TERMS in the chapter list has
// nothing to grab (best term↔answer-title similarity 0.23–0.33 across all
// misses). Prompt levers stay closed (two prompt-roulette verdicts).
// Health-bar and null-instance-error cases flip with expansion
// nondeterminism (±2), hence the margin in REALISTIC_MIN. Expansion also
// STARVES when the shared 27B is busy with another client's long prompt
// (single slot, 15s timeout, warning prints only once per process) — a run
// full of expansion-dependent misses may just mean someone else was in line.

import {loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieveDetailed, query} from '../src/core/query'
import {loadTable} from '../src/store/db'
import {cases, type Category} from './realistic-cases'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')

if (verbose) console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

const byCat = new Map<Category, {pass: number; total: number}>()
let ms = 0
for (const c of cases) {
    const t0 = performance.now()
    let pass: boolean
    let detail = ''
    if (c.expect) {
        const {candidates: pool, expansion, kept} = await retrieveDetailed(c.question)
        const hit = (x: {chapter: string; text: string}) => c.expect!.test(x.chapter) && (!c.text || c.text.test(x.text))
        pass = kept.some(hit)
        const inPool = pool.some(hit)
        detail = pass ? 'PASS' : inPool ? 'FAIL-rerank' : 'FAIL-pool'
        if (verbose || !pass) {
            console.log(`${detail}  [${c.cat}]  ${c.question}`)
            if (expansion && (verbose || !pass)) console.log(`    expansion: ${expansion}`)
            if (!pass) console.log(`    kept: ${kept.length ? kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ') : '(nothing above threshold)'}`)
        }
    } else {
        // Must-refuse: the full pipeline has to end in found:false, whichever
        // gate does it. Needs the 27B; a server error counts as a failure so
        // it can't silently pass.
        try {
            const result = await query(c.question)
            pass = !result.found
        } catch (err) {
            pass = false
            detail = ` (query() threw: ${err instanceof Error ? err.message : String(err)})`
        }
        if (verbose || !pass) console.log(`${pass ? 'PASS' : 'FAIL-not-refused'}  [${c.cat}]  ${c.question}${detail}`)
    }
    ms += performance.now() - t0
    const s = byCat.get(c.cat) ?? {pass: 0, total: 0}
    s.total++
    if (pass) s.pass++
    byCat.set(c.cat, s)
}

// Baseline 29/33; the 3 documented misses are stable, the flaky cases cost
// up to 2 more. Below 27 something new broke (or the shared 27B was busy —
// check for the expansion-unavailable warning): investigate, don't lower.
const REALISTIC_MIN = 27

console.log('\n=== per category ===')
let passTotal = 0
for (const [cat, s] of byCat) {
    console.log(`${cat.padEnd(9)} ${s.pass}/${s.total}`)
    passTotal += s.pass
}
const ok = passTotal >= REALISTIC_MIN
console.log(`realistic: ${ok ? 'PASS' : 'FAIL'}  ${passTotal}/${cases.length} (min ${REALISTIC_MIN}; mean ${(ms / cases.length / 1000).toFixed(1)}s/question)`)
process.exit(ok ? 0 : 1)
