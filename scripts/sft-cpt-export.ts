// `bun run scripts/sft-cpt-export.ts [--chapters 150] [--seed 7]`
// Continued-pretraining pilot: raw doc text for a seeded sample of TRAIN-split
// chapters, one row per chapter, `{"text": ...}`. Records the chapter list in
// table cpt_pilot so sft-ab.ts --split cpt tests the same chapters.

import {Database} from 'bun:sqlite'
import {writeFileSync} from 'node:fs'
import {z} from 'zod'

const DB = 'data/sft/sft.sqlite'
const argument = (name: string, fallback: number) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? fallback : Number(process.argv[i + 1])
}
const chapters = argument('--chapters', 150)
const seed = argument('--seed', 7)
const evalShare = argument('--eval-share', 0.05)

const Row = z.object({text: z.string().trim().min(200)})
type Chunk = {chapter: string; ord: number; text: string}

// Same hash and split as sft-export.ts, so no eval chapter leaks in.
const hash = (s: string) => {
    let h = 2166136261 ^ seed
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    return (h >>> 0) / 4294967296
}
const isEval = (chapter: string) => hash(chapter) < evalShare

const db = new Database(DB)
db.exec('CREATE TABLE IF NOT EXISTS cpt_pilot (chapter TEXT PRIMARY KEY)')
const all = (db.prepare('SELECT DISTINCT chapter FROM chunks').all() as {chapter: string}[])
    .map(r => r.chapter)
    .filter(c => !isEval(c))
    .sort((a, b) => hash(`pilot:${a}`) - hash(`pilot:${b}`))
    .slice(0, chapters)

const rows: string[] = []
let chunkCount = 0
let chars = 0
const insert = db.prepare('INSERT OR IGNORE INTO cpt_pilot (chapter) VALUES (?)')
db.transaction(() => {
    db.exec('DELETE FROM cpt_pilot')
    for (const chapter of all) {
        const chunks = db
            .prepare('SELECT chapter, ord, text FROM chunks WHERE chapter = ? ORDER BY ord')
            .all(chapter) as Chunk[]
        const text = `# ${chapter}\n\n${chunks.map(c => c.text).join('\n\n')}`
        rows.push(JSON.stringify(Row.parse({text})).toWellFormed())
        insert.run(chapter)
        chunkCount += chunks.length
        chars += text.length
    }
})()
writeFileSync('data/sft/cpt-pilot.jsonl', rows.join('\n') + '\n')
console.log(`chapters ${rows.length}, chunks ${chunkCount}, chars ${chars} -> data/sft/cpt-pilot.jsonl`)
