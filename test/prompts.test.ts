import {describe, expect, test} from 'bun:test'
import {cleanText, documentText, hasSpecialToken, queryText} from '../src/ai/prompts'

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

    test('replacement patterns in document text are kept literally', () => {
        expect(documentText('String', "Use $& and $' as-is.")).toBe("title: String | text: Use $& and $' as-is.")
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
