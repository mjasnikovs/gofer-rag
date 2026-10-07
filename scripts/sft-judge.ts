// `bun run scripts/sft-judge.ts [--concurrency N]`
// Checks every generated answer against its passage. A pair is kept only when
// every claim in the answer is supported by the passage (plus the "before" tail).
// Verdicts go to table `verdicts` in data/sft/sft.sqlite. Resumable.

import {Database} from 'bun:sqlite'
import {z} from 'zod'

const DB = 'data/sft/sft.sqlite'
const BASE = process.env.GOFER_RAG_LLM_BASE_URL ?? 'http://localhost:8080/v1'

const argument = (name: string, fallback: number) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? fallback : Number(process.argv[i + 1])
}
const concurrency = argument('--concurrency', 2)

const VerdictSchema = z.object({
    unsupported_claims: z.array(z.string().trim().min(1)),
    supported: z.boolean()
})
type Verdict = z.infer<typeof VerdictSchema>

type Row = {
    id: number
    chunk_id: string
    chapter: string
    text: string
    before: string
    question: string
    answer: string
}

const SYSTEM = `You are a fact checker for Godot Engine documentation.
You get a documentation passage, the tail of the previous passage, a question and an answer.
List every claim in the answer that the passage does not support.
Unsupported means one of:
- it contradicts the passage,
- it names a class, method, property, signal, constant, node or setting that is not in the passage or the previous tail,
- it states a number, default value, type, or behaviour the passage does not state,
- code calls an API that the passage does not mention.
Supported means: a paraphrase of the passage, a rewording, an obvious direct consequence of what the passage says, or general GDScript syntax. Do not flag these.
Set "supported" to true only when the list is empty.
Return JSON only.`

const schema = {
    type: 'object',
    properties: {
        unsupported_claims: {type: 'array', items: {type: 'string'}},
        supported: {type: 'boolean'}
    },
    required: ['unsupported_claims', 'supported']
}

async function judge(row: Row): Promise<{verdict: Verdict; raw: string}> {
    const user =
        `Chapter: ${row.chapter}\n\nBefore:\n${row.before || '(start of chapter)'}\n\nPassage:\n${row.text}\n\nQuestion: ${row.question}\n\nAnswer:\n${row.answer}`.toWellFormed()
    const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            messages: [
                {role: 'system', content: SYSTEM},
                {role: 'user', content: user}
            ],
            temperature: 0,
            chat_template_kwargs: {enable_thinking: false},
            response_format: {type: 'json_schema', json_schema: {name: 'verdict', schema}}
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = (await response.json()) as {choices: {message: {content: string}}[]}
    const raw = body.choices[0]!.message.content
    return {verdict: VerdictSchema.parse(JSON.parse(raw)), raw}
}

const db = new Database(DB)
db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS verdicts (
        pair_id INTEGER PRIMARY KEY REFERENCES pairs(id), supported INTEGER NOT NULL,
        reasons TEXT NOT NULL, raw TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS judge_failures (
        pair_id INTEGER NOT NULL, error TEXT NOT NULL, raw TEXT, created_at TEXT NOT NULL
    );
`)
const insertVerdict = db.prepare(
    'INSERT INTO verdicts (pair_id, supported, reasons, raw, model, created_at) VALUES (?, ?, ?, ?, ?, ?)'
)
const insertFailure = db.prepare('INSERT INTO judge_failures (pair_id, error, raw, created_at) VALUES (?, ?, ?, ?)')

const MODEL = ((await (await fetch(`${BASE}/models`)).json()) as {data: {id: string}[]}).data[0]!.id
const todo = db
    .prepare(
        `SELECT p.id, p.chunk_id, c.chapter, c.text, c.before, p.question, p.answer
         FROM pairs p JOIN chunks c ON c.id = p.chunk_id
         WHERE p.id NOT IN (SELECT pair_id FROM verdicts) ORDER BY p.id`
    )
    .all() as Row[]
console.log(`model ${MODEL}\npairs to judge: ${todo.length}`)

let index = 0
let done = 0
let failed = 0
let dropped = 0
const started = Date.now()

async function worker(): Promise<void> {
    while (index < todo.length) {
        const row = todo[index++]
        if (!row) break
        let raw: string | null = null
        try {
            const result = await judge(row)
            raw = result.raw
            const {verdict} = result
            insertVerdict.run(
                row.id,
                verdict.supported ? 1 : 0,
                JSON.stringify(verdict.unsupported_claims),
                raw,
                MODEL,
                new Date().toISOString()
            )
            done++
            if (!verdict.supported) dropped++
        } catch (error) {
            failed++
            const message = (error as Error).message
            insertFailure.run(row.id, message, raw, new Date().toISOString())
            console.error(`fail pair ${row.id}: ${message.slice(0, 200)}`)
        }
        const n = done + failed
        if (n % 30 === 0 || n === todo.length) {
            const per = (Date.now() - started) / n / 1000
            console.log(
                `${n}/${todo.length}  ${per.toFixed(1)}s/pair  eta ${(((todo.length - n) * per) / 60).toFixed(0)} min  dropped ${dropped}  failed ${failed}`
            )
        }
    }
}

await Promise.all(Array.from({length: concurrency}, worker))
console.log(`done. judged ${done}, dropped ${dropped}, failed ${failed}`)
