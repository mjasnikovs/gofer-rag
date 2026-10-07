// A/B for the fine-tune: base vs trained gemma, closed book, on the eval split.
//
//   bun run scripts/sft-ab.ts answer --tag base    [--limit N] [--concurrency N]
//   bun run scripts/sft-ab.ts answer --tag trained [--limit N] [--concurrency N]
//   bun run scripts/sft-ab.ts judge  [--concurrency N]        (needs the Qwen judge on :8080)
//   bun run scripts/sft-ab.ts report
//
// Questions: the eval-split, plain-question (odd id), supported pairs — the same
// split sft-export.ts wrote, so nothing here was in train.jsonl. The model under
// test answers with the export SYSTEM prompt and no passage. The judge then
// checks the answer against the passage with the sft-judge prompt. Score = share
// of answers with zero unsupported claims. Tables ab_answers / ab_verdicts.

import {Database} from 'bun:sqlite'
import {z} from 'zod'

const DB = 'data/sft/sft.sqlite'
const BASE = process.env.GOFER_RAG_LLM_BASE_URL ?? 'http://localhost:8080/v1'

const argv = process.argv.slice(2)
const command = argv[0]
const argument = (name: string, fallback: string) => {
    const i = argv.indexOf(name)
    return i === -1 ? fallback : argv[i + 1]!
}
const concurrency = Number(argument('--concurrency', '2'))
const limit = Number(argument('--limit', '0'))
const tag = argument('--tag', '')
const evalShare = Number(argument('--eval-share', '0.05'))
const seed = Number(argument('--seed', '7'))
const split = argument('--split', 'eval')
const sample = Number(argument('--sample', '300'))

const SYSTEM =
    'You are a Godot Engine 4 assistant. Answer from the Godot documentation. Be direct. Use GDScript for code unless asked otherwise. If a passage is given, answer only from it.'
// Closed-book prompt for small models that otherwise refuse when no passage is given.
// A refusal has zero unsupported claims and would score as supported, so it must be ruled out.
const CLOSED =
    'You are a Godot Engine 4 assistant. Answer the question from your own knowledge of the Godot 4 documentation. Never say that documentation or a passage is missing. Always give a concrete answer. Be direct. Use GDScript for code unless asked otherwise.'
const closed = argv.includes('--closed')

const JUDGE = `You are a fact checker for Godot Engine documentation.
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

const VerdictSchema = z.object({unsupported_claims: z.array(z.string().trim().min(1)), supported: z.boolean()})
const AnswerSchema = z.string().trim().min(1)
const schema = {
    type: 'object',
    properties: {unsupported_claims: {type: 'array', items: {type: 'string'}}, supported: {type: 'boolean'}},
    required: ['unsupported_claims', 'supported']
}

type Question = {id: number; chapter: string; text: string; before: string; question: string}
type Answered = Question & {tag: string; answer: string}
type Chat = {choices: {message: {content: string}}[]}

const db = new Database(DB)
db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ab_answers (
        pair_id INTEGER NOT NULL REFERENCES pairs(id), tag TEXT NOT NULL, answer TEXT NOT NULL,
        model TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (pair_id, tag)
    );
    CREATE TABLE IF NOT EXISTS ab_verdicts (
        pair_id INTEGER NOT NULL, tag TEXT NOT NULL, supported INTEGER NOT NULL, reasons TEXT NOT NULL,
        raw TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (pair_id, tag)
    );
    CREATE TABLE IF NOT EXISTS ab_failures (
        pair_id INTEGER NOT NULL, tag TEXT NOT NULL, step TEXT NOT NULL, error TEXT NOT NULL, created_at TEXT NOT NULL
    );
`)
const insertFailure = db.prepare(
    'INSERT INTO ab_failures (pair_id, tag, step, error, created_at) VALUES (?, ?, ?, ?, ?)'
)

// Same chapter split as sft-export.ts.
const hash = (s: string) => {
    let h = 2166136261 ^ seed
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    return (h >>> 0) / 4294967296
}
const isEval = (chapter: string) => hash(chapter) < evalShare

