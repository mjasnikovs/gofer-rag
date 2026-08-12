// How much of what the LLM actually reads is noise?
//
// REDUCE-NOISE.md counts noise over the whole corpus. That is the wrong
// denominator: the LLM never sees the corpus, it sees the ~9000 chars of the
// kept top-5. A category that is 12% of the corpus but never lands in a kept
// set costs nothing; a category that is 1% of the corpus but rides on every
// class-reference page costs on every answer. This measures the real payload.
//
//   bun run scripts/diag-context-noise.ts              summary tables
//   bun run scripts/diag-context-noise.ts --verbose    per-question breakdown
//   bun run scripts/diag-context-noise.ts --prose-free dump every prose-free
//                                                      kept chunk, so the call
//                                                      "table or junk?" is made
//                                                      by reading them, not by
//                                                      trusting the ratio
//
// Runs the production retrieval path (retrieveDetailed), so it wants the
// llama.cpp server up for query expansion. No re-ingest, no corpus change —
// this is a measurement of the CURRENT database.

import * as lancedb from '@lancedb/lancedb'
import {loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieveDetailed} from '../src/core/query'
import {loadTable} from '../src/store/db'
import {config} from '../src/config'
import {cases as fundamentalCases} from './fundamentals-cases'
import {cases as realisticCases} from './realistic-cases'
import type {RankedChunk} from '../src/types'

const verbose = process.argv.includes('--verbose')
const dumpProseFree = process.argv.includes('--prose-free')

const BOILERPLATE =
    /There is currently no description for this [a-z ]+\. Please help us by contributing one \[[^\]]+\]!/g
const BRACKETED_URL = /\[(?:https?|ftp):\/\/[^\]\s]*\]/g
const SECTION_HEADER = /^(?:Description|Tutorials|Properties|Methods|Operators|Constants|Theme Properties|Signals|Enumerations|Constructors|Inherits:.*|Inherited By:.*)$/gm

type Span = {start: number; end: number}
type Category = 'overlapHead' | 'boilerplate' | 'bracketedUrl' | 'sectionHeader' | 'csharpBlock'

const CATEGORIES: Category[] = ['overlapHead', 'boilerplate', 'bracketedUrl', 'sectionHeader', 'csharpBlock']

// csharpBlock is measured but deliberately NOT folded into the union: dropping
// it is a product decision (it makes the corpus wrong for C# questions), not a
// cleanup. The union stays the set that is noise for every reader.
const UNION_CATEGORIES: Category[] = ['overlapHead', 'boilerplate', 'bracketedUrl', 'sectionHeader']

const LANGUAGE_MARKER = /^(?:GDScript|C#|C\+\+|Shader|Text|Output|INI)$/

// Godot docs render one example per language in a tab widget; htmlToText()
// flattens it, so a bare `C#` line is followed by the C# body until the next
// language marker or the next line of real prose. Approximate by construction —
// there is no markup left to key on — so it is reported alone, never summed.
function csharpSpans(text: string): Span[] {
    const spans: Span[] = []
    const lines = text.split('\n')
    let offset = 0
    let start = -1
    for (const line of lines) {
        const trimmed = line.trim()
        const isProse = trimmed.split(/\s+/).length >= 6 && /[.!?]$/.test(trimmed)
        if (start >= 0 && (LANGUAGE_MARKER.test(trimmed) || isProse)) {
            spans.push({start, end: offset})
            start = -1
        }
        if (trimmed === 'C#') start = offset
        offset += line.length + 1
    }
    if (start >= 0) spans.push({start, end: text.length})
    return spans
}

function regexSpans(text: string, pattern: RegExp): Span[] {
    const spans: Span[] = []
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) spans.push({start: match.index, end: match.index + match[0].length})
    return spans
}

// Longest prefix of `text` that is also a suffix of `previous`. That prefix is
// the copy overlapTail() planted at ingest — a mid-sentence fragment the LLM
// reads a second time whenever both chunks are kept, and reads as a garbled
// opening even when only one is.
function overlapHeadLength(previous: string, text: string): number {
    const max = Math.min(300, previous.length, text.length)
    for (let n = max; n > 0; n--) {
        if (previous.endsWith(text.slice(0, n))) return n
    }
    return 0
}

// Under 10% of non-empty lines are sentences (>= 6 words, ending in . ! or ?).
// Property tables and enum dumps, per REDUCE-NOISE.md finding 5.
function isProseFree(text: string): boolean {
    const lines = text.split('\n').filter(line => line.trim().length > 0)
    if (lines.length === 0) return true
    const sentences = lines.filter(line => line.trim().split(/\s+/).length >= 6 && /[.!?]$/.test(line.trim()))
    return sentences.length / lines.length < 0.1
}

function markSpans(mask: Uint8Array, spans: Span[]): void {
    for (const span of spans) {
        for (let i = span.start; i < span.end; i++) mask[i] = 1
    }
}

function maskCount(mask: Uint8Array): number {
    let n = 0
    for (const bit of mask) n += bit
    return n
}

type Totals = {
    questions: number
    keptChunks: number
    contextChars: number
    chunkChars: number
    headerChars: number
    proseFreeChunks: number
    proseFreeChars: number
    sameChapterPairs: number
    byCategory: Record<Category, number>
    unionChars: number
}

