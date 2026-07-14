// Diagnostic for the 5 honest end-to-end misses in eval-coverage.ts: does each
// one fit the BoxMesh shape — own chapter IS in the candidate pool, scores
// above the -4 gate, but ranks past rerankKeep=5? That shape is what the
// proposed title-pin lever (pin the named chapter's best above-threshold chunk
// into the kept set) would fix; any miss with a different shape needs a
// different lever.
//
// Uses the production gatherCandidates + rerank. Run it bare for the serving
// truth (in-process ONNX q8, ~20s/query) or through scripts/rerank-box.ts for
// the GPU box; the two backends disagree near the gate, so check both before
// believing a pin/threshold conclusion.
//
//   bun run scripts/diag-miss-shape.ts
//   bun run scripts/rerank-box.ts bun run scripts/diag-miss-shape.ts

import {loadEmbedder} from '../src/ai/embedder'
import {rerank, loadReranker} from '../src/ai/reranker'
import {gatherCandidates, retrieveDetailed} from '../src/core/query'
import {loadTable} from '../src/store/db'
import {config} from '../src/config'

// The 5 misses, with the eval's own pass criterion (chapter, member name).
const cases: {cls: string; member?: string; question: string}[] = [
    {cls: 'BoxMesh', question: 'What is BoxMesh used for in Godot?'},
    {cls: 'Curve', question: 'What is Curve used for in Godot?'},
    {cls: 'Tree', member: 'font', question: 'What does the font property of Tree control?'},
    {cls: 'CollisionObject3D', question: 'What is CollisionObject3D used for in Godot?'},
    {cls: 'ScriptLanguageExtension', member: '_get_recognized_extensions', question: 'What does the _get_recognized_extensions() method of ScriptLanguageExtension do?'}
]

await Promise.all([loadEmbedder(), loadReranker(), loadTable()])
console.log(`rerank backend: ${config.rerankUrl ? `box ${config.rerankUrl}` : 'in-process ONNX q8'}`)

for (const c of cases) {
    const {candidates, expansion} = await gatherCandidates(c.question)
    const scores = await rerank(
        expansion ? `${c.question} ${expansion}` : c.question,
        candidates.map(x => x.text)
    )
    const ranked = candidates.map((x, i) => ({...x, score: scores[i]!})).sort((a, b) => b.score - a.score)
    const isTarget = (x: {chapter: string; text: string}) =>
        x.chapter === c.cls && (!c.member || x.text.includes(c.member))

    console.log(`\n${c.cls}${c.member ? '.' + c.member : ''} — "${c.question}"`)
    if (expansion) console.log(`  (expansion fired: ${expansion})`)
    console.log(`  pool ${ranked.length} candidates; kept = top ${config.rerankKeep} above ${config.rerankThreshold}`)
    ranked.forEach((x, i) => {
        const mark = isTarget(x) ? ' ◄ TARGET' : ''
        if (i < config.rerankKeep || isTarget(x))
            console.log(`  ${String(i + 1).padStart(3)}. ${x.score.toFixed(2).padStart(7)}  ${x.chapter}${mark}`)
    })
    if (!ranked.some(isTarget)) console.log('  target chunk NOT IN POOL')

    // The production verdict: does retrieveDetailed() (including the title
    // pin) keep a target chunk? Reranks the pool a second time — acceptable
    // for a 5-question diagnostic.
    const {kept} = await retrieveDetailed(c.question)
    const hit = kept.some(isTarget)
    console.log(`  retrieveDetailed kept (${kept.length}): ${kept.map(x => x.chapter).join(' | ')}`)
    console.log(`  production verdict: ${hit ? 'HIT' : 'miss'}`)
}
