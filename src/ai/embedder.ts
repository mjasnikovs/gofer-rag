// Qwen3-Embedding-0.6B — turns text into a 1024-dim vector, in-process on CPU.
//
// SERVE TIME ONLY. Documents are embedded at ingest time by llama.cpp (GGUF
// Q8_0, mean pooling — see ingest/). These query vectors match those document
// vectors at cosine 0.9997 when this runs fp16; ONNX q8 does NOT match (0.91),
// which is why config.modelDtype defaults to fp16 — don't "optimize" it back.
//
// Qwen3 embeddings are asymmetric: questions get an instruction prefix, the
// documents being searched do not. Getting this right measurably improves recall,
// so callers use embedQuery vs embedDocuments rather than a single embed().

import {pipeline, type FeatureExtractionPipeline} from '@huggingface/transformers'
import {config, getOptions} from '../config.js'
import {authorizeModelDownload, progressCallback} from './downloads.js'

const QUERY_INSTRUCT =
    'Instruct: Given a question about the Godot game engine, retrieve documentation passages that answer it\nQuery:'

const extractors = new Map<string, FeatureExtractionPipeline>()

async function getExtractor(): Promise<FeatureExtractionPipeline> {
    const {cacheDir} = getOptions()
    const cached = extractors.get(cacheDir)
    if (cached) return cached
    await authorizeModelDownload('embedder')
    const extractor = await pipeline('feature-extraction', config.embedModel, {
        dtype: config.embedDtype,
        device: config.device,
        cache_dir: cacheDir,
        progress_callback: progressCallback('embedder')
    })
    extractors.set(cacheDir, extractor)
    return extractor
}

async function embed(texts: string[]): Promise<number[][]> {
    const pipe = await getExtractor()
    const output = await pipe(texts, {pooling: 'mean', normalize: true})
    return output.tolist() as number[][]
}

// Warm the model so the first real request isn't slow.
export async function loadEmbedder(): Promise<void> {
    await getExtractor()
}

export async function embedQuery(text: string): Promise<number[]> {
    const [vector] = await embed([`${QUERY_INSTRUCT}${text}`])
    return vector!
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
    return embed(texts)
}
