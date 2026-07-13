// Retrieval eval: does the right chapter survive rerank, and do off-topic
// questions still get refused? Compares the old vector-only pipeline against
// the hybrid (vector ∪ BM25) one so tuning is measured, not guessed. No LLM
// involved — this exercises embed → candidates → rerank → threshold, the same
// logic as retrieve().
//
//   bun run scripts/eval-retrieval.ts
//
// PASS for a doc question  = a chunk from an expected chapter is among the
//                            kept results (score ≥ rerankThreshold, top rerankKeep).
// PASS for an off-topic one = nothing clears the threshold (refusal gate holds).

import {embedQuery, loadEmbedder} from '../src/ai/embedder'
import {rerank, loadReranker} from '../src/ai/reranker'
import {loadTable, vectorSearch, ftsSearch, titleSearch} from '../src/store/db'
import {config} from '../src/config'

type Case = {question: string; expect?: RegExp} // no expect = must refuse

const cases: Case[] = [
    // class-name lookups — the known weak spot
    {question: 'What is a NavigationAgent2D used for?', expect: /NavigationAgent/},
    {question: 'How does NavigationAgent2D obstacle avoidance work?', expect: /NavigationAgent/},
    {question: 'What does the CharacterBody2D node do?', expect: /CharacterBody2D/},
    // "Introduction to the animation features" opens by defining AnimationPlayer,
    // so it counts as a correct source alongside the class-ref chapter.
    {question: 'What is an AnimationPlayer node?', expect: /AnimationPlayer|Introduction to the animation features/},
    // how-to questions — currently working, must not regress
    {question: 'How do I connect a signal to a method in GDScript?', expect: /signals/i},
    {question: 'How do I create an autoload singleton?', expect: /autoload|singleton/i},
    {question: 'How do I export a variable so it shows in the inspector?', expect: /export/i},
    {question: 'How do I detect when a body enters an Area2D?', expect: /Area2D/},
    // off-topic — the refusal gate must keep holding
    {question: 'How do I bake sourdough bread?'},
    {question: 'Who won the 2022 FIFA World Cup?'}
]

console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

// Both modes share the production rerank/threshold/keep logic; they differ
// only in how the candidate pool is built. "hybrid" is what retrieve() does;
// "vector-only" is kept as the reference the pipeline graduated from.
const modes = [
    {
        name: 'vector-only',
        candidates: async (_q: string, vector: number[]) => vectorSearch(vector, config.vectorTopK)
    },
    {
        name: 'hybrid',
        candidates: async (q: string, vector: number[]) => {
            const [vec, fts, titles] = await Promise.all([
                vectorSearch(vector, config.vectorTopK),
                ftsSearch(q, config.ftsTopK),
                titleSearch(q, config.titleTopK)
            ])
            return [...new Map(vec.concat(fts, titles).map(c => [c.id, c])).values()]
        }
    }
]

type CellResult = {pass: boolean; ms: number; pool: number; kept: string[]}
const results = new Map<string, CellResult[]>() // question → one cell per mode

for (const c of cases) {
    const vector = await embedQuery(c.question)
    const row: CellResult[] = []
    for (const mode of modes) {
        const pool = (await mode.candidates(c.question, vector))
        const inPool = c.expect ? pool.some(x => c.expect!.test(x.chapter)) : undefined
        const t0 = performance.now()
        const scores = await rerank(
            c.question,
            pool.map(x => x.text)
        )
        const ms = performance.now() - t0
        const kept = pool
            .map((cand, i) => ({...cand, score: scores[i]!}))
            .sort((a, b) => b.score - a.score)
            .filter(x => x.score >= config.rerankThreshold)
            .slice(0, config.rerankKeep)
        const pass = c.expect ? kept.some(x => c.expect!.test(x.chapter)) : kept.length === 0
        row.push({pass, ms, pool: pool.length, kept: kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`)})
        if (c.expect && !pass) {
            console.log(`\n${c.question} [${mode.name}] FAIL — expected chapter ${inPool ? 'was in pool but lost at rerank' : 'not in candidate pool'}`)
            console.log(`  kept: ${kept.length ? kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ') : '(nothing above threshold)'}`)
        }
        if (!c.expect && !pass) {
            console.log(`\n${c.question} [${mode.name}] FAIL — refusal gate broke, kept: ${kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ')}`)
        }
    }
    results.set(c.question, row)
    const cells = row.map((r, i) => `${modes[i]!.name}: ${r.pass ? 'PASS' : 'FAIL'} (pool ${r.pool}, ${(r.ms / 1000).toFixed(1)}s)`).join('  ')
    console.log(`\n${c.question}\n  ${cells}`)
}

console.log('\n=== summary ===')
for (const [i, mode] of modes.entries()) {
    const rows = [...results.values()].map(r => r[i]!)
    const passes = rows.filter(r => r.pass).length
    const meanMs = rows.reduce((s, r) => s + r.ms, 0) / rows.length
    const maxMs = Math.max(...rows.map(r => r.ms))
    console.log(`${mode.name.padEnd(12)} ${passes}/${cases.length} pass   rerank mean ${(meanMs / 1000).toFixed(1)}s  max ${(maxMs / 1000).toFixed(1)}s`)
}
process.exit(0)