const evalQuestions = (): Question[] =>
    (
        db
            .prepare(
                `SELECT p.id, c.chapter, c.text, c.before, p.question
                 FROM pairs p JOIN chunks c ON c.id = p.chunk_id JOIN verdicts v ON v.pair_id = p.id
                 WHERE v.supported = 1 AND p.id % 2 = 1 ORDER BY p.id`
            )
            .all() as Question[]
    ).filter(q => inSplit(q.chapter))
const pilotChapters = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE name = 'cpt_pilot'").get() ?
        (db.prepare('SELECT chapter FROM cpt_pilot').all() as {chapter: string}[])
    :   []
    ).map(r => r.chapter)
)
const inSplit = (chapter: string) => {
    if (split === 'eval') return isEval(chapter)
    if (split === 'cpt') return pilotChapters.has(chapter)
    return !isEval(chapter)
}
// Train-split questions are a fixed seeded sample so both tags see the same set.
const seeded = (items: Question[]) => {
    const key = (q: Question) => hash(`${q.id}`)
    return [...items].sort((a, b) => key(a) - key(b)).slice(0, sample)
}

async function chat(body: object): Promise<string> {
    const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return ((await response.json()) as Chat).choices[0]!.message.content
}

const modelId = async () => ((await (await fetch(`${BASE}/models`)).json()) as {data: {id: string}[]}).data[0]!.id

async function run<T>(items: T[], each: (item: T) => Promise<void>, label: string): Promise<void> {
    let index = 0
    let n = 0
    const started = Date.now()
    const worker = async () => {
        while (index < items.length) {
            const item = items[index++]
            if (!item) break
            await each(item)
            n++
            if (n % 20 === 0 || n === items.length) {
                const per = (Date.now() - started) / n / 1000
                console.log(
                    `${label} ${n}/${items.length}  ${per.toFixed(1)}s each  eta ${(((items.length - n) * per) / 60).toFixed(0)} min`
                )
            }
        }
    }
    await Promise.all(Array.from({length: concurrency}, worker))
}

if (command === 'answer') {
    if (!tag) throw new Error('--tag required')
    const tagged = split === 'eval' ? tag : `${tag}-${split}`
    const model = await modelId()
    const done = new Set(
        (db.prepare('SELECT pair_id FROM ab_answers WHERE tag = ?').all(tagged) as {pair_id: number}[]).map(
            r => r.pair_id
        )
    )
    const pool = split === 'eval' ? evalQuestions() : seeded(evalQuestions())
    let todo = pool.filter(q => !done.has(q.id))
    if (limit) todo = todo.slice(0, limit)
    console.log(`model ${model}  tag ${tagged}  questions ${todo.length}`)
    const insert = db.prepare('INSERT INTO ab_answers (pair_id, tag, answer, model, created_at) VALUES (?, ?, ?, ?, ?)')
    await run(
        todo,
        async q => {
            try {
                const answer = AnswerSchema.parse(
                    await chat({
                        messages: [
                            {role: 'system', content: closed ? CLOSED : SYSTEM},
                            {role: 'user', content: q.question.toWellFormed()}
                        ],
                        temperature: 0
                    })
                )
                insert.run(q.id, tagged, answer, model, new Date().toISOString())
            } catch (error) {
                insertFailure.run(
                    q.id,
                    tagged,
                    'answer',
                    (error as Error).message.slice(0, 500),
                    new Date().toISOString()
                )
                console.error(`fail ${q.id}: ${(error as Error).message.slice(0, 200)}`)
            }
        },
        'answer'
    )
}

