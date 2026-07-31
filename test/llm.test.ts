import {describe, expect, test} from 'bun:test'
import {expandQuery, generateAnswer} from '../src/ai/llm'

const completion = (content: string): Response => Response.json({choices: [{message: {content}}]})

describe('expandQuery', () => {
    test('returns a compliant Godot term list', async () => {
        const fetcher = () => Promise.resolve(completion('CharacterBody2D, move_and_slide, physics'))

        expect(await expandQuery('How do I move a player?', fetcher)).toBe('CharacterBody2D, move_and_slide, physics')
    })

    test('rejects prose and NONE replies', async () => {
        const prose = () => Promise.resolve(completion('This is a sentence. It is not a term list.'))
        expect(await expandQuery('question', prose)).toBe('')

        const none = () => Promise.resolve(completion('NONE'))
        expect(await expandQuery('question', none)).toBe('')
    })

    test('falls back to unexpanded retrieval on request failure', async () => {
        const fetcher = () => Promise.reject<Response>(new Error('offline'))

        expect(await expandQuery('question', fetcher)).toBe('')
    })
})

describe('generateAnswer', () => {
    test('returns the assistant content and sends supplied context', async () => {
        let body = ''
        const fetcher = (_input: string | URL | Request, init?: RequestInit) => {
            body = typeof init?.body === 'string' ? init.body : ''
            return Promise.resolve(completion('Use Node. [Node]'))
        }

        expect(await generateAnswer('What is Node?', '[1] Node docs', fetcher)).toBe('Use Node. [Node]')
        expect(body).toContain('What is Node?')
        expect(body).toContain('[1] Node docs')
    })

    test('throws with the response body on HTTP failure', async () => {
        const fetcher = () => Promise.resolve(new Response('server unavailable', {status: 503}))

        let error: unknown
        try {
            await generateAnswer('question', 'context', fetcher)
        } catch (caught) {
            error = caught
        }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('503 server unavailable')
    })
})
