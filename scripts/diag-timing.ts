// Per-stage latency diagnostic for the retrieval pipeline. Runs the same
// stages as retrieveDetailed() but times each one, so "retrieval is slow"
// can be attributed to a stage instead of guessed at.
//
//   bun run scripts/diag-timing.ts ["question"]
//
// Stages: model/table warmup (paid once per process, not per query), title
// match, LLM query expansion (untitled questions only — needs the llama.cpp
// server), query embedding, the three candidate searches, and the rerank —
// reported with the candidate count, since rerank cost scales with it.

import {loadEmbedder, embedQuery} from '../src/ai/embedder'
import {loadReranker, rerank} from '../src/ai/reranker'
import {expandQuery} from '../src/ai/llm'
import {loadTable, vectorSearch, ftsSearch, titleSearch, matchedTitles} from '../src/store/db'
import {config} from '../src/config'

const question = process.argv[2] ?? 'How to draw a rectangle?'

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now()
    const result = await fn()
    console.log(`  ${(performance.now() - t0).toFixed(0).padStart(6)}ms  ${label}`)
    return result
}

console.log(`question: ${question}\n`)

await timed('warmup: embedder load', loadEmbedder)
await timed('warmup: reranker load', loadReranker)
await timed('warmup: table open', loadTable)

console.log()
const queryStart = performance.now()

const titles = await timed('matchedTitles', () => matchedTitles(question))
const expansion = titles.length > 0 ? '' : await timed('expandQuery (LLM)', () => expandQuery(question))
const text = expansion ? `${question} ${expansion}` : question

const vector = await timed('embedQuery', () => embedQuery(text))
const vectorHits = await timed(`vectorSearch top-${config.vectorTopK}`, () => vectorSearch(vector, config.vectorTopK))
const ftsHits = await timed(`ftsSearch top-${config.ftsTopK}`, () => ftsSearch(text, config.ftsTopK))
const titleHits = await timed(`titleSearch top-${config.titleTopK}`, () => titleSearch(text, config.titleTopK))

const byId = new Map(vectorHits.concat(ftsHits, titleHits).map(c => [c.id, c]))
const candidates = [...byId.values()]
const scores = await timed(`rerank ${candidates.length} candidates`, () =>
    rerank(expansion ? `${question} ${expansion}` : question, candidates.map(c => c.text))
)

console.log(`  ${(performance.now() - queryStart).toFixed(0).padStart(6)}ms  TOTAL (excluding warmup)`)

console.log(`\ntitles matched: ${titles.length ? titles.join(', ') : '(none)'}`)
console.log(`expansion: ${expansion || '(none)'}`)
const kept = candidates
    .map((c, i) => ({...c, score: scores[i]!}))
    .sort((a, b) => b.score - a.score)
    .filter(c => c.score >= config.rerankThreshold)
    .slice(0, config.rerankKeep)
console.log(`kept ${kept.length}:`)
for (const c of kept) console.log(`  ${c.score.toFixed(2)}  ${c.chapter}`)
