// The cut-policy regression suite: 85 real questions, frozen pools, no models.
//
// Until this file existed, everything CI knew about the retrieval cut was three
// hand-built cases in query.test.ts. The evals that DO exercise it need the
// llama.cpp server, a GPU rerank box and 5.5 minutes, so they have never run in
// CI and never will. This runs in milliseconds and covers the real pools.
//
// The golden file is the load-bearing part. A diff in kept-default.json is a bug
// report, not a number to update. Regenerate it ONLY when a deliberate change to
// rankCandidates lands: bun run scripts/capture-pools.ts --recut
//
// It has been regenerated once. `maxPassages` and `maxGap` default to Infinity
// and are inert, but `answerFloor` does not: added 2026-09-11, it empties the
// kept set when the best passage scores under -0.5. Four of the 83 questions
// went to [] — discord bot, health bar, main menu, how big can my world be — and
// all four were already counted wrong by their eval sets, so the suites did not
// move. scripts/ab-floor.ts is the paired measurement.

import {describe, expect, test} from 'bun:test'
import {rankCandidates, defaultCut, type CutPolicy} from '../src/core/query'
import {config} from '../src/config'
import {loadPools, rehydrate, scoresOf, type CapturedPool} from '../scripts/pools'
import golden from './fixtures/kept-default.json'

const {stamp, pools} = loadPools('test/fixtures/pools.ndjson')
const epoch0 = pools.filter(pool => pool.epoch === 0)

const cut = (overrides: Partial<CutPolicy> = {}): CutPolicy => ({...defaultCut(), ...overrides})
const run = (pool: CapturedPool, policy: CutPolicy) =>
    rankCandidates(pool.question, pool.candidates.map(rehydrate), scoresOf(pool), pool.titles, policy)

const CEILINGS = [1, 2, 3, 4, 5]
const GAPS = [0.5, 1, 1.5, 2, 2.5]

describe('captured pools', () => {
    test('the fixture is scored, on a known backend, against this threshold', () => {
        expect(epoch0.length).toBeGreaterThan(80)
        expect(stamp.backend).not.toBe('unscored')
        expect(stamp.rerankThreshold).toBe(config.rerankThreshold)
        expect(epoch0.every(pool => pool.candidates.every(c => typeof c.score === 'number'))).toBe(true)
    })
})

describe('the default cut is unchanged', () => {
    // The whole point of maxPassages defaulting to Infinity. If this fails, the
    // refactor moved production behaviour and no eval run is needed to know it.
    test('reproduces the golden kept sets on every captured question', () => {
        const now: Record<string, string[]> = {}
        for (const pool of epoch0) {
            now[pool.question] = run(pool, defaultCut()).map(c => `${c.id}${c.pinned ? ' pinned' : ''}`)
        }
        expect(now).toEqual(golden as Record<string, string[]>)
    })
})

describe('no cut can change a refusal', () => {
    // Structural, not measured: rank 1 always survives every ceiling >= 1 and
    // every gap >= 0, so a policy in this family can never empty a non-empty set
    // nor fill an empty one. This is what makes the seven refusal cases in the
    // eval suite immune to anything a consumer sets.
    test('emptiness is identical under every ceiling and every gap', () => {
        for (const pool of epoch0) {
            const base = run(pool, defaultCut()).length === 0
            for (const maxPassages of CEILINGS) expect(run(pool, cut({maxPassages})).length === 0).toBe(base)
            for (const maxGap of GAPS) expect(run(pool, cut({maxGap})).length === 0).toBe(base)
        }
    })
})

describe('a ceiling only ever removes', () => {
    test('the result is a subset of the default and keeps the best chunk', () => {
        for (const pool of epoch0) {
            const base = run(pool, defaultCut())
            if (base.length === 0) continue
            const ids = new Set(base.map(c => c.id))
            for (const maxPassages of CEILINGS) {
                const capped = run(pool, cut({maxPassages}))
                expect(capped.length).toBeLessThanOrEqual(maxPassages)
                expect(capped.every(c => ids.has(c.id))).toBe(true)
                expect(capped.some(c => c.id === base[0]!.id)).toBe(true)
            }
        }
    })
})

describe('the pin survives a ceiling', () => {
    // The regression this whole change exists to prevent. A consumer slicing the
    // array to three cuts every pin, because a pin always sorts last; a consumer
    // asking for maxPassages 3 keeps one.
    test('every question whose default result is pinned still has a pin at three', () => {
        const pinned = epoch0.filter(pool => run(pool, defaultCut()).some(c => c.pinned))
        expect(pinned.length).toBeGreaterThan(0)
        for (const pool of pinned) {
            expect(run(pool, cut({maxPassages: 3})).some(c => c.pinned)).toBe(true)
        }
    })

    test('a naive slice of the default result would have lost them', () => {
        const lost = epoch0.filter(pool => {
            const base = run(pool, defaultCut())
            return base.some(c => c.pinned) && !base.slice(0, 3).some(c => c.pinned)
        })
        expect(lost.length).toBeGreaterThan(0)
    })
})

describe('ordering', () => {
    test('scores fall, and every pin sits below every score-kept chunk', () => {
        for (const pool of epoch0) {
            for (const maxPassages of [Number.POSITIVE_INFINITY, ...CEILINGS]) {
                const kept = run(pool, cut({maxPassages}))
                const scored = kept.filter(c => !c.pinned)
                const pins = kept.filter(c => c.pinned)
                expect(pins.length).toBeLessThanOrEqual(3)
                for (let i = 1; i < scored.length; i++)
                    expect(scored[i]!.score).toBeLessThanOrEqual(scored[i - 1]!.score)
                for (const pin of pins) {
                    for (const hit of scored) expect(pin.score).toBeLessThanOrEqual(hit.score)
                }
                expect(kept.every(c => c.score >= config.rerankThreshold)).toBe(true)
            }
        }
    })
})

describe('byte accounting', () => {
    // Loose bound. It documents the win and catches an implementation that
    // quietly stops capping; it is not a tuned target.
    test('a ceiling of three costs well under three quarters of the bytes', () => {
        const chars = (policy: CutPolicy) =>
            epoch0.reduce((total, pool) => {
                const byId = new Map(pool.candidates.map(c => [c.id, c.textChars]))
                return total + run(pool, policy).reduce((n, c) => n + (byId.get(c.id) ?? 0), 0)
            }, 0)
        const base = chars(defaultCut())
        expect(base).toBeGreaterThan(0)
        expect(chars(cut({maxPassages: 3})) / base).toBeLessThan(0.75)
    })
})
