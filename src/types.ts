// Shared domain types for the Godot docs RAG pipeline.

export type Chapter = {
    title: string
    href: string
    order: number
    text: string
}

export type Chunk = {
    id: string
    chapter: string
    order: number
    chunkIndex: number
    text: string
}

export type StoredChunk = {
    id: string
    vector: number[]
    text: string
    chapter: string
    order: number
}

export type RankedChunk = StoredChunk & {score: number}

export type Source = {
    chapter: string
    order: number
    score: number
}

export type QuerySuccess = {
    found: true
    answer: string
    sources: Source[]
}

export type QueryNotFound = {
    found: false
    message: string
}

export type QueryResult = QuerySuccess | QueryNotFound

export type ModelDownload = {
    name: string
    source: string
    destination: string
    expectedBytes: number
}

export type DownloadProgress = {
    model: string
    file?: string
    status: string
    loaded?: number
    total?: number
    progress?: number
}

export type ModelDownloadConsent = (models: ModelDownload[]) => boolean | Promise<boolean>

export type LlmCompletionRequest = {
    system: string
    user: string
    maxTokens: number
}

// A host-supplied chat completion, so a consumer that already has a configured
// model connection does not have to duplicate its URL, credentials and
// reasoning settings here. It replaces the connection, not the judgment: the
// prompts, the term-list guard and the decision of when to expand at all stay
// in this package. Return the assistant's text with any thinking/reasoning
// already removed — only the host knows its provider's dialect.
export type LlmComplete = (request: LlmCompletionRequest) => Promise<string>

export type GoferOptions = {
    cacheDir?: string
    databasePath?: string
    llmBaseUrl?: string
    llmModel?: string
    allowModelDownloads?: boolean | ModelDownloadConsent
    onDownloadProgress?: (progress: DownloadProgress) => void
    complete?: LlmComplete
}

export type ResolvedGoferOptions = Required<Omit<GoferOptions, 'onDownloadProgress' | 'complete'>>
    & Pick<GoferOptions, 'onDownloadProgress' | 'complete'>
