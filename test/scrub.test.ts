import {describe, expect, test} from 'bun:test'
import {dropBracketedUrls, dropCsharpTabs, namesCsharp} from '../ingest/scrub'

describe('dropCsharpTabs', () => {
    test('drops the C# half of a tab pair and keeps the GDScript half', () => {
        const text = [
            'Connect the button to a method.',
            'GDScript',
            'func _on_close_button_pressed():',
            'get_tree().paused = false',
            'C#',
            'private void OnCloseButtonPressed()',
            '{',
            'GetTree().Paused = false;',
            '}',
            'You should now have a working pause menu.'
        ].join('\n')

        expect(dropCsharpTabs(text)).toBe(
            [
                'Connect the button to a method.',
                'GDScript',
                'func _on_close_button_pressed():',
                'get_tree().paused = false',
                'You should now have a working pause menu.'
            ].join('\n')
        )
    })

    test('ends the block at the end of the chapter when no prose follows', () => {
        const text = ['GDScript', 'var a = 1', 'C#', 'var a = 1;'].join('\n')

        expect(dropCsharpTabs(text)).toBe(['GDScript', 'var a = 1'].join('\n'))
    })

    // A C# comment is six-plus words ending in a period, which is also the
    // shape of the prose line that closes a block. The comment must not end it.
    test('does not end the block on a code comment', () => {
        const text = [
            'GDScript',
            'func _ready():',
            'C#',
            '// Called when the node and its children have entered the scene tree.',
            'public override void _Ready() { }',
            'Real prose closes the block right here.'
        ].join('\n')

        expect(dropCsharpTabs(text)).toBe(
            ['GDScript', 'func _ready():', 'Real prose closes the block right here.'].join('\n')
        )
    })

    test('leaves text with no C# marker untouched', () => {
        const text = 'A paragraph mentioning C# inline stays exactly as written.'

        expect(dropCsharpTabs(text)).toBe(text)
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
