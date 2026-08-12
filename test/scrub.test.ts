import {describe, expect, test} from 'bun:test'
import {dropCsharpTabs, namesCsharp} from '../ingest/scrub'

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

describe('namesCsharp', () => {
    test('exempts chapters whose own title names C#', () => {
        expect(namesCsharp('C# API differences to GDScript')).toBeTrue()
        expect(namesCsharp('C# basics')).toBeTrue()
        expect(namesCsharp('Using signals')).toBeFalse()
        expect(namesCsharp('CanvasItem')).toBeFalse()
    })
})