function emptyTotals(): Totals {
    return {
        questions: 0,
        keptChunks: 0,
        contextChars: 0,
        chunkChars: 0,
        headerChars: 0,
        proseFreeChunks: 0,
        proseFreeChars: 0,
        sameChapterPairs: 0,
        byCategory: {overlapHead: 0, boilerplate: 0, bracketedUrl: 0, sectionHeader: 0, csharpBlock: 0},
        unionChars: 0
    }
}

type AccumulateOptions = {
    predecessorOf: Map<string, string>
    question: string
    // accumulate() runs twice per question (per-set and overall); only the
    // first pass may print, or every dumped chunk appears twice.
    dump: boolean
}

function accumulate(totals: Totals, kept: RankedChunk[], options: AccumulateOptions): Totals {
    const {predecessorOf} = options
    totals.questions++
    totals.keptChunks += kept.length
    // Exactly the string query() hands the answer LLM.
    const context = kept.map((chunk, i) => `[${i + 1}] (${chunk.chapter})\n${chunk.text}`).join('\n\n')
    totals.contextChars += context.length
    totals.chunkChars += kept.reduce((a, c) => a + c.text.length, 0)
    totals.headerChars += context.length - kept.reduce((a, c) => a + c.text.length, 0)

    const chapters = kept.map(c => c.chapter)
    totals.sameChapterPairs += chapters.length - new Set(chapters).size

    for (const [rank, chunk] of kept.entries()) {
        const text = chunk.text
        const mask = new Uint8Array(text.length)
        const previous = predecessorOf.get(chunk.id)
        const spansByCategory: Record<Category, Span[]> = {
            overlapHead: previous ? [{start: 0, end: overlapHeadLength(previous, text)}] : [],
            boilerplate: regexSpans(text, BOILERPLATE),
            bracketedUrl: regexSpans(text, BRACKETED_URL),
            sectionHeader: regexSpans(text, SECTION_HEADER),
            csharpBlock: csharpSpans(text)
        }
        for (const category of CATEGORIES) {
            for (const span of spansByCategory[category]) totals.byCategory[category] += span.end - span.start
        }
        for (const category of UNION_CATEGORIES) markSpans(mask, spansByCategory[category])
        totals.unionChars += maskCount(mask)
        if (isProseFree(text)) {
            totals.proseFreeChunks++
            totals.proseFreeChars += text.length
            if (options.dump) {
                const preview = text.slice(0, 220).replace(/\n/g, ' / ')
                console.log(`\n  rank ${rank + 1}  ${text.length} chars  [${chunk.chapter}]  ${chunk.id}`)
                console.log(`  Q: ${options.question}`)
                console.log(`  > ${preview}`)
            }
        }
    }
    return totals
}

function percent(part: number, whole: number): string {
    return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(2)}%`
}

function printTotals(label: string, totals: Totals): void {
    const {contextChars} = totals
    console.log(`\n=== ${label} ===`)
    console.log(`questions ${totals.questions}  kept chunks ${totals.keptChunks}  context chars ${contextChars}`)
    console.log(`avg context ${Math.round(contextChars / Math.max(1, totals.questions))} chars per answer`)
    console.log(`citation headers  ${String(totals.headerChars).padStart(8)}  ${percent(totals.headerChars, contextChars)}`)
    for (const category of CATEGORIES) {
        const chars = totals.byCategory[category]
        console.log(`${category.padEnd(17)} ${String(chars).padStart(8)}  ${percent(chars, contextChars)}`)
    }
    console.log(`UNION (safe set)  ${String(totals.unionChars).padStart(8)}  ${percent(totals.unionChars, contextChars)}`)
    console.log(
        `prose-free chunks ${totals.proseFreeChunks}/${totals.keptChunks} ` +
            `(${totals.proseFreeChars} chars, ${percent(totals.proseFreeChars, contextChars)})`
    )
    console.log(`kept sets holding 2+ chunks of one chapter: ${totals.sameChapterPairs} extra chunks`)
}

await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

// Predecessor text per chunk id, so a kept chunk's copied head can be measured.
const db = await lancedb.connect(config.dbPath)
const table = await db.openTable(config.table)
const rows = (await table.query().select(['id', 'text']).toArray()) as {id: string; text: string}[]
const byId = new Map(rows.map(row => [row.id, row.text]))
const predecessorOf = new Map<string, string>()
for (const row of rows) {
    const [order, index] = row.id.split('-').map(Number)
    if (!index) continue
    const previous = byId.get(`${order}-${index - 1}`)
    if (previous) predecessorOf.set(row.id, previous)
}
console.log(`corpus ${rows.length} chunks, ${predecessorOf.size} with a predecessor`)

const sets: {label: string; questions: string[]}[] = [
    {label: 'fundamentals', questions: fundamentalCases.map(c => c.question)},
    {label: 'realistic', questions: realisticCases.filter(c => c.expect).map(c => c.question)}
]

const overall = emptyTotals()
for (const set of sets) {
    const totals = emptyTotals()
    for (const question of set.questions) {
        const {kept} = await retrieveDetailed(question)
        if (kept.length === 0) {
            if (verbose) console.log(`  [refused] ${question}`)
            continue
        }
        accumulate(totals, kept, {predecessorOf, question, dump: dumpProseFree})
        accumulate(overall, kept, {predecessorOf, question, dump: false})
        if (verbose) {
            const chars = kept.reduce((a, c) => a + c.text.length, 0)
            console.log(`  ${String(chars).padStart(5)} chars  ${kept.map(k => k.chapter).join(' | ')}`)
            console.log(`         ${question}`)
        }
    }
    printTotals(set.label, totals)
}
printTotals('ALL', overall)
process.exit(0)
