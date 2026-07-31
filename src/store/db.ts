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
export const distinctiveTitle = (t: string) => /\d/.test(t) || (t.match(/[A-Z]/g) ?? []).length >= 2

// Chapter titles that appear verbatim in the question. Also the pipeline's
// "does this question name a Godot symbol?" test: no match means casual
// phrasing, which is when retrieve() reaches for LLM query expansion.
export async function matchedTitles(question: string): Promise<string[]> {
    return (await chapterList()).filter(t =>
        new RegExp(`\\b${escapeRegex(t)}\\b`, distinctiveTitle(t) ? 'i' : '').test(question)
    )
}

// Near-title matching: the question names a chapter without quoting its title
// verbatim — "how do i export my game to andriod" is a stem and a transposed
// letter away from "Exporting for Android", which BM25 can't see (the typo
// indexes nothing and corpus-wide "export android" loses to Resolving-crashes /
// Compiling-for-Android chunks — measured 2026-07-14, even with the typo
// fixed). A title fires only when EVERY non-stopword token is covered by some
// question token and it has ≥2 such tokens. Looser rules were probed first and
// matched junk: coverage fractions pulled "Step by step" from "stop" and
// FastNoiseLite from "fast"; single-token titles are excluded for the same
// reason (Export, Android, int). Under this rule the andriod question matches
// exactly one title and the pizza/unity off-topic probes match none.
const NEAR_STOPWORDS = new Set(
    'a an and are as at be by can do does for how i in is it my of on or the to what whats when where which why with'.split(
        ' '
    )
)
const nearTokens = (s: string): string[] =>
    (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(t => !NEAR_STOPWORDS.has(t))

// Damerau-Levenshtein (adjacent transposition counts 1, so andriod→android is
// distance 1). Tokens are short; callers gate by length before paying O(mn).
export function editDistance(a: string, b: string): number {
    const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array<number>(b.length).fill(0)])
    for (let j = 0; j <= b.length; j++) d[0]![j] = j
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + cost)
        }
    return d[a.length]![b.length]!
}

// Token coverage: exact, one a ≥4-char prefix of the other (export/exporting —
// crude stemming), or one edit apart on ≥6-char tokens (typos; 4-char words
// are one edit from each other constantly — stop/step).
export const coversToken = (q: string, t: string): boolean =>
    q === t
    || (q.length >= 4 && t.length >= 4 && (q.startsWith(t) || t.startsWith(q)))
    || (q.length >= 6 && t.length >= 6 && Math.abs(q.length - t.length) <= 1 && editDistance(q, t) <= 1)

export async function nearTitles(question: string): Promise<string[]> {
    const qTokens = nearTokens(question)
    if (qTokens.length === 0) return []
    return (await chapterList()).filter(title => {
        const tTokens = nearTokens(title)
        return tTokens.length >= 2 && tTokens.every(t => qTokens.some(q => coversToken(q, t)))
    })
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
    // Longest titles are the most specific mentions; cap so a title-heavy
    // question can't flood the reranker. Near-title matches (fuzzy, see
    // nearTitles) ride along after the verbatim ones with their own smaller
    // cap: they never displace a named chapter, only add candidates the
    // reranker judges ("Exporting for Android" enters at rerank rank 1, score
    // 2.03, for the andriod-typo question — measured 2026-07-14). They do NOT
    // count as matchedTitles: expansion gating and the title pin stay
    // verbatim-only.
    const named = titles.sort((a, b) => b.length - a.length).slice(0, 3)
    const near = (await nearTitles(question))
        .filter(t => !named.includes(t))
        .sort((a, b) => b.length - a.length)
        .slice(0, 2)
    const chapters = [...named, ...near]
    if (chapters.length === 0) return []
    const where = `chapter IN (${chapters.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')})`
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
