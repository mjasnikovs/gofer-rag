// The retrieval pipeline, shared by the API and the TUI.
//
//   question
//     → names no chapter title? expand it with Godot terms via the LLM
//     → embed (query mode)
//     → LanceDB: vector candidates ∪ BM25 full-text candidates ∪ title matches
//     → reranker judges them (against question + expansion terms), sort by score
//     → GATE: best score below threshold → "not found" (no LLM, cannot guess)
//     → keep top-N above threshold → LLM writes a grounded, cited answer

import {embedQuery, loadEmbedder} from '../ai/embedder.js'
import {rerank, loadReranker} from '../ai/reranker.js'
import {generateAnswer, expandQuery} from '../ai/llm.js'
import {loadTable, vectorSearch, ftsSearch, titleSearch, matchedTitles, symbolTokens} from '../store/db.js'
import {config, getOptions} from '../config.js'
import type {QueryResult, RankedChunk, StoredChunk} from '../types.js'

export type QueryDependencies = {
    embedQuery: typeof embedQuery
    loadEmbedder: typeof loadEmbedder
    rerank: typeof rerank
    loadReranker: typeof loadReranker
    generateAnswer: typeof generateAnswer
    expandQuery: typeof expandQuery
    loadTable: typeof loadTable
    vectorSearch: typeof vectorSearch
    ftsSearch: typeof ftsSearch
    titleSearch: typeof titleSearch
    matchedTitles: typeof matchedTitles
}

const defaultDependencies: QueryDependencies = {
    embedQuery,
    loadEmbedder,
    rerank,
    loadReranker,
    generateAnswer,
    expandQuery,
    loadTable,
    vectorSearch,
    ftsSearch,
    titleSearch,
    matchedTitles
}

// The LLM is told to emit config.notFoundMessage verbatim when the retrieved
// context doesn't answer the question. It may add punctuation/quotes, so match
// on a normalized prefix rather than exact equality.
export function isRefusal(answer: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
    return normalize(answer).startsWith(normalize(config.notFoundMessage))
}

// Load both models and the table up front so the first query isn't slow.
export async function warmup(dependencies: QueryDependencies = defaultDependencies): Promise<void> {
    await Promise.all([dependencies.loadEmbedder(), dependencies.loadReranker(), dependencies.loadTable()])
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
    question: string,
    dependencies: QueryDependencies = defaultDependencies
): Promise<{candidates: StoredChunk[]; expansion: string; titles: string[]}> {
    const titles = await dependencies.matchedTitles(question)
    const expansion = titles.length > 0 ? '' : await dependencies.expandQuery(question)
    const text = expansion ? `${question} ${expansion}` : question
    const vector = await dependencies.embedQuery(text)
    const [vectorHits, ftsHits, titleHits] = await Promise.all([
        dependencies.vectorSearch(vector, config.vectorTopK),
        dependencies.ftsSearch(text, config.ftsTopK),
        dependencies.titleSearch(text, config.titleTopK)
    ])
    return {candidates: mergeCandidates(vectorHits, ftsHits, titleHits), expansion, titles}
}

export function mergeCandidates(...sources: StoredChunk[][]): StoredChunk[] {
    return [...new Map(sources.flat().map(candidate => [candidate.id, candidate])).values()]
}

// How many passages survive, and on what grounds.
//
// `keep` is the score-ranked fill budget — the historical `rerankKeep`. It is
// NOT a ceiling: the title pin appends after it, so lowering `keep` alone
// raises the number of pins (a pin fires precisely when a named chapter fell
// out of the kept set). Measured on 130 real consumer searches, keep 3 returns
// 3.37 passages per call, not 3.
//
// `maxPassages` is the ceiling, pins included. It exists because the consumer
// needs a hard bound and its only alternative was slicing the returned array —
// which cuts the pins first, since a pin always scores below every score-kept
// chunk. Unset (Infinity) reproduces the historical behaviour exactly.
//
// `maxGap` drops chunks more than G logits below the best one. Default Infinity
// so it is inert; it exists so the A/B harness can measure a relative cut
// against the frozen pools without a second code path.
//
// `pinReserve` caps how many pins a ceiling may admit. Default Infinity, which
// leaves the half-rule below in charge; the A/B harness sets it to 0 to measure
// what reserving a pin slot actually buys.
export type CutPolicy = {
    keep: number
    maxPassages: number
    maxGap: number
    pinReserve: number
}

export function defaultCut(): CutPolicy {
    return {
        keep: config.rerankKeep,
        maxPassages: getOptions().maxPassages,
        maxGap: Number.POSITIVE_INFINITY,
        pinReserve: Number.POSITIVE_INFINITY
    }
}

