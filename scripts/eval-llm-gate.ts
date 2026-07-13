// LLM refusal-gate check — the only eval that needs the 27B llama.cpp server up.
// It asks off-topic "bait" questions and asserts the pipeline refuses
// (found:false) instead of hallucinating an answer. When the server is down it
// SKIPs cleanly (exit 0), so it can be wired in without a GPU box — which is why
// it is kept OUT of "bun run test" and lives behind "bun run test:llm".
//
//   bun run scripts/eval-llm-gate.ts             quiet: one summary line, exit 1 on fail
//   bun run scripts/eval-llm-gate.ts --verbose   print each bait verdict

import {config} from '../src/config'
import {query, warmup} from '../src/core/query'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')

// llmBaseUrl is ".../v1"; the llama.cpp health endpoint is its sibling.
const healthUrl = config.llmBaseUrl.replace(/\/v1\/?$/, '') + '/health'
const up = await fetch(healthUrl, {signal: AbortSignal.timeout(2000)})
    .then(r => r.ok)
    .catch(() => false)
if (!up) {
    console.log(`llm-gate: SKIP  (no server at ${healthUrl})`)
    process.exit(0)
}

// The corpus is Godot documentation, so both of these must be refused.
const bait = ['What is the best recipe for sourdough bread?', 'Who won the 2022 FIFA World Cup?']

if (verbose) console.log('Loading models ...')
await warmup()

let refused = 0
for (const q of bait) {
    const result = await query(q)
    const refusedThis = result.found === false
    if (refusedThis) refused++
    if (verbose || !refusedThis) console.log(`${refusedThis ? 'REFUSED' : 'LEAK'}  ${q}`)
}

const ok = refused === bait.length
console.log(`llm-gate: ${ok ? 'PASS' : 'FAIL'}  ${refused}/${bait.length} refused`)
process.exit(ok ? 0 : 1)
