// `bun run scripts/sft-rewrite.ts [--variants 10] [--limit N] [--concurrency 2]`
// Fact-injection proof, arm B: every cpt_pilot chunk rewritten N ways by Qwen.
// Each variant has its own style so the facts show up in different wording.
// Rows in table rewrites (chunk_id, variant, text). Resumable. Failures in
// rewrite_failures. Export with sft-rewrite-export.ts.

import {Database} from 'bun:sqlite'
import {z} from 'zod'

const DB = 'data/sft/sft.sqlite'
const BASE = process.env.GOFER_RAG_LLM_BASE_URL ?? 'http://localhost:8080/v1'
const argument = (name: string, fallback: number) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? fallback : Number(process.argv[i + 1])
}
const variants = argument('--variants', 10)
const limit = argument('--limit', 0)
const concurrency = argument('--concurrency', 2)

const STYLES = [
    'Rewrite it as a short tutorial for a beginner.',
    'Rewrite it as a list of short factual bullet points.',
    'Rewrite it as three to six question and answer pairs.',
    'Rewrite it as a dense reference entry, like an API manual.',
    'Rewrite it as a forum answer to someone asking how this works.',
    'Rewrite it as plain prose in your own words, no lists.',
    'Rewrite it as a set of "note that" statements, one fact each.',
    'Rewrite it as a code comment block with GDScript examples where the passage gives any.',
    'Rewrite it as a summary a teacher would say out loud in class.',
    'Rewrite it as a checklist of things a developer must know from this passage.'
]

const SYSTEM = `You rewrite Godot Engine 4 documentation passages.
Keep every fact, class, method, property, signal, constant, number and default value exactly as in the passage.
Add nothing that the passage does not say. Do not drop facts.
Return only the rewritten text, no preamble.`

const Row = z.string().trim().min(100)
type Chunk = {id: number; chapter: string; text: string}
type Chat = {choices: {message: {content: string}}[]}
type Job = {chunk: Chunk; variant: number}

const db = new Database(DB)
db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rewrites (
        chunk_id INTEGER NOT NULL REFERENCES chunks(id), variant INTEGER NOT NULL, text TEXT NOT NULL,
        model TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (chunk_id, variant)
    );
    CREATE TABLE IF NOT EXISTS rewrite_failures (
        chunk_id INTEGER NOT NULL, variant INTEGER NOT NULL, error TEXT NOT NULL, created_at TEXT NOT NULL
    );
`)

const chunks = db
    .prepare('SELECT id, chapter, text FROM chunks WHERE chapter IN (SELECT chapter FROM cpt_pilot) ORDER BY id')
    .all() as Chunk[]
const done = new Set(
    (db.prepare('SELECT chunk_id, variant FROM rewrites').all() as {chunk_id: number; variant: number}[]).map(
        r => `${r.chunk_id}:${r.variant}`
    )
)
let jobs: Job[] = []
for (const chunk of chunks)
    for (let variant = 0; variant < variants; variant++)
        if (!done.has(`${chunk.id}:${variant}`)) jobs.push({chunk, variant})
if (limit) jobs = jobs.slice(0, limit)

const modelId = async () => ((await (await fetch(`${BASE}/models`)).json()) as {data: {id: string}[]}).data[0]!.id
const model = await modelId()
console.log(`model ${model}  chunks ${chunks.length}  variants ${variants}  todo ${jobs.length}`)

const insert = db.prepare('INSERT INTO rewrites (chunk_id, variant, text, model, created_at) VALUES (?, ?, ?, ?, ?)')
const insertFailure = db.prepare(
    'INSERT INTO rewrite_failures (chunk_id, variant, error, created_at) VALUES (?, ?, ?, ?)'
)

async function rewrite({chunk, variant}: Job): Promise<void> {
    const style = STYLES[variant % STYLES.length]!
    const user = `Chapter: ${chunk.chapter}\n\nPassage:\n${chunk.text}\n\n${style}`.toWellFormed()
    try {
        const response = await fetch(`${BASE}/chat/completions`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                messages: [
                    {role: 'system', content: SYSTEM},
                    {role: 'user', content: user}
                ],
                temperature: 0.7,
                chat_template_kwargs: {enable_thinking: false}
            })
        })
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
        const text = Row.parse(((await response.json()) as Chat).choices[0]!.message.content)
        insert.run(chunk.id, variant, text, model, new Date().toISOString())
    } catch (error) {
        insertFailure.run(chunk.id, variant, (error as Error).message.slice(0, 500), new Date().toISOString())
        console.error(`fail ${chunk.id}/${variant}: ${(error as Error).message.slice(0, 200)}`)
    }
}

let index = 0
let n = 0
const started = Date.now()
const worker = async () => {
    while (index < jobs.length) {
        const job = jobs[index++]
        if (!job) break
        await rewrite(job)
        n++
        if (n % 50 === 0 || n === jobs.length) {
            const per = (Date.now() - started) / n / 1000
            console.log(
                `rewrite ${n}/${jobs.length}  ${per.toFixed(1)}s each  eta ${(((jobs.length - n) * per) / 60).toFixed(0)} min`
            )
        }
    }
}
await Promise.all(Array.from({length: concurrency}, worker))
