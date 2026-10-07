// EmbeddingGemma 2 — turns text into a 768-dim vector, in-process on CPU.
//
// SERVE TIME ONLY. Documents are embedded at ingest by llama.cpp (GGUF Q8_0,
// mean pooling — see ingest/). Measured 2026-10-07 against the PyTorch fp32
// reference: these q8 query vectors match at cosine ≥ 0.99994 over the 249
// pooled questions, the GGUF document vectors at ≥ 0.9991 over all 7671 chunks.
//
// Not the feature-extraction pipeline. It pools last_hidden_state itself, which
// skips the model's 512→768 projection; the vector is the model's own
// `sentence_embedding` output. transformers.js 4.2.0 does not know
// embedding_gemma2 and falls back to one encoder session — exactly the
// text-only graph. The three media inputs get empty tensors.
//
// q8 (8-bit weight blocks) is 0.32 GiB and ~65 ms a query; fp32 is 1.04 GiB and
// ~25 ms. fp16 is not an option: the model card says its activations overflow
// fp16 into NaN or silently damaged vectors.
//
// Asymmetric prompts: questions and documents get different prefixes. Both
// live in prompts.ts so ingest and serve cannot drift.

import {
    AutoConfig,
    AutoModel,
    AutoTokenizer,
    Tensor,
    type PreTrainedModel,
    type PreTrainedTokenizer
} from '@huggingface/transformers'
import {config, getOptions} from '../config.js'
import {authorizeModelDownload, embedDtype, progressCallback} from './downloads.js'
import {loadFromCache} from './local-cache.js'
import {queryText} from './prompts.js'

// The model reads 8192 tokens; a chunk is at most ~1200. Questions arrive from
// an LLM and can run long — the cap keeps one runaway request cheap.
const MAX_TOKENS = 2048

type LoadedEmbedder = {tokenizer: PreTrainedTokenizer; model: PreTrainedModel}
// transformers.js types every model output as `any`.
type EmbeddingOutput = {sentence_embedding: Tensor}

// The promise is cached, not the result, so two first calls share one load.
const embedders = new Map<string, Promise<LoadedEmbedder>>()

function load(): Promise<LoadedEmbedder> {
    const {cacheDir} = getOptions()
    const cached = embedders.get(cacheDir)
    if (cached) return cached
    const loading = loadInto(cacheDir)
    embedders.set(cacheDir, loading)
    loading.catch(() => embedders.delete(cacheDir))
    return loading
}

async function loadInto(cacheDir: string): Promise<LoadedEmbedder> {
    await authorizeModelDownload('embedder')
    const options = {cache_dir: cacheDir, progress_callback: progressCallback('embedder')}
    // quiet: 4.2.0 warns twice that embedding_gemma2 is unknown and that it is
    // falling back to a single encoder session. That fallback is the right
    // graph, so the warning is noise in every consumer's log.
    return loadFromCache(
        cacheDir,
        async () => {
            const modelConfig = await AutoConfig.from_pretrained(config.embedModel, options)
            // Text only: without these the vision and audio encoders load too.
            Object.assign(modelConfig, {vision_config: null, audio_config: null})
            const tokenizer = await AutoTokenizer.from_pretrained(config.embedModel, options)
            const model = await AutoModel.from_pretrained(config.embedModel, {
                ...options,
                config: modelConfig,
                dtype: embedDtype(),
                device: config.device
            })
            return {tokenizer, model}
        },
        true
    )
}

const noMedia = () => new Tensor('float32', new Float32Array(0), [0, 512])

async function embed(text: string): Promise<number[]> {
    const {tokenizer, model} = await load()
    const encoded = tokenizer([text], {truncation: true, max_length: MAX_TOKENS})
    const output = (await model({
        ...encoded,
        image_features: noMedia(),
        video_features: noMedia(),
        audio_features: noMedia()
    })) as unknown as EmbeddingOutput
    return Array.from(output.sentence_embedding.data as Float32Array)
}

// Warm the model so the first real request isn't slow.
export async function loadEmbedder(): Promise<void> {
    await load()
}

export async function embedQuery(question: string): Promise<number[]> {
    return embed(queryText(question))
}

// Same contract as ingest/embed.ts: texts arrive formatted by documentText.
// One text per run — only scripts call this, to check the ingest box.
export async function embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (const text of texts) vectors.push(await embed(text))
    return vectors
}
