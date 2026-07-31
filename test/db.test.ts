import {describe, expect, test} from 'bun:test'
import {coversToken, distinctiveTitle, editDistance, symbolTokens} from '../src/store/db'

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
