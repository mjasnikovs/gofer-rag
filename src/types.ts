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

// `pinned` marks a chunk the title pin rescued rather than one the score kept.
// A pin always scores below every score-kept chunk (a named chapter is exempt
// from the chapter cap, so the only way out of the kept set is a lower score),
// which means it always sorts last — and a consumer that truncates the array
// cuts the rescue first. The flag is how a caller that must truncate can tell
// the two apart; `maxPassages` is how it avoids truncating at all.
export type RankedChunk = StoredChunk & {score: number; pinned?: true}

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
    // Hard ceiling on returned passages, title pins included. Unset means no
    // ceiling, which is the historical behaviour. Prefer this over slicing the
    // returned array: the cut is applied before pinning, so the rescue survives.
    maxPassages?: number
}

export type ResolvedGoferOptions = Required<Omit<GoferOptions, 'onDownloadProgress' | 'complete'>>
    & Pick<GoferOptions, 'onDownloadProgress' | 'complete'>
