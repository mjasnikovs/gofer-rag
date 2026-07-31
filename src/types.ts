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

export type GoferOptions = {
    cacheDir?: string
    databasePath?: string
    llmBaseUrl?: string
    llmModel?: string
    allowModelDownloads?: boolean | ModelDownloadConsent
    onDownloadProgress?: (progress: DownloadProgress) => void
}

export type ResolvedGoferOptions = Required<Omit<GoferOptions, 'onDownloadProgress'>>
    & Pick<GoferOptions, 'onDownloadProgress'>
