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
    LogLevel,
    Tensor,
    env,
    type PreTrainedTokenizer
} from '@huggingface/transformers'
import {config, getOptions} from '../config.js'
import {authorizeModelDownload, progressCallback} from './downloads.js'
import {useLocalCache} from './local-cache.js'
import {queryText} from './prompts.js'

// The model reads 8192 tokens; a chunk is at most ~1200. Questions arrive from
// an LLM and can run long — the cap keeps one runaway request cheap.
const MAX_TOKENS = 2048

type OnnxSession = {run(feeds: Record<string, unknown>): Promise<Record<string, {data: Float32Array}>>}
type LoadedEmbedder = {tokenizer: PreTrainedTokenizer; session: OnnxSession}
type Encoded = {input_ids: Tensor; attention_mask: Tensor}

const embedders = new Map<string, LoadedEmbedder>()

async function load(): Promise<LoadedEmbedder> {
    const {cacheDir} = getOptions()
    const cached = embedders.get(cacheDir)
    if (cached) return cached
    if ((config.embedDtype as string) === 'fp16')
        throw new Error('EmbeddingGemma 2 cannot run in fp16 (NaN or damaged vectors). Use RAG_DTYPE=q8 or fp32.')
    await authorizeModelDownload('embedder')
    useLocalCache(cacheDir)
    const options = {cache_dir: cacheDir, progress_callback: progressCallback('embedder')}
    const modelConfig = await AutoConfig.from_pretrained(config.embedModel, options)
    // Text only: without these the vision and audio encoders load too.
    Object.assign(modelConfig, {vision_config: null, audio_config: null})
    const tokenizer = await AutoTokenizer.from_pretrained(config.embedModel, options)
    // 4.2.0 warns twice that embedding_gemma2 is unknown and it is falling back
    // to a single encoder session. That fallback is the right graph, so the
    // warning is noise in every consumer's log.
    const logLevel = env.logLevel
    env.logLevel = LogLevel.ERROR
    try {
        const model = await AutoModel.from_pretrained(config.embedModel, {
            ...options,
            config: modelConfig,
            dtype: config.embedDtype,
            device: config.device
        })
        const loaded = {tokenizer, session: model.sessions.model as OnnxSession}
        embedders.set(cacheDir, loaded)
        return loaded
    } finally {
        env.logLevel = logLevel
    }
}

const noMedia = () => new Tensor('float32', new Float32Array(0), [0, 512]).ort_tensor

async function embed(text: string): Promise<number[]> {
    const {tokenizer, session} = await load()
    const encoded = tokenizer([text], {truncation: true, max_length: MAX_TOKENS}) as unknown as Encoded
    const output = await session.run({
        input_ids: encoded.input_ids.ort_tensor,
        attention_mask: encoded.attention_mask.ort_tensor,
        image_features: noMedia(),
        video_features: noMedia(),
        audio_features: noMedia()
    })
    return Array.from(output.sentence_embedding!.data)
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
