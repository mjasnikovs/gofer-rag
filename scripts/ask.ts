// `bun run scripts/ask.ts "your question"` — one-shot query without the TUI.
// Handy for scripting and testing. Prints the reranked hits, then the answer.

import {query, retrieve, warmup} from '../src/core/query'

const question = process.argv[2] ?? 'What are the system requirements for Godot?'

console.log('Loading models ...')
await warmup()

console.log(`\nQ: ${question}\n`)

const ranked = await retrieve(question)
console.log('reranked hits:')
if (ranked.length === 0) console.log('  (nothing above threshold)')
for (const chunk of ranked) console.log(`  ${chunk.score.toFixed(2)}  ${chunk.chapter}`)

const result = await query(question)
console.log('\nresult:')
console.log(JSON.stringify(result, null, 2))
process.exit(0)