export function rankCandidates(
    question: string,
    candidates: StoredChunk[],
    scores: number[],
    titles: string[],
    cut: CutPolicy = defaultCut()
): RankedChunk[] {
    const ranked = candidates
        .map((candidate, i) => ({...candidate, score: scores[i]!}))
        .sort((a, b) => b.score - a.score)
        .filter(candidate => candidate.score >= config.rerankThreshold)

    // Relative cut, inert at the default Infinity. Applied after the absolute
    // threshold and before everything else, so a gap arm and the count arms
    // compose rather than fight.
    const best = ranked[0]?.score ?? 0
    const eligible = ranked.filter(candidate => best - candidate.score <= cut.maxGap)

    // One chunk per chapter, unless the question named that chapter. Five slots
    // are all the answer LLM gets, and two chunks of the same reference page
    // spend two of them on one source: "How do I connect a signal to a method
    // in GDScript?" kept Object twice and pushed "Using signals" to rank 5 of 5
    // (measured 2026-08-06). A question that NAMES a chapter is the opposite
    // case — an entity question wants its class page's intro AND the chunk
    // documenting the member — so named chapters are exempt. Measured over 225
    // captured pools, paired, no LLM in the loop:
    //
    //   no cap (before)          fundamentals 13/20, hand 53/60, class-ref 116/120
    //   cap every chapter at 1   fundamentals 14/20, hand 54/60, class-ref 105/120
    //   cap every chapter at 2   fundamentals 14/20, hand 53/60, class-ref 110/120
    //   cap only unnamed at 1    fundamentals 14/20, hand 54/60, class-ref 116/120
    //
    // The blanket caps pay for the same two gains with 6–11 class-ref losses
    // (offset_top of Control, get_nodes_in_group of SceneTree, ...) — all of
    // them the second chunk of the named class's own page. Refusals (3/5 and
    // 18/20) are identical in every arm and untouched by construction: a cap
    // can only replace a kept chunk with a different one, never empty the set.
    const named = new Set(titles)
    const kept: RankedChunk[] = []
    for (const candidate of eligible) {
        if (kept.length >= Math.min(cut.keep, cut.maxPassages)) break
        if (kept.some(k => k.chapter === candidate.chapter) && !named.has(candidate.chapter)) continue
        kept.push(candidate)
    }

    const symbols = symbolTokens(question)
    const pins: RankedChunk[] = []
    for (const title of [...titles].sort((a, b) => b.length - a.length).slice(0, 3)) {
        if (kept.some(candidate => candidate.chapter === title)) continue
        const own = eligible.filter(candidate => candidate.chapter === title)
        const pick = own.find(candidate => symbols.some(symbol => candidate.text.includes(symbol))) ?? own[0]
        if (pick) pins.push({...pick, pinned: true})
    }

    if (pins.length === 0) return kept.slice(0, cut.maxPassages)

    // Pin budget. INVENTED POLICY, measured against nothing — it only fires on
    // a path that did not exist before `maxPassages`, and the A/B harness can
    // revisit it for free against the frozen pools. The reasoning: over 130 real
    // searches a pin's mean score is -1.20 while rank 2's is 1.58, so letting
    // three pins evict ranks 2 and 3 would be a quality trade nobody has
    // measured. Half the ceiling bounds it; at least one pin still gets in
    // whenever there is room for two passages at all, because a ceiling that
    // silently drops every rescue is the exact failure this parameter exists to
    // prevent. Order stays title-length-descending — the pin loop's existing
    // rule — rather than inventing a second one.
    //
    // Measured after the fact via `pinReserve: 0` in scripts/ab-cut.ts: at a
    // ceiling of 3 the reservation is worth one labelled case, and it costs
    // none. See PASSAGE-CUT.md.
    const halfRule = cut.maxPassages >= 2 ? Math.max(1, Math.floor(cut.maxPassages / 2)) : 0
    const admitted = pins.slice(0, Math.min(halfRule, cut.pinReserve))
    return [...kept.slice(0, Math.max(0, cut.maxPassages - admitted.length)), ...admitted]
}

export type RetrievalDetail = {
    candidates: StoredChunk[]
    expansion: string
    kept: RankedChunk[]
    // Every candidate the reranker actually scored, best first. The two-stage
    // rerank leaves prefilter-dropped candidates at -Infinity; those are
    // excluded. eval-fundamentals reads this to measure the margin between the
    // expected chapter and the next candidate under it.
    scored: RankedChunk[]
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
export async function retrieveDetailed(
    question: string,
    dependencies: QueryDependencies = defaultDependencies,
    cut: CutPolicy = defaultCut()
): Promise<RetrievalDetail> {
    const {candidates, expansion, titles} = await gatherCandidates(question, dependencies)
    if (candidates.length === 0) return {candidates, expansion, kept: [], scored: []}
    const scores = await dependencies.rerank(
        expansion ? `${question} ${expansion}` : question,
        candidates.map(c => c.text)
    )
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
    return {
        candidates,
        expansion,
        kept: rankCandidates(question, candidates, scores, titles, cut),
        scored: candidates
            .map((candidate, i) => ({...candidate, score: scores[i]!}))
            .filter(candidate => Number.isFinite(candidate.score))
            .sort((a, b) => b.score - a.score)
    }
}

export async function retrieve(
    question: string,
    dependencies: QueryDependencies = defaultDependencies,
    cut: CutPolicy = defaultCut()
): Promise<RankedChunk[]> {
    return (await retrieveDetailed(question, dependencies, cut)).kept
}

export async function query(
    question: string,
    dependencies: QueryDependencies = defaultDependencies
): Promise<QueryResult> {
    // First gate: nothing cleared the reranker threshold — don't even call the LLM.
    const top = await retrieve(question, dependencies)
    if (top.length === 0) return {found: false, message: config.notFoundMessage}

    // Second gate: the LLM saw the context and judged it insufficient.
    const context = top.map((chunk, i) => `[${i + 1}] (${chunk.chapter})\n${chunk.text}`).join('\n\n')
    const answer = await dependencies.generateAnswer(question, context)
    if (isRefusal(answer)) return {found: false, message: config.notFoundMessage}

    return {
        found: true,
        answer,
        sources: top.map(chunk => ({chapter: chunk.chapter, order: chunk.order, score: chunk.score}))
    }
}
