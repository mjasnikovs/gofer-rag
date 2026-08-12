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

    // GDScript is indent-based, so the whitespace passes must not reach inside
    // a code block. They used to, and every sample came out at column zero.
    test('keeps the indentation inside a pre block', () => {
        const html =
            '<p>Like this:</p><div class="highlight"><pre>func _physics_process(delta):\n    velocity.y += 10\n    move_and_slide()\n</pre></div><p>Done.</p>'

        expect(htmlToText(html)).toBe(
            'Like this:\n\nfunc _physics_process(delta):\n    velocity.y += 10\n    move_and_slide()\n\nDone.'
        )
    })

    test('decodes entities and strips highlight spans inside a pre block', () => {
        const html = '<pre><span class="k">if</span> a &lt; b:\n    <span class="nb">print</span>(a)</pre>'

        expect(htmlToText(html)).toBe('if a < b:\n    print(a)')
    })

    test('keeps two pre blocks apart', () => {
        const html = '<pre>  a</pre><p>Between.</p><pre>  b</pre>'

        expect(htmlToText(html)).toBe('  a\n\nBetween.\n\n  b')
    })
})
