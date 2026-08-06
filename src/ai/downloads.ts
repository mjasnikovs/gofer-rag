import {stat} from 'node:fs/promises'
import {join} from 'node:path'
import {config, getOptions} from '../config.js'
import type {DownloadProgress, ModelDownload} from '../types.js'

type ModelDefinition = {
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

const definitions: Record<'embedder' | 'reranker' | 'prefilter', ModelDefinition> = {
    embedder: {
        id: config.embedModel,
        expectedBytes: 1_211_945_830,
        requiredFiles: ['config.json', 'tokenizer.json', 'onnx/model_fp16.onnx', 'onnx/model_fp16.onnx_data']
    },
    reranker: {
        id: config.rerankModel,
        expectedBytes: 587_812_045,
        requiredFiles: ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']
    },
    prefilter: {
        id: config.prefilterModel,
        expectedBytes: 23_856_961,
        requiredFiles: ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']
    }
}

const approved = new Set<string>()

export function modelDownload(kind: keyof typeof definitions): ModelDownload {
    const definition = definitions[kind]
    const cacheDir = getOptions().cacheDir
    return {
        name: definition.id,
        source: `https://huggingface.co/${definition.id}`,
        destination: join(cacheDir, definition.id),
        expectedBytes: definition.expectedBytes
    }
}

export async function isModelCached(kind: keyof typeof definitions): Promise<boolean> {
    const download = modelDownload(kind)
    try {
        const files = await Promise.all(
            definitions[kind].requiredFiles.map(file => stat(join(download.destination, file)))
        )
        if (files.some(file => !file.isFile() || file.size === 0)) return false
        return true
    } catch {
        return false
    }
}

export async function authorizeModelDownload(kind: keyof typeof definitions): Promise<void> {
    await authorizeModelDownloads([kind])
}

export async function authorizeModelDownloads(kinds: (keyof typeof definitions)[]): Promise<void> {
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

export function progressCallback(kind: keyof typeof definitions): (event: TransformerProgress) => void {
    const model = definitions[kind].id
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
