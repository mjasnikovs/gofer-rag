import {configure} from './config.js'
import {query as queryCore, retrieve as retrieveCore, warmup as warmupCore} from './core/query.js'
import {authorizeModelDownloads} from './ai/downloads.js'
import type {GoferOptions, QueryResult, RankedChunk} from './types.js'

export type {
    DownloadProgress,
    GoferOptions,
    ModelDownload,
    ModelDownloadConsent,
    QueryResult,
    RankedChunk,
    Source
} from './types.js'

export async function retrieve(question: string, options: GoferOptions = {}): Promise<RankedChunk[]> {
    const normalized = validateQuestion(question)
    configure(options)
    await authorizeModelDownloads(['embedder', 'reranker'])
    return retrieveCore(normalized)
}

export async function query(question: string, options: GoferOptions = {}): Promise<QueryResult> {
    const normalized = validateQuestion(question)
    configure(options)
    await authorizeModelDownloads(['embedder', 'reranker'])
    return queryCore(normalized)
}

export async function warmup(options: GoferOptions = {}): Promise<void> {
    configure(options)
    await authorizeModelDownloads(['embedder', 'reranker'])
    await warmupCore()
}

function validateQuestion(question: string): string {
    const normalized = question.trim()
    if (!normalized) throw new Error('question must not be empty')
    return normalized
}
