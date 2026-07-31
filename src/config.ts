import {homedir} from 'node:os'
import {dirname, isAbsolute, join, resolve, win32} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {GoferOptions, ResolvedGoferOptions} from './types.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const optionNames = new Set<string>([
    'cacheDir',
    'databasePath',
    'llmBaseUrl',
    'llmModel',
    'allowModelDownloads',
    'onDownloadProgress'
])

export function defaultCacheDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
    const override = process.env.GOFER_RAG_CACHE_DIR
    if (override) return validateAbsolutePath('GOFER_RAG_CACHE_DIR', override)
    if (platform === 'win32')
        return win32.join(process.env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'gofer-rag')
    if (platform === 'darwin') return join(home, 'Library', 'Caches', 'gofer-rag')
    return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'gofer-rag')
}

function validateAbsolutePath(name: string, value: string): string {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
    return value
}

function validateUrl(value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error('llmBaseUrl must be a valid absolute URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('llmBaseUrl must use http: or https:')
    return value.replace(/\/$/, '')
}

function environmentBoolean(name: string): boolean | undefined {
    const value = process.env[name]
    if (value === undefined) return undefined
    if (value === '1' || value.toLowerCase() === 'true') return true
    if (value === '0' || value.toLowerCase() === 'false') return false
    throw new Error(`${name} must be one of: 1, 0, true, false`)
}

let programmaticOptions: GoferOptions = {}

export function configure(options: GoferOptions = {}): ResolvedGoferOptions {
    validateOptions(options)
    const previous = programmaticOptions
    programmaticOptions = {...programmaticOptions, ...options}
    try {
        return getOptions()
    } catch (error) {
        programmaticOptions = previous
        throw error
    }
}

function validateOptions(options: unknown): asserts options is GoferOptions {
    if (options === null || typeof options !== 'object' || Array.isArray(options))
        throw new TypeError('options must be an object')

    for (const name of Reflect.ownKeys(options)) {
        if (typeof name !== 'string' || !optionNames.has(name)) throw new TypeError(`unknown option: ${String(name)}`)
    }

    const values = options as Record<string, unknown>
    validateOptionalString('cacheDir', values.cacheDir)
    validateOptionalString('databasePath', values.databasePath)
    validateOptionalString('llmBaseUrl', values.llmBaseUrl)
    validateOptionalString('llmModel', values.llmModel)

    const consent = values.allowModelDownloads
    if (consent !== undefined && typeof consent !== 'boolean' && typeof consent !== 'function')
        throw new TypeError('allowModelDownloads must be a boolean or consent callback')

    const progress = values.onDownloadProgress
    if (progress !== undefined && typeof progress !== 'function')
        throw new TypeError('onDownloadProgress must be a function')
}

function validateOptionalString(name: keyof GoferOptions, value: unknown): void {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string`)
}

export function resetConfiguration(): void {
    programmaticOptions = {}
}

export function getOptions(): ResolvedGoferOptions {
    const cacheDir = programmaticOptions.cacheDir ?? defaultCacheDir()
    const databasePath =
        programmaticOptions.databasePath ?? process.env.GOFER_RAG_DATABASE_PATH ?? join(packageRoot, '.lancedb')
    const llmBaseUrl =
        programmaticOptions.llmBaseUrl ?? process.env.GOFER_RAG_LLM_BASE_URL ?? 'http://localhost:8080/v1'
    const llmModel = programmaticOptions.llmModel ?? process.env.GOFER_RAG_LLM_MODEL ?? 'Qwen3.6-27B-NVFP4-MTP.gguf'
    const environmentConsent = environmentBoolean('GOFER_RAG_ALLOW_MODEL_DOWNLOADS')

    if (!llmModel.trim()) throw new Error('llmModel must not be empty')
    return {
        cacheDir: validateAbsolutePath('cacheDir', cacheDir),
        databasePath: validateAbsolutePath('databasePath', databasePath),
        llmBaseUrl: validateUrl(llmBaseUrl),
        llmModel: llmModel.trim(),
        allowModelDownloads: programmaticOptions.allowModelDownloads ?? environmentConsent ?? false,
        onDownloadProgress: programmaticOptions.onDownloadProgress
    }
}

// Retrieval tuning and ingestion-only settings remain centralized here. Runtime
// paths and remote configuration are resolved by getOptions() above.
export const config = {
    epubPath: 'docs/GodotEngine.epub',
    book: 'Godot Engine 4.7',
    get dbPath(): string {
        return getOptions().databasePath
    },
    table: 'chunks',
    embedModel: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    rerankModel: 'onnx-community/bge-reranker-v2-m3-ONNX',
    embedDtype: (process.env.RAG_DTYPE ?? 'fp16') as 'q8' | 'fp16' | 'fp32',
    rerankDtype: 'q8' as 'q8' | 'fp16' | 'fp32',
    embedDims: 1024,
    device: (process.env.RAG_DEVICE ?? 'cpu') as 'cpu' | 'cuda' | 'auto',
    embedGgufPath: '.models/gguf/Qwen3-Embedding-0.6B-Q8_0.gguf',
    embedGgufUrl: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf',
    embedImageCuda: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
    embedImageCpu: 'ghcr.io/ggml-org/llama.cpp:server',
    embedPort: 8091,
    rerankGgufPath: '.models/gguf/bge-reranker-v2-m3-Q8_0.gguf',
    rerankGgufUrl: 'https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf',
    rerankPort: 8092,
    rerankUrl: process.env.RAG_RERANK_URL ?? '',
    chunkChars: 1800,
    overlapChars: 240,
    vectorTopK: 20,
    ftsTopK: 10,
    titleTopK: 8,
    rerankKeep: 5,
    rerankThreshold: -4,
    notFoundMessage: "I don't have that information in the Godot documentation.",
    get llmBaseUrl(): string {
        return getOptions().llmBaseUrl
    },
    get llmModel(): string {
        return getOptions().llmModel
    },
    apiPort: 3000
} as const
