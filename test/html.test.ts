import {describe, expect, test} from 'bun:test'
import {htmlToText} from '../ingest/html'

describe('htmlToText', () => {
    test('removes scripts, styles, and tags while retaining block boundaries', () => {
        const html =
            '<style>.hidden { color: red }</style><h1>Title</h1><p>Hello <b>Godot</b>.</p><script>bad()</script>'

        expect(htmlToText(html)).toBe('Title\nHello Godot.')
    })

    test('decodes named and numeric entities', () => {
        expect(htmlToText('<p>&lt;Node&gt; &amp; &#65;&#39;</p>')).toBe("<Node> & A'")
    })

    test('normalizes horizontal and vertical whitespace', () => {
        expect(htmlToText('<div> one   two </div>\n\n\n<br> three')).toBe('one two\n\nthree')
    })
})