if (command === 'judge') {
    const model = await modelId()
    const todo = db
        .prepare(
            `SELECT p.id, c.chapter, c.text, c.before, p.question, a.tag, a.answer
             FROM ab_answers a JOIN pairs p ON p.id = a.pair_id JOIN chunks c ON c.id = p.chunk_id
             WHERE NOT EXISTS (SELECT 1 FROM ab_verdicts v WHERE v.pair_id = a.pair_id AND v.tag = a.tag)
             ORDER BY p.id, a.tag`
        )
        .all() as Answered[]
    console.log(`judge ${model}  answers to judge ${todo.length}`)
    const insert = db.prepare(
        'INSERT INTO ab_verdicts (pair_id, tag, supported, reasons, raw, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    await run(
        todo,
        async a => {
            try {
                const user =
                    `Chapter: ${a.chapter}\n\nBefore:\n${a.before || '(start of chapter)'}\n\nPassage:\n${a.text}\n\nQuestion: ${a.question}\n\nAnswer:\n${a.answer}`.toWellFormed()
                const raw = await chat({
                    messages: [
                        {role: 'system', content: JUDGE},
                        {role: 'user', content: user}
                    ],
                    temperature: 0,
                    chat_template_kwargs: {enable_thinking: false},
                    response_format: {type: 'json_schema', json_schema: {name: 'verdict', schema}}
                })
                const verdict = VerdictSchema.parse(JSON.parse(raw))
                insert.run(
                    a.id,
                    a.tag,
                    verdict.supported ? 1 : 0,
                    JSON.stringify(verdict.unsupported_claims),
                    raw,
                    model,
                    new Date().toISOString()
                )
            } catch (error) {
                insertFailure.run(
                    a.id,
                    a.tag,
                    'judge',
                    (error as Error).message.slice(0, 500),
                    new Date().toISOString()
                )
                console.error(`fail ${a.id} ${a.tag}: ${(error as Error).message.slice(0, 200)}`)
            }
        },
        'judge'
    )
}

// Recall: does the model answer state the fact the reference answer states?
// Length-independent, unlike the supported score: a short vague answer scores 0 here.
const RECALL = `You compare a model answer with a reference answer to a Godot Engine question.
The reference answer was written from the documentation and is correct.
Decide whether the model answer states the same core fact as the reference: the same class, method, property, value, or behaviour that answers the question.
Extra detail in the model answer does not matter. Wording does not matter.
Set "recalled" to true only when the core fact matches. A vague answer, a wrong name, a wrong value, or a refusal is false.
Return JSON only.`
const RecallSchema = z.object({recalled: z.boolean(), reason: z.string()})
const recallSchema = {
    type: 'object',
    properties: {recalled: {type: 'boolean'}, reason: {type: 'string'}},
    required: ['recalled', 'reason']
}
type Recalled = Answered & {reference: string}

if (command === 'recall') {
    const model = await modelId()
    const like = argument('--tags', '%')
    db.exec(`CREATE TABLE IF NOT EXISTS ab_recall (
        pair_id INTEGER NOT NULL, tag TEXT NOT NULL, recalled INTEGER NOT NULL, raw TEXT NOT NULL,
        model TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (pair_id, tag))`)
    const todo = db
        .prepare(
            `SELECT p.id, c.chapter, c.text, c.before, p.question, p.answer AS reference, a.tag, a.answer
             FROM ab_answers a JOIN pairs p ON p.id = a.pair_id JOIN chunks c ON c.id = p.chunk_id
             WHERE a.tag LIKE ? AND NOT EXISTS (SELECT 1 FROM ab_recall r WHERE r.pair_id = a.pair_id AND r.tag = a.tag)
             ORDER BY p.id, a.tag`
        )
        .all(like) as Recalled[]
    console.log(`recall ${model}  answers to judge ${todo.length}`)
    const insert = db.prepare(
        'INSERT INTO ab_recall (pair_id, tag, recalled, raw, model, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    await run(
        todo,
        async a => {
            try {
                const user =
                    `Question: ${a.question}\n\nReference answer:\n${a.reference}\n\nModel answer:\n${a.answer}`.toWellFormed()
                const raw = await chat({
                    messages: [
                        {role: 'system', content: RECALL},
                        {role: 'user', content: user}
                    ],
                    temperature: 0,
                    chat_template_kwargs: {enable_thinking: false},
                    response_format: {type: 'json_schema', json_schema: {name: 'recall', schema: recallSchema}}
                })
                const verdict = RecallSchema.parse(JSON.parse(raw))
                insert.run(a.id, a.tag, verdict.recalled ? 1 : 0, raw, model, new Date().toISOString())
            } catch (error) {
                insertFailure.run(
                    a.id,
                    a.tag,
                    'recall',
                    (error as Error).message.slice(0, 500),
                    new Date().toISOString()
                )
                console.error(`fail ${a.id} ${a.tag}: ${(error as Error).message.slice(0, 200)}`)
            }
        },
        'recall'
    )
}

