// `bun run serve` — load the models, start the HTTP API, and drop into the TUI.
// Both surfaces share the same query pipeline.

import {startApi} from '../src/server/api'
import {startTui} from '../src/server/tui'
import {warmup} from '../src/core/query'

console.log('Loading models (embedder + reranker) ...')
await warmup()

const server = startApi()
console.log(`API ready on http://localhost:${server.port} (POST /query, GET /health)\n`)

await startTui()

await server.stop()
process.exit(0)
