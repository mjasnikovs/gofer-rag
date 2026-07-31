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

const loadedRerankers = new Map<string, LoadedReranker>()

async function load(): Promise<LoadedReranker> {
    const {cacheDir} = getOptions()
    const cached = loadedRerankers.get(cacheDir)
    if (cached) return cached
    await authorizeModelDownload('reranker')
    const progress = progressCallback('reranker')
    const tokenizer = await AutoTokenizer.from_pretrained(config.rerankModel, {
        cache_dir: cacheDir,
        progress_callback: progress
    })
    const model = await AutoModelForSequenceClassification.from_pretrained(config.rerankModel, {
        dtype: config.rerankDtype,
        device: config.device,
        cache_dir: cacheDir,
        progress_callback: progress
    })
    const loaded = {tokenizer, model}
    loadedRerankers.set(cacheDir, loaded)
    return loaded
}

// Warm the model so the first real request isn't slow. When a rerank box is
// configured the ONNX model is never used — don't load it.
export async function loadReranker(): Promise<void> {
    if (config.rerankUrl) return
    await load()
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

// Returns one relevance logit per passage, in the same order as the input.
export async function rerank(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return []
    if (config.rerankUrl) return rerankViaBox(query, passages)
    const {tokenizer: tok, model: mdl} = await load()
    const inputs = tok(new Array<string>(passages.length).fill(query), {
        text_pair: passages,
        padding: true,
        truncation: true
    })
    const output = (await mdl(inputs)) as unknown as SequenceClassifierOutput
    return output.logits.tolist().map(row => row[0]!)
}
