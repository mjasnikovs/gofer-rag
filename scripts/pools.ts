// The captured-pool fixture: types, load and save. No side effects at import,
// so an eval or a test can pull the types in without running anything (same
// rule as fundamentals-cases.ts).
//
// WHY THIS EXISTS. Every retrieval A/B in this repo's history cites "225
// captured pools, paired, no LLM in the loop" (src/core/query.ts, and the
// prefilter table in src/ai/reranker.ts) and every one of them rebuilt the
// harness from scratch, because it was never committed. Freezing the pools
// turns a 5.5-minute contended-GPU eval into an exact paired comparison that
// runs offline in a second, and it kills four of the five confounds recorded in
// the gofer-rag-ab-method notes outright: expansion nondeterminism, a derived
// case list that drifts, recreateTable reshuffling, and a rerank backend that
// changes inside an arm.
//
// WHY IT IS COMPACT. The repo's entire git pack is ~140 KiB. A raw pool dump is
// ~42 candidates x 1800 chars x 85 questions, about 6 MB — forty times the
// repository. But rankCandidates reads a candidate's text for exactly one
// purpose, `text.includes(symbol)` for symbols drawn from the question, so
// recording WHICH of the question's symbols each chunk contains is lossless for
// it rather than approximate. `has` is computed at capture time with the very
// same predicate, so a substring pair like get_node / get_node_or_null
// reconstructs identically. `textChars` is kept separately because byte
// accounting is the whole point of the exercise.
//
// The cost is a fixture coupled to how rankCandidates uses text today. That is
// accepted: capture-pools.ts is committed, so it is regenerable.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import type {StoredChunk} from '../src/types'

export type PooledCandidate = {
    id: string
    chapter: string
    order: number
    // Absent until the scoring phase has run.
    score?: number
    textChars: number
    // Which of the question's symbol tokens appear in this chunk's text.
    has: string[]
    // Full chunk text, present ONLY in the gitignored .pools/ intermediate.
    // The reranker scores real (query, passage) pairs, so the text has to
    // survive from the pool phase to the scoring phase — but nothing downstream
    // of scoring reads it, so `strip()` removes it before the fixture is
    // committed.
    text?: string
}

export type CapturedPool = {
    question: string
    // Which eval sets this question belongs to. A question can be in two —
    // "How do I connect a signal to a method in GDScript?" is in both the
    // retrieval and the fundamentals set — so the pool is keyed by question and
    // carries a list, never the other way around.
    suites: string[]
    epoch: number
    expansion: string
    titles: string[]
    symbols: string[]
    candidates: PooledCandidate[]
}

export type PoolStamp = {
    capturedAt: string
    packageVersion: string
    // The two rerank paths are not the same computation: in-process ONNX
    // prefilters to prefilterKeep and leaves the rest at -Infinity, the GPU box
    // skips the prefilter and scores everything. They disagree near the gate, so
    // an arm read off a fixture must know which one produced it.
    backend: 'box' | 'onnx' | 'unscored'
    rerankThreshold: number
    prefilterKeep: number
    corpusRows: number
}

export type PoolFile = {
    stamp: PoolStamp
    pools: CapturedPool[]
}

// Rebuild the shape rankCandidates expects. `vector` is dropped at capture (1024
// floats per candidate would be ~100 MB) and never read by the cut.
export function rehydrate(candidate: PooledCandidate): StoredChunk {
    return {
        id: candidate.id,
        vector: [],
        text: candidate.has.join(' '),
        chapter: candidate.chapter,
        order: candidate.order
    }
}

// Drop the full text once scoring is done. This is what takes the fixture from
// megabytes to kilobytes, and it is why the committed file is reviewable.
export function strip(file: PoolFile): PoolFile {
    return {
        stamp: file.stamp,
        pools: file.pools.map(pool => ({
            ...pool,
            candidates: pool.candidates.map(({text: _text, ...candidate}) => candidate)
        }))
    }
}

export function scoresOf(pool: CapturedPool): number[] {
    return pool.candidates.map(candidate => candidate.score ?? Number.NEGATIVE_INFINITY)
}

// One pool per line, so a recapture produces per-question diffs rather than one
// unreadable blob. The first line is the stamp.
export function savePools(path: string, file: PoolFile): void {
    mkdirSync(dirname(path), {recursive: true})
    const lines = [JSON.stringify(file.stamp), ...file.pools.map(pool => JSON.stringify(pool))]
    writeFileSync(path, `${lines.join('\n')}\n`)
}

export function loadPools(path: string): PoolFile {
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    const [stamp, ...pools] = lines
    return {
        stamp: JSON.parse(stamp!) as PoolStamp,
        pools: pools.map(line => JSON.parse(line) as CapturedPool)
    }
}
