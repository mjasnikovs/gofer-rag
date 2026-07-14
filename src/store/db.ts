// LanceDB access. rag-update rebuilds the table from scratch; serve reads from it.
// The open table is cached so we don't reconnect on every query.

import * as lancedb from '@lancedb/lancedb'
import {config} from '../config'
import type {StoredChunk} from '../types'

let cachedTable: lancedb.Table | null = null

async function connect(): Promise<lancedb.Connection> {
    return lancedb.connect(config.dbPath)
}

// Drop any existing table and recreate it from the given rows (fresh ingest).
// The FTS index makes exact-token lookups (class names like NavigationAgent2D)
// findable even when embedding similarity misses them entirely.
export async function recreateTable(rows: StoredChunk[]): Promise<void> {
    const db = await connect()
    const names = await db.tableNames()
    if (names.includes(config.table)) await db.dropTable(config.table)
    const table = await db.createTable(config.table, rows)
    await table.createIndex('text', {config: lancedb.Index.fts()})
    cachedTable = null
}

async function getTable(): Promise<lancedb.Table> {
    if (!cachedTable) {
        const db = await connect()
        cachedTable = await db.openTable(config.table)
    }
    return cachedTable
}

export async function loadTable(): Promise<void> {
    await getTable()
}

export async function vectorSearch(vector: number[], k: number): Promise<StoredChunk[]> {
    const table = await getTable()
    const results = await table.search(vector).limit(k).toArray()
    return results as StoredChunk[]
}

// BM25 full-text candidates. LanceDB tokenizes the question itself, so the raw
// text goes in as-is; a question with no indexed tokens just returns [].
export async function ftsSearch(text: string, k: number): Promise<StoredChunk[]> {
    const table = await getTable()
    const results = await table.search(text, 'fts').limit(k).toArray()
    return results as StoredChunk[]
}

let cachedChapters: string[] | null = null
async function chapterList(): Promise<string[]> {
    if (!cachedChapters) {
        const table = await getTable()
        const rows = (await table.query().select(['chapter']).toArray()) as {chapter: string}[]
        cachedChapters = [...new Set(rows.map(r => r.chapter))]
    }
    return cachedChapters
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Distinctive titles — a digit or two capital humps (Sprite2D, AnimationPlayer)
// — can't be mistaken for English prose, so they match case-insensitively and
// lowercase questions ("what is sprite2d used for?") still find their chapter.
// Single-hump titles are mostly real words (66 of 84 are in the dictionary —
// Tree, Control, Timer, Range ...) and blanket case-insensitivity pulled them
// into 7 of 12 natural test sentences AND into every "...property of X control?"
// eval template (measured 2026-07-13), so those stay case-sensitive.
const distinctiveTitle = (t: string) => /\d/.test(t) || (t.match(/[A-Z]/g) ?? []).length >= 2

// Chapter titles that appear verbatim in the question. Also the pipeline's
// "does this question name a Godot symbol?" test: no match means casual
// phrasing, which is when retrieve() reaches for LLM query expansion.
export async function matchedTitles(question: string): Promise<string[]> {
    return (await chapterList()).filter(t =>
        new RegExp(`\\b${escapeRegex(t)}\\b`, distinctiveTitle(t) ? 'i' : '').test(question)
    )
}

// snake_case / ALL_CAPS tokens are member names under Godot's uniform naming
// (optional leading underscore: virtual methods are _named_like_this). Shared
// by titleSearch's symbol lookup and retrieveDetailed's title pin so the two
// can't drift on what counts as a symbol.
export const symbolTokens = (text: string): string[] =>
    text.match(/\b_?[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []

// Chapter titles are Godot symbol names (Sprite2D, AnimationPlayer, ...), so a
// title appearing verbatim in the question is a direct pointer to its chapter.
// Corpus-wide BM25 can't follow it — common classes like Sprite2D are mentioned
// in 169 chunks and the class page ranks ~66th for its own name (measured) —
// so this searches within just the named chapters instead.
export async function titleSearch(question: string, k: number): Promise<StoredChunk[]> {
    const titles = await matchedTitles(question)
    if (titles.length === 0) return []
    // Longest titles are the most specific mentions; cap so a title-heavy
    // question can't flood the reranker.
    const named = titles.sort((a, b) => b.length - a.length).slice(0, 3)
    const where = `chapter IN (${named.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')})`
    const table = await getTable()
    const ftsHits = (await table.search(question, 'fts').where(where).limit(k).toArray()) as StoredChunk[]

    // Symbol lookup: within the named chapters a chunk containing a member
    // name verbatim is near-certainly the target. Within-chapter BM25 alone
    // misses these in huge classes (RenderingServer, Node, TextEdit): member
    // names tokenize into common words like "get". Only [a-z0-9_] tokens reach
    // the LIKE clause, so interpolation is safe.
    const symbols = symbolTokens(question)
    const symbolHits =
        symbols.length === 0 ?
            []
        :   ((await table
                .query()
                .where(`${where} AND (${symbols.map(s => `text LIKE '%${s}%'`).join(' OR ')})`)
                .limit(4)
                .toArray()) as StoredChunk[])

    // FTS can come up empty even for a named chapter: the tokenizer never
    // indexes tokens over 40 chars (VisualShaderNodeTextureParameterTriplanar
    // is 41 — measured 0 corpus-wide FTS hits), and a short chapter may share
    // no other indexed token with the question. The chapter was still named
    // explicitly, so fall back to its chunks directly; the reranker judges.
    const plain = ftsHits.length >= k ? [] : ((await table.query().where(where).limit(k).toArray()) as StoredChunk[])

    return [...new Map([...ftsHits, ...symbolHits, ...plain].map(c => [c.id, c])).values()].slice(0, k + 4)
}
