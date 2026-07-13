// Minimal HTTP API over the query pipeline, using Bun's native server (no deps).
//
//   GET  /health        → { status: 'ok' }
//   POST /query {q}      → QueryResult
//
// A query that runs but finds nothing is a *successful* request with found:false
// (HTTP 200), not an error — the caller reads result.found / result.message.

import {query} from '../core/query'
import {config} from '../config'

type QueryBody = {q?: string}

export function startApi(): ReturnType<typeof Bun.serve> {
    return Bun.serve({
        port: config.apiPort,
        async fetch(req) {
            const url = new URL(req.url)

            if (req.method === 'GET' && url.pathname === '/health') return Response.json({status: 'ok'})

            if (req.method === 'POST' && url.pathname === '/query') {
                const body = (await req.json()) as QueryBody
                const question = body.q?.trim()
                if (!question) return Response.json({error: 'missing "q"'}, {status: 400})
                return Response.json(await query(question))
            }

            return new Response('Not found', {status: 404})
        }
    })
}
