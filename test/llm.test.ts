import {afterEach, describe, expect, test} from 'bun:test'
import {expandQuery, generateAnswer} from '../src/ai/llm'
import {configure, resetConfiguration} from '../src/config'
import type {LlmCompletionRequest} from '../src/types'

const completion = (content: string): Response => Response.json({choices: [{message: {content}}]})

// What a reasoning model returns when the token budget ran out inside the
// scratchpad: content present but empty, the real text in reasoning_content.
const reasoningCompletion = (content: string, reasoning: string): Response =>
    Response.json({choices: [{message: {content, reasoning_content: reasoning}}]})

const unusedFetcher = (): Promise<Response> => Promise.reject(new Error('fetch must not be called'))

afterEach(() => resetConfiguration())

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

    test('reads the terms from reasoning_content when content is empty', async () => {
        const fetcher = () => Promise.resolve(reasoningCompletion('', 'Tween, AnimationPlayer, Animation'))

        expect(await expandQuery('How do I animate a value?', fetcher)).toBe('Tween, AnimationPlayer, Animation')
    })

    test('prefers content over reasoning_content when both are present', async () => {
        const fetcher = () => Promise.resolve(reasoningCompletion('Tween, Animation', 'Let me think. Maybe Tween?'))

        expect(await expandQuery('question', fetcher)).toBe('Tween, Animation')
    })

    test('rejects a truncated scratchpad that is not a term list', async () => {
        const fetcher = () => Promise.resolve(reasoningCompletion('', 'We need terms. The user asks about'))

        expect(await expandQuery('question', fetcher)).toBe('')
    })

    test('requests a budget that covers reasoning tokens plus the answer', async () => {
        let body = ''
        const fetcher = (_input: string | URL | Request, init?: RequestInit) => {
            body = typeof init?.body === 'string' ? init.body : ''
            return Promise.resolve(completion('Tween, Animation'))
        }

        await expandQuery('question', fetcher)
        expect((JSON.parse(body) as {max_tokens: number}).max_tokens).toBeGreaterThanOrEqual(1500)
    })

    test('falls back to unexpanded retrieval on request failure', async () => {
        const fetcher = () => Promise.reject<Response>(new Error('offline'))

        expect(await expandQuery('question', fetcher)).toBe('')
    })

    test('falls back to unexpanded retrieval when the request is aborted', async () => {
        const fetcher = () => Promise.reject<Response>(new DOMException('The operation timed out.', 'TimeoutError'))

        expect(await expandQuery('question', fetcher)).toBe('')
    })

    test('uses an injected complete instead of fetch, and supplies its own prompt', async () => {
        let seen: LlmCompletionRequest | undefined
        configure({
            complete: request => {
                seen = request
                return Promise.resolve('Tween, AnimationPlayer, Animation')
            }
        })

        expect(await expandQuery('How do I animate a value?', unusedFetcher)).toBe('Tween, AnimationPlayer, Animation')
        expect(seen?.system).toContain('Godot 4 engine expert')
        expect(seen?.user).toBe('How do I animate a value?')
        expect(seen?.maxTokens).toBeGreaterThanOrEqual(1500)
    })

    test('applies the term-list guard to an injected complete that answers in prose', async () => {
        configure({complete: () => Promise.resolve('This query is unrelated to Godot. Nothing applies here.')})

        expect(await expandQuery('question', unusedFetcher)).toBe('')
    })

    test('degrades to unexpanded retrieval when an injected complete throws', async () => {
        configure({complete: () => Promise.reject(new Error('host connection failed'))})

        expect(await expandQuery('question', unusedFetcher)).toBe('')
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

    test('reads the answer from reasoning_content when content is empty', async () => {
        const fetcher = () => Promise.resolve(reasoningCompletion('', 'Use Node. [Node]'))

        expect(await generateAnswer('What is Node?', '[1] Node docs', fetcher)).toBe('Use Node. [Node]')
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

    test('uses an injected complete instead of fetch', async () => {
        let seen: LlmCompletionRequest | undefined
        configure({
            complete: request => {
                seen = request
                return Promise.resolve('Use Node. [Node]')
            }
        })

        expect(await generateAnswer('What is Node?', '[1] Node docs', unusedFetcher)).toBe('Use Node. [Node]')
        expect(seen?.system).toContain('Godot Engine documentation assistant')
        expect(seen?.user).toContain('[1] Node docs')
    })

    test('propagates an injected complete failure the way an unreachable server does', async () => {
        configure({complete: () => Promise.reject(new Error('host connection failed'))})

        let error: unknown
        try {
            await generateAnswer('question', 'context', unusedFetcher)
        } catch (caught) {
            error = caught
        }
        expect((error as Error).message).toBe('host connection failed')
    })
})
