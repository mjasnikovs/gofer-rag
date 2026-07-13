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

export type QueryResult = {
    found: boolean
    answer?: string
    message?: string
    sources?: Source[]
}
