// `bun run scripts/sft-generate.ts [--limit N] [--concurrency N]`
// Asks the local LLM for 3 Q/A pairs per stored chunk and writes them to
// data/sft/sft.sqlite. Every LLM reply is validated with zod before it is stored.
// Resumable: chunks with a row in `chunks` are skipped.

import {Database} from 'bun:sqlite'
import * as lancedb from '@lancedb/lancedb'
import {z} from 'zod'
import {config, getOptions} from '../src/config'
import type {StoredChunk} from '../src/types'

const DB = 'data/sft/sft.sqlite'
const BASE = process.env.GOFER_RAG_LLM_BASE_URL ?? 'http://localhost:8080/v1'
const MIN_CHARS = 200

const argument = (name: string, fallback: number) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? fallback : Number(process.argv[i + 1])
}
const limit = argument('--limit', Infinity)
const concurrency = argument('--concurrency', 2)

const PairSchema = z.object({
    question: z
        .string()
        .trim()
        .min(15)
        .max(400)
        .refine(q => q.endsWith('?'), 'question must end with ?'),
    answer: z.string().trim().min(30).max(2000)
})
const Reply = z.object({pairs: z.array(PairSchema).length(3)})
type Pair = z.infer<typeof PairSchema>

const SYSTEM = `You write training data for a Godot Engine 4 assistant.
Given one passage from the Godot documentation, write 3 question/answer pairs.
Rules:
- Each question must stand alone. Name the class, node, method or feature. Never say "this", "the passage" or "the text".
- Vary the style: one short factual question, one "how do I ..." question, one about behaviour, pitfalls or when to use it.
- The "Before" block is the end of the previous passage. Use it only to resolve names the passage refers to. Do not write questions about it.
- Answers must come only from the passage. Do not invent APIs. If code is relevant, include a short GDScript snippet from or consistent with the passage.
- Answers are 2 to 6 sentences, direct, no preamble.
Return JSON only.`

const schema = {
    type: 'object',
    properties: {
        pairs: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
                type: 'object',
                properties: {question: {type: 'string'}, answer: {type: 'string'}},
                required: ['question', 'answer']
            }
        }
    },
    required: ['pairs']
}

async function generate(chunk: StoredChunk, before: string): Promise<{pairs: Pair[]; raw: string}> {
    const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            messages: [
                {role: 'system', content: SYSTEM},
                {
                    role: 'user',
                    content:
                        `Chapter: ${chunk.chapter}\n\nBefore:\n${before || '(start of chapter)'}\n\nPassage:\n${chunk.text}`.toWellFormed()
                }
            ],
            temperature: 0.7,
            chat_template_kwargs: {enable_thinking: false},
            response_format: {type: 'json_schema', json_schema: {name: 'pairs', schema}}
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = (await response.json()) as {choices: {message: {content: string}}[]}
    const raw = body.choices[0]!.message.content
    return {pairs: Reply.parse(JSON.parse(raw)).pairs, raw}
}

const db = new Database(DB, {create: true})
db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, chapter TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL,
        before TEXT NOT NULL, raw TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairs (
        id INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL REFERENCES chunks(id), n INTEGER NOT NULL,
        question TEXT NOT NULL, answer TEXT NOT NULL, UNIQUE (chunk_id, n)
    );
    CREATE TABLE IF NOT EXISTS failures (
        chunk_id TEXT NOT NULL, error TEXT NOT NULL, raw TEXT, created_at TEXT NOT NULL
    );
`)
const insertChunk = db.prepare(
    'INSERT INTO chunks (id, chapter, ord, text, before, raw, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
)
const insertPair = db.prepare('INSERT INTO pairs (chunk_id, n, question, answer) VALUES (?, ?, ?, ?)')
const insertFailure = db.prepare('INSERT INTO failures (chunk_id, error, raw, created_at) VALUES (?, ?, ?, ?)')
const store = db.transaction((chunk: StoredChunk, before: string, raw: string, pairs: Pair[]) => {
    insertChunk.run(chunk.id, chunk.chapter, chunk.order, chunk.text, before, raw, MODEL, new Date().toISOString())
    pairs.forEach((p, n) => insertPair.run(chunk.id, n, p.question, p.answer))
})

const modelsResponse = await fetch(`${BASE}/models`)
const MODEL = ((await modelsResponse.json()) as {data: {id: string}[]}).data[0]!.id
const done = new Set((db.prepare('SELECT id FROM chunks').all() as {id: string}[]).map(r => r.id))

const lance = await lancedb.connect(getOptions().databasePath)
const table = await lance.openTable(config.table)
const all = (await table.query().select(['id', 'chapter', 'order', 'text']).toArray()) as StoredChunk[]
const byId = new Map(all.map(c => [c.id, c]))
const previousTail = (c: StoredChunk) =>
    byId.get(c.id.replace(/-(\d+)$/, (_, n) => `-${Number(n) - 1}`))?.text.slice(-600) ?? ''
// Seeded shuffle so a --limit pilot samples the whole corpus, not LanceDB's row order.
const hash = (s: string) => {
    let h = 2166136261
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    return h >>> 0
}
const todo = all
    .filter(c => !done.has(c.id) && c.text.length >= MIN_CHARS)
    .sort((a, b) => hash(a.id) - hash(b.id))
    .slice(0, limit)
console.log(`model ${MODEL}\nchunks: ${all.length} total, ${done.size} done, ${todo.length} to do`)

let index = 0
let finished = 0
let failed = 0
const started = Date.now()

async function worker(): Promise<void> {
    while (index < todo.length) {
        const chunk = todo[index++]
        if (!chunk) break
        const before = previousTail(chunk)
        let raw: string | null = null
        try {
            const result = await generate(chunk, before)
            raw = result.raw
            store(chunk, before, raw, result.pairs)
            finished++
        } catch (error) {
            failed++
            const message = (error as Error).message
            insertFailure.run(chunk.id, message, raw, new Date().toISOString())
            console.error(`fail ${chunk.id}: ${message.slice(0, 200)}`)
        }
        const n = finished + failed
        if (n % 20 === 0 || n === todo.length) {
            const perChunk = (Date.now() - started) / n / 1000
            const eta = ((todo.length - n) * perChunk) / 60
            console.log(
                `${n}/${todo.length}  ${perChunk.toFixed(1)}s/chunk  eta ${eta.toFixed(0)} min  failed ${failed}`
            )
        }
    }
}

await Promise.all(Array.from({length: concurrency}, worker))
console.log(`done. ${finished} chunks, ${failed} failed -> ${DB}`)
