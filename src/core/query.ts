// The retrieval pipeline, shared by the API and the TUI.
//
//   question
//     → names no chapter title? expand it with Godot terms via the LLM
//     → embed (query mode)
//     → LanceDB: vector candidates ∪ BM25 full-text candidates ∪ title matches
//     → reranker judges them (against question + expansion terms), sort by score
//     → GATE: best score below threshold → "not found" (no LLM, cannot guess)
//     → keep top-N above threshold → LLM writes a grounded, cited answer

import {embedQuery, loadEmbedder} from '../ai/embedder'
import {rerank, loadReranker} from '../ai/reranker'
import {generateAnswer, expandQuery} from '../ai/llm'
import {loadTable, vectorSearch, ftsSearch, titleSearch, matchedTitles, symbolTokens} from '../store/db'
import {config} from '../config'
import type {QueryResult, RankedChunk, StoredChunk} from '../types'

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

// Build the candidate pool retrieve() reranks. Exported so evals measure the
// exact production pool.
//
// Casual questions that name no chapter title are the measured blind spot:
// their vocabulary misses the docs entirely — expected chapters sat at vector
// rank 91–300+ (measured 2026-07-13) and BM25/titleSearch had nothing to grab.
// For those, the 27B expands the question with likely Godot terms and the
// expanded text feeds all three sources; the terms are often chapter titles
// themselves (Tween, CanvasLayer), which lets titleSearch fire after all.
// Questions that DO name a title skip expansion: candidate coverage is already
// 99.99% there, and skipping keeps symbol lookups LLM-free and fast.
export async function gatherCandidates(
    question: string
): Promise<{candidates: StoredChunk[]; expansion: string; titles: string[]}> {
    const titles = await matchedTitles(question)
    const expansion = titles.length > 0 ? '' : await expandQuery(question)
    const text = expansion ? `${question} ${expansion}` : question
    const vector = await embedQuery(text)
    const [vectorHits, ftsHits, titleHits] = await Promise.all([
        vectorSearch(vector, config.vectorTopK),
        ftsSearch(text, config.ftsTopK),
        titleSearch(text, config.titleTopK)
    ])
    const byId = new Map(vectorHits.concat(ftsHits, titleHits).map(c => [c.id, c]))
    return {candidates: [...byId.values()], expansion, titles}
}

export type RetrievalDetail = {
    candidates: StoredChunk[]
    expansion: string
    kept: RankedChunk[]
}

// Retrieve + rerank, keeping only passages above the relevance threshold.
// Three candidate sources, each catching what the others miss: vector search
// for paraphrases, corpus-wide BM25 for rare exact tokens, and title match for
// class names too common for BM25. Merged (deduped by chunk id), then reranked.
//
// When expansion fired, the reranker judges against question + expansion terms:
// against the casual question alone, the right chapter scores below -4 even
// when expansion pulled it into the pool ("enemy chase the player" left
// NavigationAgents unkept; with the terms appended it scores +1.8 — measured
// 2026-07-13). Safe for the refusal gate because off-topic questions get no
// expansion (expandQuery rejects non-term-list replies) and rerank exactly as
// before. The detailed form exists so evals measure the production pipeline
// while still seeing the pool and the expansion.
export async function retrieveDetailed(question: string): Promise<RetrievalDetail> {
    const {candidates, expansion, titles} = await gatherCandidates(question)
    if (candidates.length === 0) return {candidates, expansion, kept: []}
    const scores = await rerank(
        expansion ? `${question} ${expansion}` : question,
        candidates.map(c => c.text)
    )
    const ranked = candidates
        .map((candidate, i) => ({...candidate, score: scores[i]!}))
        .sort((a, b) => b.score - a.score)
        .filter(candidate => candidate.score >= config.rerankThreshold)
    const kept = ranked.slice(0, config.rerankKeep)

    // Title pin: a chapter named verbatim in the question is what the user is
    // asking about, but the cross-encoder prefers tutorial prose that MENTIONS
    // the class over its terse reference page opening with "Inherits:" — the
    // BoxMesh page scored -2.1 at rank 11 while "Add a BoxMesh" SoftBody3D
    // chunks filled the kept set (measured 2026-07-14, both rerank backends).
    // So append the named chapter's best above-threshold chunk when none made
    // the cut, preferring one that contains a member symbol from the question
    // ("font property of Tree" wants Tree's font chunk, not Tree's intro).
    // Refusals are untouched by construction: an above-threshold chunk outside
    // kept can only exist when kept is already full. Same top-3-longest-titles
    // cap as titleSearch.
    const symbols = symbolTokens(question)
    for (const title of [...titles].sort((a, b) => b.length - a.length).slice(0, 3)) {
        if (kept.some(c => c.chapter === title)) continue
        const own = ranked.filter(c => c.chapter === title)
        const pick = own.find(c => symbols.some(s => c.text.includes(s))) ?? own[0]
        if (pick) kept.push(pick)
    }

    return {candidates, expansion, kept}
}

export async function retrieve(question: string): Promise<RankedChunk[]> {
    return (await retrieveDetailed(question)).kept
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
