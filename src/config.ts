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
    'onDownloadProgress',
    'complete',
    'maxPassages'
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

// Mirrors the consumer-side rule in gofer's rag-retrieve worker: a positive
// integer or nothing. Infinity is rejected here even though it is the internal
// "no ceiling" value — a caller asking for no ceiling omits the option.
function validateOptionalPositiveInteger(name: keyof GoferOptions, value: unknown): void {
    if (value === undefined) return
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
        throw new TypeError(`${name} must be a positive integer`)
}

function environmentPositiveInteger(name: string): number | undefined {
    const value = process.env[name]
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
    return parsed
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

    const complete = values.complete
    if (complete !== undefined && typeof complete !== 'function') throw new TypeError('complete must be a function')

    validateOptionalPositiveInteger('maxPassages', values.maxPassages)
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
    const maxPassages =
        programmaticOptions.maxPassages
        ?? environmentPositiveInteger('GOFER_RAG_MAX_PASSAGES')
        ?? Number.POSITIVE_INFINITY

    if (!llmModel.trim()) throw new Error('llmModel must not be empty')
    return {
        cacheDir: validateAbsolutePath('cacheDir', cacheDir),
        databasePath: validateAbsolutePath('databasePath', databasePath),
        llmBaseUrl: validateUrl(llmBaseUrl),
        llmModel: llmModel.trim(),
        allowModelDownloads: programmaticOptions.allowModelDownloads ?? environmentConsent ?? false,
        onDownloadProgress: programmaticOptions.onDownloadProgress,
        complete: programmaticOptions.complete,
        maxPassages
    }
}

// fp16 is not here on purpose: EmbeddingGemma 2 overflows it (see embedder.ts).
export type EmbedDtype = 'q8' | 'fp32'

// Retrieval tuning and ingestion-only settings remain centralized here. Runtime
// paths and remote configuration are resolved by getOptions() above.
export const config = {
    epubPath: 'docs/GodotEngine.epub',
    book: 'Godot Engine 4.7',
    get dbPath(): string {
        return getOptions().databasePath
    },
    table: 'chunks',
    embedModel: 'onnx-community/embeddinggemma-2-ONNX',
    rerankModel: 'onnx-community/bge-reranker-v2-m3-ONNX',
    prefilterModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
    // Checked where it is used (downloads.embedDtype), not here: a bad value must
    // fail the call that needs the model, not every import of the package.
    embedDtype: process.env.RAG_DTYPE ?? 'q8',
    rerankDtype: 'q8' as 'q8' | 'fp16' | 'fp32',
    prefilterDtype: 'q8' as 'q8' | 'fp16' | 'fp32',
    embedDims: 768,
    device: (process.env.RAG_DEVICE ?? 'cpu') as 'cpu' | 'cuda' | 'auto',
    // Pinned to a commit: ggml-org reconverts its GGUFs automatically, and the
    // stored vectors are only valid against the file that produced them.
    embedGgufPath: '.models/gguf/embeddinggemma-2-Q8_0.gguf',
    embedGgufUrl:
        'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf',
    embedGgufSha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
    // Pinned by digest. llama.cpp b9837 cannot load EmbeddingGemma 2 at all
    // ("unknown model architecture: gemma-embedding2"); b11459 matches the
    // PyTorch reference at cosine ≥ 0.9991. A floating tag would also move the
    // rerank box under a running A/B.
    embedImageCuda:
        'ghcr.io/ggml-org/llama.cpp:server-cuda-b11459@sha256:fff6185edd2fbc4093aa5970bf6db53ed11c283e3a1c52a3e244cf27047264f4',
    embedImageCpu:
        'ghcr.io/ggml-org/llama.cpp:server-b11459@sha256:33868c035b21dc63f7c60b7438774283fd99215bc319114eb03de5df4ce7cd6b',
    rerankImageCuda:
        'ghcr.io/ggml-org/llama.cpp:server-cuda-b11459@sha256:fff6185edd2fbc4093aa5970bf6db53ed11c283e3a1c52a3e244cf27047264f4',
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
    // The floor under the BEST passage in a pool. The -4 threshold above decides
    // which passages are worth showing beside a good one; this decides whether
    // there is a good one at all. Without it an off-corpus question is answered
    // from whatever ranked least badly — "gofer node.set_cells cell parameter
    // atlas source format" (a Gofer tool, not a Godot class) came back as a
    // MultiMeshInstance2D passage at -1.75 after 13 s.
    //
    // -0.5, not 0. Measured over the 83 frozen pools x 3 epochs in
    // scripts/ab-floor.ts, identical in every epoch:
    //
    //   floor      retrieval  paraphrase  fundamentals  realistic  refusals
    //   none (-inf)      8/8       20/22         18/20      25/30       3/5
    //   -0.5             8/8       20/22         18/20      25/30       4/5
    //    0               8/8       19/22         18/20      21/30       4/5
    //
    // Both floors buy the same refusal ("how do i make a discord bot in
    // gdscript", best -0.93). Zero costs five correct answers on top of it:
    // casual questions whose right chapter sits just under zero — Canvas layers
    // at -0.02 for "keep the UI in place while the camera moves", ConfigFile at
    // -0.33 for "save the players high score", Multiple resolutions at -0.46 for
    // "the game window looks tiny". The boundary between "unrelated" and
    // "correct but casually asked" is at -0.5 in this corpus, not at 0.
    //
    // Re-measured 2026-10-07 after the EmbeddingGemma 2 swap, same pinned
    // expansions: -0.5 is still the best row.
    //
    //   floor      retrieval  paraphrase  fundamentals  realistic  refusals
    //   none (-inf)      8/8       20/22         19/20      27/30       2/5
    //   -0.5             8/8       20/22         19/20      26/30       4/5
    //    0               8/8       20/22         18/20      21/30       4/5
    //
    // The new vectors bring "Who won the 2022 FIFA World Cup?" a passage at
    // -3.08, above the -4 threshold, so without a floor it is answered. The
    // answer -0.5 costs, "how big can my game world be before things break",
    // tops out at -2.79. Any floor low enough to keep it lets the discord bait
    // (-0.90) through, and sits within 0.3 of the FIFA one.
    answerFloor: -0.5,
    // Pairs per rerank forward pass. Every pair in a batch is padded to the
    // longest one, so a single 34-pair batch computes 1.38x the tokens it needs
    // (measured over 1091 pairs). Length-sorted batches of 4 cut that to 1.04x.
    rerankBatch: 4,
    // Candidates the cheap prefilter forwards to the real reranker. 10 keeps
    // every eval result identical; 6 starts losing them (see rerank()).
    prefilterKeep: 10,
    notFoundMessage: "I don't have that information in the Godot documentation.",
    get llmBaseUrl(): string {
        return getOptions().llmBaseUrl
    },
    get llmModel(): string {
        return getOptions().llmModel
    },
    apiPort: 3000
} as const
