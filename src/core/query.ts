// The retrieval pipeline, shared by the API and the TUI.
//
//   question
//     → embed (query mode)
//     → LanceDB: top-K vector candidates ∪ top-K BM25 full-text candidates
//     → reranker judges them, sort by score
//     → GATE: best score below threshold → "not found" (no LLM, cannot guess)
//     → keep top-N above threshold → LLM writes a grounded, cited answer

import {embedQuery, loadEmbedder} from '../ai/embedder'
import {rerank, loadReranker} from '../ai/reranker'
import {generateAnswer} from '../ai/llm'
import {loadTable, vectorSearch, ftsSearch, titleSearch} from '../store/db'
import {config} from '../config'
import type {QueryResult, RankedChunk} from '../types'

// The LLM is told to emit config.notFoundMessage verbatim when the retrieved
// context doesn't answer the question. It may add punctuation/quotes, so match
// on a normalized prefix rather than exact equality.
function isRefusal(answer: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
    return normalize(answer).startsWith(normalize(config.notFoundMessage))
}

// Load both models and the table up front so the first query isn't slow.
export async function warmup(): Promise<void> {
    await Promise.all([loadEmbedder(), loadReranker(), loadTable()])
}

// Retrieve + rerank, keeping only passages above the relevance threshold.
// Three candidate sources, each catching what the others miss: vector search
// for paraphrases, corpus-wide BM25 for rare exact tokens, and title match for
// class names too common for BM25. Merged (deduped by chunk id), then reranked.
export async function retrieve(question: string): Promise<RankedChunk[]> {
    const vector = await embedQuery(question)
    const [vectorHits, ftsHits, titleHits] = await Promise.all([
        vectorSearch(vector, config.vectorTopK),
        ftsSearch(question, config.ftsTopK),
        titleSearch(question, config.titleTopK)
    ])
    const byId = new Map(vectorHits.concat(ftsHits, titleHits).map(c => [c.id, c]))
    const candidates = [...byId.values()]
    if (candidates.length === 0) return []
    const scores = await rerank(
        question,
        candidates.map(c => c.text)
    )
    return candidates
        .map((candidate, i) => ({...candidate, score: scores[i]!}))
        .sort((a, b) => b.score - a.score)
        .filter(candidate => candidate.score >= config.rerankThreshold)
        .slice(0, config.rerankKeep)
}

export async function query(question: string): Promise<QueryResult> {
    // First gate: nothing cleared the reranker threshold — don't even call the LLM.
    const top = await retrieve(question)
    if (top.length === 0) return {found: false, message: config.notFoundMessage}

    // Second gate: the LLM saw the context and judged it insufficient.
    const context = top.map((chunk, i) => `[${i + 1}] (${chunk.chapter})\n${chunk.text}`).join('\n\n')
    const answer = await generateAnswer(question, context)
    if (isRefusal(answer)) return {found: false, message: config.notFoundMessage}

    return {
        found: true,
        answer,
        sources: top.map(chunk => ({chapter: chunk.chapter, order: chunk.order, score: chunk.score}))
    }
}
