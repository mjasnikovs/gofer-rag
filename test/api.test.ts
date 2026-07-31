import {describe, expect, test} from 'bun:test'
import {createApiHandler} from '../src/server/api'

const handleRequest = createApiHandler(question =>
    Promise.resolve({found: true, answer: `answer:${question}`, sources: []})
)

describe('HTTP API', () => {
    test('reports health', async () => {
        const response = await handleRequest(new Request('http://localhost/health'))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({status: 'ok'})
    })

    test('validates and trims query input', async () => {
        const missing = await handleRequest(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({q: '   '})
            })
        )
        expect(missing.status).toBe(400)

        const response = await handleRequest(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({q: '  Node  '})
            })
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({found: true, answer: 'answer:Node', sources: []})
    })

    test('returns 404 for unsupported routes and methods', async () => {
        expect((await handleRequest(new Request('http://localhost/missing'))).status).toBe(404)
        expect((await handleRequest(new Request('http://localhost/health', {method: 'POST'}))).status).toBe(404)
    })
})
