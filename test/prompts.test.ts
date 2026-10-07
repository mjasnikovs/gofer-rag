import {describe, expect, test} from 'bun:test'
import {DOCUMENT_FORMAT, cleanText, documentText, hasSpecialToken, queryText} from '../src/ai/prompts'

// The stored vectors were embedded with these exact strings. Changing one
// silently splits query space from document space, so they are pinned here.
describe('embedding prompts', () => {
    test('a question gets the code-retrieval query prefix', () => {
        expect(queryText('How do I connect a signal?')).toBe('task: code retrieval | query: How do I connect a signal?')
    })

    test('a document carries its chapter title', () => {
        expect(documentText('Using signals', 'Signals are messages.')).toBe(
            'title: Using signals | text: Signals are messages.'
        )
    })

    test('replacement patterns and placeholders are kept literally in title and text', () => {
        expect(documentText('String', "Use $& and $' as-is.")).toBe("title: String | text: Use $& and $' as-is.")
        expect(documentText("a$&b$'", 'body')).toBe("title: a$&b$' | text: body")
        expect(documentText('x {text} y', 'BODY')).toBe('title: x {text} y | text: BODY')
    })

    test('the recorded document format is the one documentText produces', () => {
        expect(DOCUMENT_FORMAT).toBe('title: {title} | text: {text}')
    })

    test('a control token split by another control token does not come back together', () => {
        expect(cleanText('<|ima<pad>ge|>')).toBe('')
        expect(cleanText('<<bos>bos>x')).toBe('x')
        expect(hasSpecialToken('<|ima<pad>ge|>')).toBeTrue()
    })

    test('Gemma control tokens are dropped from user text', () => {
        expect(queryText('what is <|image|> in <bos>Godot<eos>')).toBe(
            'task: code retrieval | query: what is  in Godot'
        )
        expect(cleanText('<|tool_call>x<tool_call|> <|"|>')).toBe('x ')
    })

    test('ordinary angle brackets survive', () => {
        const code = 'if a < b and b > c: Array[<T>] <br> <image> <unused3>'
        expect(cleanText(code)).toBe(code)
        expect(hasSpecialToken('Array[int] < 3')).toBeFalse()
        expect(hasSpecialToken('see <|video|>')).toBeTrue()
    })
})
