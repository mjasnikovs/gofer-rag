// `bun run scripts/sft-rewrite-export.ts`
// Fact-injection proof, arm B data: one `{"text"}` row per rewrite, plus the
// original chunk text once. Same chapters as cpt-pilot.jsonl (arm A).

import {Database} from 'bun:sqlite'
import {writeFileSync} from 'node:fs'
import {z} from 'zod'

const DB = 'data/sft/sft.sqlite'
const OUT = 'data/sft/cpt-rewrites.jsonl'
const Row = z.object({text: z.string().trim().min(100)})
type Text = {text: string}

const db = new Database(DB)
const originals = db
    .prepare('SELECT text FROM chunks WHERE chapter IN (SELECT chapter FROM cpt_pilot) ORDER BY id')
    .all() as Text[]
const rewrites = db.prepare('SELECT text FROM rewrites ORDER BY chunk_id, variant').all() as Text[]
const rows = [...originals, ...rewrites].map(r => JSON.stringify(Row.parse(r)).toWellFormed())
writeFileSync(OUT, rows.join('\n') + '\n')
const chars = rows.reduce((n, r) => n + r.length, 0)
console.log(`originals ${originals.length}, rewrites ${rewrites.length}, rows ${rows.length}, chars ${chars} -> ${OUT}`)
