// Retrieval eval: does the right chapter survive rerank, and do off-topic
// questions still get refused? Compares the old vector-only pipeline against
// the hybrid one so tuning is measured, not guessed. Exercises
// candidates (incl. LLM query expansion for title-less questions — wants the
// llama.cpp server up) → rerank → threshold, the same logic as retrieve(); the
// answer-writing LLM call is not involved.
//
//   bun run scripts/eval-retrieval.ts             quiet: one summary line, exit 1 on fail
//   bun run scripts/eval-retrieval.ts --verbose   full per-question table + timings
//   bun run scripts/eval-retrieval.ts --compare   also run the vector-only reference
//
// Verdict = the hybrid column: PASS when it clears the baseline (10/10, the 2
// must-refuse cases included). The vector-only reference is hidden by default —
// it is expected to be worse, doubles runtime, and its FAILs are not real
// failures. Timings are diagnostics, never part of pass/fail.
//
// PASS for a doc question  = a chunk from an expected chapter is among the
//                            kept results (score ≥ rerankThreshold, top rerankKeep).
// PASS for an off-topic one = nothing clears the threshold (refusal gate holds).

import {embedQuery, loadEmbedder} from '../src/ai/embedder'
import {rerank, loadReranker} from '../src/ai/reranker'
import {retrieveDetailed} from '../src/core/query'
import {loadTable, vectorSearch} from '../src/store/db'
import {config} from '../src/config'
import type {RankedChunk, StoredChunk} from '../src/types'
import {cases} from './retrieval-cases'


const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const compare = argv.includes('--compare')

// Hybrid must clear this many cases — the recorded baseline is 10/10.
const HYBRID_MIN = cases.length

if (verbose) console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

// "hybrid" IS retrieveDetailed() — the production pipeline including LLM query
// expansion — and is the verdict; "vector-only" is the reference the pipeline
// graduated from (original-question rerank, same threshold/keep), run only
// under --compare.
type ModeRun = {pool: StoredChunk[]; kept: RankedChunk[]}
const vectorOnly = {
    name: 'vector-only',
    run: async (q: string): Promise<ModeRun> => {
        const vector = await embedQuery(q)
        const pool = await vectorSearch(vector, config.vectorTopK)
        const scores = await rerank(
            q,
            pool.map(x => x.text)
        )
        const kept = pool
            .map((cand, i) => ({...cand, score: scores[i]!}))
            .sort((a, b) => b.score - a.score)
            .filter(x => x.score >= config.rerankThreshold)
            .slice(0, config.rerankKeep)
        return {pool, kept}
    }
}
const hybrid = {
    name: 'hybrid',
    run: async (q: string): Promise<ModeRun> => {
        const {candidates, kept} = await retrieveDetailed(q)
        return {pool: candidates, kept}
    }
}
const modes = compare ? [vectorOnly, hybrid] : [hybrid]

type CellResult = {pass: boolean; ms: number; pool: number; kept: string[]}
const results = new Map<string, CellResult[]>() // question → one cell per mode

for (const c of cases) {
    const row: CellResult[] = []
    for (const mode of modes) {
        const t0 = performance.now()
        const {pool, kept} = await mode.run(c.question)
        const ms = performance.now() - t0
        const inPool = c.expect ? pool.some(x => c.expect!.test(x.chapter)) : undefined
        const pass = c.expect ? kept.some(x => c.expect!.test(x.chapter)) : kept.length === 0
        row.push({pass, ms, pool: pool.length, kept: kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`)})
        // Detail only for real failures: the hybrid verdict always, the
        // vector-only reference only under --verbose.
        if (!pass && (mode.name === 'hybrid' || verbose)) {
            if (c.expect) {
                console.log(`FAIL  ${c.question} [${mode.name}] — expected chapter ${inPool ? 'was in pool but lost at rerank' : 'not in candidate pool'}`)
                console.log(`  kept: ${kept.length ? kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ') : '(nothing above threshold)'}`)
            } else {
                console.log(`FAIL  ${c.question} [${mode.name}] — refusal gate broke, kept: ${kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ')}`)
            }
        }
    }
    results.set(c.question, row)
    if (verbose) {
        const cells = row.map((r, i) => `${modes[i]!.name}: ${r.pass ? 'PASS' : 'FAIL'} (pool ${r.pool}, ${(r.ms / 1000).toFixed(1)}s)`).join('  ')
        console.log(`\n${c.question}\n  ${cells}`)
    }
}

if (verbose) {
    console.log('\n=== summary ===')
    for (const [i, mode] of modes.entries()) {
        const rows = [...results.values()].map(r => r[i]!)
        const passes = rows.filter(r => r.pass).length
        const meanMs = rows.reduce((s, r) => s + r.ms, 0) / rows.length
        const maxMs = Math.max(...rows.map(r => r.ms))
        console.log(`${mode.name.padEnd(12)} ${passes}/${cases.length} pass   retrieve mean ${(meanMs / 1000).toFixed(1)}s  max ${(maxMs / 1000).toFixed(1)}s`)
    }
}

// Verdict = the hybrid column only.
const hybridIdx = modes.findIndex(m => m.name === 'hybrid')
const hybridPasses = [...results.values()].filter(r => r[hybridIdx]!.pass).length
const ok = hybridPasses >= HYBRID_MIN
console.log(`retrieval: ${ok ? 'PASS' : 'FAIL'}  ${hybridPasses}/${cases.length} hybrid (min ${HYBRID_MIN})`)
process.exit(ok ? 0 : 1)
