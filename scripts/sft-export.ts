// `bun run scripts/sft-export.ts [--eval-share 0.05] [--seed 7]`
// Writes data/sft/train.jsonl and data/sft/eval.jsonl from judged, supported pairs.
// Split is by chapter so no chapter leaks between train and eval.
// Even pair ids carry the passage in the user turn; odd ones are plain Q -> A.

import {Database} from 'bun:sqlite'
import {writeFileSync} from 'node:fs'
import {z} from 'zod'

const DB = 'data/sft/sft.sqlite'
const argument = (name: string, fallback: number) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? fallback : Number(process.argv[i + 1])
}
const evalShare = argument('--eval-share', 0.05)
const seed = argument('--seed', 7)

const SYSTEM =
    'You are a Godot Engine 4 assistant. Answer from the Godot documentation. Be direct. Use GDScript for code unless asked otherwise. If a passage is given, answer only from it.'

const Message = z.object({role: z.enum(['system', 'user', 'assistant']), content: z.string().trim().min(1)})
const TrainRow = z.object({
    messages: z
        .tuple([Message, Message, Message])
        .refine(m => m[0].role === 'system' && m[1].role === 'user' && m[2].role === 'assistant', 'turn order')
})

type Pair = {id: number; chapter: string; text: string; question: string; answer: string}

const db = new Database(DB, {readonly: true})
const pairs = db
    .prepare(
        `SELECT p.id, c.chapter, c.text, p.question, p.answer
         FROM pairs p JOIN chunks c ON c.id = p.chunk_id JOIN verdicts v ON v.pair_id = p.id
         WHERE v.supported = 1 ORDER BY p.id`
    )
    .all() as Pair[]

// Deterministic chapter split: hash(chapter, seed) into [0,1).
const hash = (s: string) => {
    let h = 2166136261 ^ seed
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    return (h >>> 0) / 4294967296
}
const isEval = (chapter: string) => hash(chapter) < evalShare

const toRow = (p: Pair) => {
    const user = p.id % 2 === 0 ? `Passage:\n${p.text}\n\nQuestion: ${p.question}` : p.question
    return TrainRow.parse({
        messages: [
            {role: 'system', content: SYSTEM},
            {role: 'user', content: user},
            {role: 'assistant', content: p.answer}
        ]
    })
}

const train: string[] = []
const evaluation: string[] = []
let invalid = 0
let maxChars = 0
for (const p of pairs) {
    try {
        const row = toRow(p)
        const line = JSON.stringify(row).toWellFormed()
        maxChars = Math.max(maxChars, line.length)
        ;(isEval(p.chapter) ? evaluation : train).push(line)
    } catch {
        invalid++
    }
}
writeFileSync('data/sft/train.jsonl', train.join('\n') + '\n')
writeFileSync('data/sft/eval.jsonl', evaluation.join('\n') + '\n')
console.log(
    `supported pairs ${pairs.length}, invalid ${invalid}, train ${train.length}, eval ${evaluation.length}, max row chars ${maxChars}`
)
