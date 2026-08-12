import {describe, expect, test} from 'bun:test'
import {dropBracketedUrls, dropCsharpTabs, namesCsharp} from '../ingest/scrub'

// The shape sphinx emits for a GDScript/C# tab widget, trimmed to what the cut
// actually reads. The nested `<div class="highlight">` inside each pane is the
// reason the closing tag has to be matched by depth.
function tabs(gdscript: string, csharp: string): string {
    return [
        '<div class="sphinx-tabs docutils container">',
        '<div class="docutils container">',
        '<div class="docutils container"><div class="docutils container">',
        '<p>GDScript</p>',
        '</div></div>',
        `<div class="highlight-gdscript notranslate"><div class="highlight"><pre>${gdscript}</pre></div>`,
        '</div>',
        '</div>',
        '<div class="docutils container">',
        '<div class="docutils container"><div class="docutils container">',
        '<p>C#</p>',
        '</div></div>',
        `<div class="highlight-csharp notranslate"><div class="highlight"><pre>${csharp}</pre></div>`,
        '</div>',
        '</div>',
        '</div>'
    ].join('\n')
}

describe('dropCsharpTabs', () => {
    test('drops the C# half of a tab pair and keeps the GDScript half', () => {
        const html = `<p>Connect the button.</p>\n${tabs('get_tree().paused = false', 'GetTree().Paused = false;')}\n<p>Done.</p>`
        const out = dropCsharpTabs(html)

        expect(out).toContain('get_tree().paused = false')
        expect(out).not.toContain('GetTree().Paused')
        expect(out).not.toContain('<p>C#</p>')
        expect(out).toContain('<p>GDScript</p>')
        expect(out).toContain('<p>Done.</p>')
    })

    // The bug the text-based version had: it guessed the block ended at the
    // first line of six-plus words ending in `.!?`, and htmlToText() wraps
    // paragraphs, so the head of the next paragraph went with the code.
    test('keeps the whole paragraph that follows the tabs', () => {
        const prose =
            '<p>Every GDScript file is implicitly a class. The extends keyword defines the\nclass this script inherits or extends. In this case, it is Sprite2D, meaning\nour script gets the properties of\nNode.</p>'
        const html = `${tabs('extends Sprite2D', 'public partial class MySprite2D : Sprite2D\n{\n}')}\n${prose}`

        expect(dropCsharpTabs(html)).toContain(prose)
    })

    test('handles two tab widgets in one chapter', () => {
        const html = `${tabs('var a = 1', 'var a = 1;')}\n<p>Between.</p>\n${tabs('var b = 2', 'var b = 2;')}`
        const out = dropCsharpTabs(html)

        expect(out).toContain('var a = 1')
        expect(out).toContain('var b = 2')
        expect(out).toContain('<p>Between.</p>')
        expect(out).not.toContain('var a = 1;')
        expect(out).not.toContain('var b = 2;')
    })

    // 136 of the book's 1028 C# panes have no tab label: they are the only
    // sample on the page, not a duplicate of a GDScript one above.
    test('keeps an unlabelled C# pane, which has no GDScript twin', () => {
        const html =
            '<div class="highlight-csharp notranslate"><div class="highlight"><pre>var a = 1;</pre></div>\n</div>'

        expect(dropCsharpTabs(html)).toBe(html)
    })

    test('leaves HTML with no C# tab untouched', () => {
        const html = '<p>A paragraph mentioning C# inline stays exactly as written.</p>'

        expect(dropCsharpTabs(html)).toBe(html)
    })
})

describe('dropBracketedUrls', () => {
    test('drops the target and keeps the link text', () => {
        const text = 'Talk to us on the Godot Contributors Chat [https://chat.godotengine.org/]!'

        expect(dropBracketedUrls(text)).toBe('Talk to us on the Godot Contributors Chat!')
    })

    // Blank lines are the paragraph separator splitToBudget() splits on.
    // Dropping them collapses a chapter into one paragraph and sends the whole
    // corpus down the hard-split path.
    test('keeps blank lines that were already blank', () => {
        const text = 'First paragraph.\n\nSecond paragraph [https://example.com/x].\n\nThird paragraph.'

        expect(dropBracketedUrls(text)).toBe('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.')
    })

    test('removes a line that was nothing but a URL', () => {
        const text = [
            'Offline documentation',
            '[https://hosted.weblate.org/engage/godot-engine/]',
            'Next section'
        ].join('\n')

        expect(dropBracketedUrls(text)).toBe(['Offline documentation', 'Next section'].join('\n'))
    })

    test('leaves inline code and bracketed non-URLs alone', () => {
        const text = 'Use get_node("[Player]") and see @GlobalScope_MouseButton for the list.'

        expect(dropBracketedUrls(text)).toBe(text)
    })

    // Cutting only the target would leave "Please help us by contributing one!",
    // which is worse than the sentence it came from. The phrase goes whole.
    test('removes the whole no-description sentence, not just its URL', () => {
        const text =
            'EXPORT_ALL_RESOURCES = 0\nThere is currently no description for this enum. Please help us by contributing one [https://contributing.godotengine.org/x.html]!'

        expect(dropBracketedUrls(text)).toBe('EXPORT_ALL_RESOURCES = 0')
    })

    // The issue number alone carries nothing once its link is gone.
    test('removes a bare GH issue reference whole', () => {
        const text = 'Fixed a regression in the tile editor. GH-80813 [https://github.com/godotengine/godot/pull/80813]'

        expect(dropBracketedUrls(text)).toBe('Fixed a regression in the tile editor.')
    })
})

describe('namesCsharp', () => {
    test('exempts chapters whose own title names C#', () => {
        expect(namesCsharp('C# API differences to GDScript')).toBeTrue()
        expect(namesCsharp('C# basics')).toBeTrue()
        expect(namesCsharp('Using signals')).toBeFalse()
        expect(namesCsharp('CanvasItem')).toBeFalse()
    })
})
