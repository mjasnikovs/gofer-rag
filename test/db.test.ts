import {describe, expect, test} from 'bun:test'
import {coversToken, distinctiveTitle, editDistance, namesTitle, symbolTokens} from '../src/store/db'

describe('title matching helpers', () => {
    test('recognizes distinctive Godot class titles', () => {
        expect(distinctiveTitle('Sprite2D')).toBeTrue()
        expect(distinctiveTitle('AnimationPlayer')).toBeTrue()
        expect(distinctiveTitle('Control')).toBeFalse()
    })

    test('uses adjacent transpositions in edit distance', () => {
        expect(editDistance('andriod', 'android')).toBe(1)
        expect(editDistance('node', 'mode')).toBe(1)
        expect(editDistance('node', 'sprite')).toBeGreaterThan(1)
    })

    test('covers exact, stemmed, and conservatively misspelled tokens', () => {
        expect(coversToken('export', 'exporting')).toBeTrue()
        expect(coversToken('andriod', 'android')).toBeTrue()
        expect(coversToken('stop', 'step')).toBeFalse()
    })
})

describe('namesTitle', () => {
    // A single-hump title stays case-sensitive in prose, because 66 of 84 of
    // them are ordinary English words. A dotted member reference is not prose,
    // so it matches either way — which is what lets a lowercased question reach
    // the class page it spells out.
    test('reads a dotted member reference as naming its class, in any case', () => {
        expect(namesTitle('what does timer.autostart do at runtime?', 'Timer')).toBeTrue()
        expect(namesTitle('What does Timer.autostart do at runtime?', 'Timer')).toBeTrue()
        expect(namesTitle('what does the timer node do at runtime?', 'Timer')).toBeFalse()
    })

    test('still refuses a lowercase title that is only an English word', () => {
        expect(namesTitle('how do i put a tree in my scene', 'Tree')).toBeFalse()
        expect(namesTitle('how do i read tree.item_selected', 'Tree')).toBeTrue()
    })

    test('a sentence that ends on a title is not a member reference', () => {
        expect(namesTitle('i added a timer. Autostart was off.', 'Timer')).toBeFalse()
    })
})

describe('symbolTokens', () => {
    test('extracts snake-case and all-cap member names', () => {
        expect(symbolTokens('Use _physics_process, get_node_or_null, and TYPE_INT.')).toEqual([
            '_physics_process',
            'get_node_or_null',
            'TYPE_INT'
        ])
    })

    test('does not treat class names or ordinary prose as members', () => {
        expect(symbolTokens('What does CharacterBody2D do every frame?')).toEqual([])
    })
})
