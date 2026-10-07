import {configure} from './config.js'
import {query as queryCore, retrieve as retrieveCore, warmup as warmupCore} from './core/query.js'
import {authorizeModelDownloads} from './ai/downloads.js'
import type {GoferOptions, QueryResult, RankedChunk} from './types.js'

export type {
    DownloadProgress,
    GoferOptions,
    LlmComplete,
    LlmCompletionRequest,
    ModelDownload,
    ModelDownloadConsent,
    QueryNotFound,
    QueryResult,
    QuerySuccess,
    RankedChunk,
    Source
} from './types.js'

// Thrown when the database was embedded by a different model or document format
// than this package queries with. Rebuild or replace the database; a retry
// cannot succeed.
export {EmbedderMismatchError} from './store/db.js'

export async function retrieve(question: string, options: GoferOptions = {}): Promise<RankedChunk[]> {
    const normalized = validateQuestion(question)
    configure(options)
    await authorizeModelDownloads(['embedder', 'reranker', 'prefilter'])
    return retrieveCore(normalized)
}

export async function query(question: string, options: GoferOptions = {}): Promise<QueryResult> {
    const normalized = validateQuestion(question)
    configure(options)
    await authorizeModelDownloads(['embedder', 'reranker', 'prefilter'])
    return queryCore(normalized)
}

export async function warmup(options: GoferOptions = {}): Promise<void> {
    configure(options)
    await authorizeModelDownloads(['embedder', 'reranker', 'prefilter'])
    await warmupCore()
}

function validateQuestion(question: string): string {
    const normalized = question.trim()
    if (!normalized) throw new Error('question must not be empty')
    return normalized
}
