// Minimal HTTP API over the query pipeline, using Bun's native server (no deps).
//
//   GET  /health        → { status: 'ok' }
//   POST /query {q}      → QueryResult
//
// A query that runs but finds nothing is a *successful* request with found:false
// (HTTP 200), not an error — the caller reads result.found / result.message.

import {query} from '../core/query'
import {config} from '../config'
import type {QueryResult} from '../types'

type QueryBody = {q?: string}
type QueryHandler = (question: string) => Promise<QueryResult>

type ApiOptions = {
    port?: number
    query?: QueryHandler
}

export function createApiHandler(runQuery: QueryHandler = query): (request: Request) => Promise<Response> {
    return async request => {
        const url = new URL(request.url)

        if (request.method === 'GET' && url.pathname === '/health') return Response.json({status: 'ok'})

        if (request.method === 'POST' && url.pathname === '/query') {
            const body = (await request.json()) as QueryBody
            const question = body.q?.trim()
            if (!question) return Response.json({error: 'missing "q"'}, {status: 400})
            return Response.json(await runQuery(question))
        }

        return new Response('Not found', {status: 404})
    }
}

export function startApi(options: ApiOptions = {}): ReturnType<typeof Bun.serve> {
    return Bun.serve({
        port: options.port ?? config.apiPort,
        fetch: createApiHandler(options.query)
    })
}