if (command === 'report') {
    type Row = {tag: string; n: number; supported: number; claims: number; chars: number}
    const rows = db
        .prepare(
            `SELECT v.tag, COUNT(*) AS n, SUM(v.supported) AS supported,
                    AVG(json_array_length(v.reasons)) AS claims, AVG(LENGTH(a.answer)) AS chars
             FROM ab_verdicts v JOIN ab_answers a ON a.pair_id = v.pair_id AND a.tag = v.tag
             GROUP BY v.tag ORDER BY v.tag`
        )
        .all() as Row[]
    console.log('tag        n    supported   avg unsupported claims   avg answer chars')
    for (const r of rows)
        console.log(
            `${r.tag.padEnd(10)} ${String(r.n).padStart(4)}   ${((100 * r.supported) / r.n).toFixed(1).padStart(5)}%   ${r.claims.toFixed(2).padStart(6)}                   ${r.chars.toFixed(0)}`
        )
    // Paired: same question judged for both tags.
    const paired = db.prepare(
        `SELECT SUM(b.supported = 0 AND t.supported = 1) AS gained, SUM(b.supported = 1 AND t.supported = 0) AS lost, COUNT(*) AS n
             FROM ab_verdicts b JOIN ab_verdicts t ON t.pair_id = b.pair_id AND t.tag = ?
             WHERE b.tag = ?`
    )
    type Pairing = {base: string; trained: string}
    const pairings: Pairing[] = [
        {base: 'base', trained: 'trained'},
        {base: 'base-train', trained: 'trained-train'},
        {base: 'base-cpt', trained: 'cpt-cpt'},
        {base: 'base-cpt', trained: 'trained-cpt'},
        {base: 'base-e4b-cpt', trained: 'e4b-a-cpt'},
        {base: 'base-e4b-cpt', trained: 'e4b-b-cpt'},
        {base: 'e4b-a-cpt', trained: 'e4b-b-cpt'}
    ]
    for (const {base: b, trained: t} of pairings) {
        const r = paired.get(t, b) as {gained: number; lost: number; n: number}
        if (r.n) console.log(`paired ${b} vs ${t} (${r.n}): trained gained ${r.gained}, lost ${r.lost}`)
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'ab_recall'").get()) {
        type RecallRow = {tag: string; n: number; recalled: number}
        const recalls = db
            .prepare('SELECT tag, COUNT(*) AS n, SUM(recalled) AS recalled FROM ab_recall GROUP BY tag ORDER BY tag')
            .all() as RecallRow[]
        console.log('recall (core fact matches the reference answer)')
        for (const r of recalls)
            console.log(
                `${r.tag.padEnd(14)} ${String(r.n).padStart(4)}   ${((100 * r.recalled) / r.n).toFixed(1).padStart(5)}%`
            )
        const pairedRecall = db.prepare(
            `SELECT SUM(b.recalled = 0 AND t.recalled = 1) AS gained, SUM(b.recalled = 1 AND t.recalled = 0) AS lost, COUNT(*) AS n
             FROM ab_recall b JOIN ab_recall t ON t.pair_id = b.pair_id AND t.tag = ? WHERE b.tag = ?`
        )
        for (const {base: b, trained: t} of pairings) {
            const r = pairedRecall.get(t, b) as {gained: number; lost: number; n: number}
            if (r.n) console.log(`recall paired ${b} vs ${t} (${r.n}): trained gained ${r.gained}, lost ${r.lost}`)
        }
    }
}

if (!['answer', 'judge', 'recall', 'report'].includes(command ?? ''))
    console.log('usage: sft-ab.ts answer|judge|recall|report')
