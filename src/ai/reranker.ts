// bge-reranker-v2-m3 — a cross-encoder that scores how well a passage answers a
// query. Higher logit = more relevant.
//
// NOTE: do NOT use the text-classification pipeline. This model has a single
// output label, and that pipeline softmaxes over it, which always yields 1.0 and
// throws the score away. We call the model directly and read the raw logit.

import {
    AutoTokenizer,
    AutoModelForSequenceClassification,
    type PreTrainedTokenizer,
    type PreTrainedModel
} from '@huggingface/transformers'
import {config, getOptions} from '../config.js'
import {authorizeModelDownload, progressCallback} from './downloads.js'

type LoadedReranker = {tokenizer: PreTrainedTokenizer; model: PreTrainedModel}
type Stage = 'reranker' | 'prefilter'

const loadedRerankers = new Map<string, LoadedReranker>()

async function load(stage: Stage): Promise<LoadedReranker> {
    const {cacheDir} = getOptions()
    const key = `${stage}:${cacheDir}`
    const cached = loadedRerankers.get(key)
    if (cached) return cached
    await authorizeModelDownload(stage)
    const progress = progressCallback(stage)
    const id = stage === 'reranker' ? config.rerankModel : config.prefilterModel
    const tokenizer = await AutoTokenizer.from_pretrained(id, {
        cache_dir: cacheDir,
        progress_callback: progress
    })
    const model = await AutoModelForSequenceClassification.from_pretrained(id, {
        dtype: stage === 'reranker' ? config.rerankDtype : config.prefilterDtype,
        device: config.device,
        cache_dir: cacheDir,
        progress_callback: progress
    })
    const loaded = {tokenizer, model}
    loadedRerankers.set(key, loaded)
    return loaded
}

// Warm the models so the first real request isn't slow. When a rerank box is
// configured neither ONNX model is used — don't load them.
export async function loadReranker(): Promise<void> {
    if (config.rerankUrl) return
    await Promise.all([load('reranker'), load('prefilter')])
}

type SequenceClassifierOutput = {
    logits: {tolist(): number[][]}
}

type RerankBoxResponse = {
    results: {index: number; relevance_score: number}[]
}

// llama.cpp /v1/rerank with the same model (Q8_0 GGUF). relevance_score is the
// raw classifier logit, same scale as the ONNX path — validated pairwise by
// scripts/validate-llamacpp-rerank.ts before the -4 threshold was trusted here.
async function rerankViaBox(query: string, passages: string[]): Promise<number[]> {
    const res = await fetch(`${config.rerankUrl}/v1/rerank`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query, documents: passages, top_n: passages.length})
    })
    if (!res.ok) throw new Error(`rerank box request failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as RerankBoxResponse
    const scores = new Array<number>(passages.length)
    for (const r of data.results) scores[r.index] = r.relevance_score
    return scores
}

// Score passages in length-sorted batches of config.rerankBatch. Every pair in
// a batch is padded to the longest one, so one big batch pays for padding it
// does not need — the same reason ingest embeds shortest-first.
async function score(
    stage: Stage,
    query: string,
    passages: string[],
    indices: number[],
    batchSize: number
): Promise<number[]> {
    const {tokenizer: tok, model: mdl} = await load(stage)
    const order = [...indices].sort((a, b) => passages[a]!.length - passages[b]!.length)
    const scores = new Array<number>(passages.length).fill(-Infinity)
    for (let start = 0; start < order.length; start += batchSize) {
        const batch = order.slice(start, start + batchSize)
        const inputs = tok(new Array<string>(batch.length).fill(query), {
            text_pair: batch.map(i => passages[i]!),
            padding: true,
            truncation: true
        })
        const output = (await mdl(inputs)) as unknown as SequenceClassifierOutput
        output.logits.tolist().forEach((row, k) => (scores[batch[k]!] = row[0]!))
    }
    return scores
}

// Returns one relevance logit per passage, in the same order as the input.
//
// Two stages: ms-marco-MiniLM-L-6-v2 (23 MB, 22M params) skims the whole pool
// in ~0.7s and forwards its top config.prefilterKeep to bge-reranker-v2-m3,
// which does the scoring that counts. Passages the prefilter drops score
// -Infinity — they are rejected, and the threshold in rankCandidates treats
// them as such.
//
// Measured 2026-08-06, both arms over identical captured pools (no LLM in the
// loop, so expansion nondeterminism can't muddy the comparison). The final
// logits are still bge's, so rerankThreshold needed no recalibration.
//
//   65 hand-written eval pools   18.16s → 5.52s   55/60 hits, 3/5 refusals in
//                                                 BOTH arms — zero questions
//                                                 flipped either way
//   140 class-ref pools          21.8s  → 4.99s   115/120 vs 117/120 hits,
//                                                 14/20 refusals in both
//
// The two it loses are "What does the X node do?" for AnimationNodeAdd2 and
// Path3D. Forwarding more candidates does not buy them back: prefilterKeep 12
// scores 116/120 but refuses one fewer off-topic question, and 14 scores
// 115/120 refusing two fewer — non-monotonic, because widening the second
// stage changes its batch and every quantized score with it. 10 is the value
// that matches the old refusal behaviour at the lowest cost.
export async function rerank(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return []
    // The rerank box is a GPU already doing this in under a second — sending it
    // through a CPU prefilter first would only slow it down.
    if (config.rerankUrl) return rerankViaBox(query, passages)

    const all = passages.map((_, i) => i)
    // The survivors go through in ONE batch: quantized scores shift with batch
    // composition, and splitting the finalists dropped "Using signals" from the
    // kept set for "connect a signal to a method" (eval-retrieval 9/10,
    // measured 2026-08-06). Only the prefilter, which reads the long pool, is
    // batched — it decides membership, not the final order.
    if (passages.length <= config.prefilterKeep) return score('reranker', query, passages, all, passages.length)

    const cheap = await score('prefilter', query, passages, all, config.rerankBatch)
    const survivors = all.sort((a, b) => cheap[b]! - cheap[a]!).slice(0, config.prefilterKeep)
    return score('reranker', query, passages, survivors, survivors.length)
}
