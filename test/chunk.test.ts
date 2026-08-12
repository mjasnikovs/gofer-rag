import {describe, expect, test} from 'bun:test'
import {chunkChapter} from '../ingest/chunk'
import {config} from '../src/config'
import type {Chapter} from '../src/types'

const chapter = (text: string): Chapter => ({title: 'Node', href: 'node.html', order: 7, text})

describe('chunkChapter', () => {
    test('preserves chapter metadata and creates stable identifiers', () => {
        expect(chunkChapter(chapter('A short documentation paragraph.'))).toEqual([
            {
                id: '7-0',
                chapter: 'Node',
                order: 7,
                chunkIndex: 0,
                text: 'A short documentation paragraph.'
            }
        ])
    })

    test('hard-splits oversized paragraphs with the configured overlap', () => {
        const chunks = chunkChapter(chapter('x'.repeat(config.chunkChars * 2)))

        expect(chunks.length).toBeGreaterThan(1)
        expect(chunks[0]!.text).toHaveLength(config.chunkChars)
        expect(chunks[1]!.text.startsWith(chunks[0]!.text.slice(-config.overlapChars))).toBeTrue()
        expect(chunks.every(chunk => chunk.chapter === 'Node' && chunk.order === 7)).toBeTrue()
    })

    test('packs paragraphs without crossing chapter boundaries', () => {
        const chunks = chunkChapter(chapter(`${'a'.repeat(1_000)}\n\n${'b'.repeat(1_000)}`))

        expect(chunks).toHaveLength(2)
        expect(chunks[0]!.text).not.toContain('b')
        expect(chunks[1]!.text).toContain('b')
    })

    // Half a surrogate pair is not valid JSON, and the embedding box rejects
    // the whole batch when one reaches it.
    test('never hard-splits through a surrogate pair', () => {
        // Place an emoji so the pair straddles the exact budget boundary.
        const text = `${'x'.repeat(config.chunkChars - 1)}🤗${'y'.repeat(config.chunkChars)}`
        const chunks = chunkChapter(chapter(text))

        for (const chunk of chunks) {
            expect(chunk.text).toBe(chunk.text.toWellFormed())
        }
    })

    // A paragraph seam copies nothing. Packing never cuts a paragraph, so the
    // old tail copy bought no context and cost 11.87% of the corpus — see the
    // header of ingest/chunk.ts.
    test('carries no overlap across a paragraph seam', () => {
        const chunks = chunkChapter(chapter(`${'a'.repeat(1_000)}\n\n${'b'.repeat(1_000)}`))

        expect(chunks[1]!.text).toBe('b'.repeat(1_000))
        expect(chunks[1]!.text).not.toContain('a')
    })
})
