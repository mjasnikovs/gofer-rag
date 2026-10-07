import {stat} from 'node:fs/promises'
import {join} from 'node:path'
import {config, getOptions, type EmbedDtype} from '../config.js'
import type {DownloadProgress, ModelDownload} from '../types.js'

export type ModelDefinition = {
    id: string
    expectedBytes: number
    requiredFiles: string[]
}

type TransformerProgress = {
    file?: string
    status?: string
    loaded?: number
    total?: number
    progress?: number
}

// What each embedder dtype pulls from the Hub, byte for byte (HF file list,
// 2026-10-07). The `.onnx_data` file holds the weights; the `.onnx` file is the
// graph. tokenizer_config.json is listed because the tokenizer will not load
// without it — a cache missing it is not usable offline.
const embedderWeights: Record<EmbedDtype, {file: string; expectedBytes: number}> = {
    q8: {file: 'onnx/model_quantized.onnx', expectedBytes: 346_397_233},
    fp32: {file: 'onnx/model.onnx', expectedBytes: 1_116_768_801}
}

// The one gate on RAG_DTYPE. Anything else would make the consent check look
// at one dtype's files while the loader fetches another's.
export function embedDtype(value: string = config.embedDtype): EmbedDtype {
    if (value === 'q8' || value === 'fp32') return value
    throw new Error(`RAG_DTYPE=${value} is not supported: EmbeddingGemma 2 runs as q8 or fp32 (fp16 overflows it)`)
}

export function embedderDefinition(dtype: EmbedDtype): ModelDefinition {
    const weights = embedderWeights[dtype]
    return {
        id: config.embedModel,
        expectedBytes: weights.expectedBytes,
        requiredFiles: ['config.json', 'tokenizer.json', 'tokenizer_config.json', weights.file, `${weights.file}_data`]
    }
}

type ModelKind = 'embedder' | 'reranker' | 'prefilter'

const rerankers: Record<Exclude<ModelKind, 'embedder'>, ModelDefinition> = {
    reranker: {
        id: config.rerankModel,
        expectedBytes: 587_812_045,
        requiredFiles: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
    },
    prefilter: {
        id: config.prefilterModel,
        expectedBytes: 23_856_961,
        requiredFiles: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
    }
}

function definition(kind: ModelKind): ModelDefinition {
    return kind === 'embedder' ? embedderDefinition(embedDtype()) : rerankers[kind]
}

const approved = new Set<string>()

export function modelDownload(kind: ModelKind): ModelDownload {
    const model = definition(kind)
    const cacheDir = getOptions().cacheDir
    return {
        name: model.id,
        source: `https://huggingface.co/${model.id}`,
        destination: join(cacheDir, model.id),
        expectedBytes: model.expectedBytes
    }
}

export async function isModelCached(kind: ModelKind): Promise<boolean> {
    const download = modelDownload(kind)
    try {
        const files = await Promise.all(
            definition(kind).requiredFiles.map(file => stat(join(download.destination, file)))
        )
        if (files.some(file => !file.isFile() || file.size === 0)) return false
        return true
    } catch {
        return false
    }
}

export async function authorizeModelDownload(kind: ModelKind): Promise<void> {
    await authorizeModelDownloads([kind])
}

export async function authorizeModelDownloads(kinds: ModelKind[]): Promise<void> {
    const missing: ModelDownload[] = []
    for (const kind of kinds) {
        const download = modelDownload(kind)
        if (!(await isModelCached(kind)) && !approved.has(download.destination)) missing.push(download)
    }
    if (missing.length === 0) return

    const consent = getOptions().allowModelDownloads
    const allowed = typeof consent === 'function' ? await consent(missing) : consent
    if (!allowed)
        throw new Error(
            `Model download approval required for ${missing.map(model => `${model.name} (${formatBytes(model.expectedBytes)}) from ${model.source} to ${model.destination}`).join('; ')}. Set allowModelDownloads: true, provide a consent callback, use --allow-downloads, or pre-populate the cache.`
        )
    for (const download of missing) approved.add(download.destination)
}

export function progressCallback(kind: ModelKind): (event: TransformerProgress) => void {
    const model = definition(kind).id
    return event => {
        const progress: DownloadProgress = {
            model,
            status: event.status ?? 'progress',
            file: event.file,
            loaded: event.loaded,
            total: event.total,
            progress: event.progress
        }
        getOptions().onDownloadProgress?.(progress)
    }
}

export function formatBytes(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

export function resetDownloadApprovals(): void {
    approved.clear()
}
