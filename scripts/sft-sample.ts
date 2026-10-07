// `bun run scripts/sft-sample.ts [N]` — prints N random judged pairs for a human read.
import {Database} from 'bun:sqlite'

const n = Number(process.argv[2] ?? 30)
const db = new Database('data/sft/sft.sqlite', {readonly: true})
const rows = db
    .prepare(
        `SELECT p.id, c.chapter, p.question, p.answer, v.supported, v.reasons
         FROM pairs p JOIN chunks c ON c.id = p.chunk_id JOIN verdicts v ON v.pair_id = p.id
         ORDER BY random() LIMIT ?`
    )
    .all(n) as {id: number; chapter: string; question: string; answer: string; supported: number; reasons: string}[]
for (const r of rows) {
    console.log(`\n#${r.id} [${r.supported ? 'KEEP' : 'DROP'}] ${r.chapter}\nQ: ${r.question}\nA: ${r.answer}`)
    if (!r.supported) console.log(`why: ${r.reasons}`)
}
