// Paired A/B over the frozen pools for ONE question: where does the
// nothing-found floor belong?
//
//   bun run scripts/ab-floor.ts             the table
//   bun run scripts/ab-floor.ts --verbose   which questions each floor changes
//
// The defect this answers, from Gofer's live turns on 2026-09-11: "gofer
// node.set_cells cell parameter atlas source format" asks about a Gofer tool,
// not a Godot class, and came back with an unrelated passage at -1.75 after
// 13 s. Nothing in the pipeline says "the best thing here is not an answer" —
// rerankThreshold is -4, which is a floor under the COMPANION passages, not
// under the answer itself.
//
// Stated before the numbers exist, so this is a test and not a fishing trip:
// the report asks for a floor at 0. A floor at 0 is predicted to cost real
// answers, because the four casual sets (paraphrase, realistic) exist precisely
// to hold questions whose right chapter is reached through LLM expansion and
// scores just above the gate. If some floor below 0 buys the same refusals for
// nothing, that is the answer; if 0 costs nothing, ship 0.
//
// Same fixture and the same three confounds ab-cut.ts kills: the pools carry
// frozen expansions, frozen case membership and frozen scores, so every arm
// sees identical inputs. Three epochs exist so an arm that moves between them
// can be recognised as expansion noise rather than an effect.

import {rankCandidates, defaultCut} from '../src/core/query'
import {loadPools, rehydrate, scoresOf, type CapturedPool} from './pools'
import {cases as fundamentals} from './fundamentals-cases'
import {cases as realistic} from './realistic-cases'
import {cases as paraphrase} from './paraphrase-cases'
import {cases as retrieval} from './retrieval-cases'
import {existsSync} from 'node:fs'

const verbose = process.argv.includes('--verbose')
const FULL = '.pools/pools-full.ndjson'
const {stamp, pools} = loadPools(existsSync(FULL) ? FULL : 'test/fixtures/pools.ndjson')

type Expectation = {expect?: RegExp; refuse: boolean}
const expectations = new Map<string, Map<string, Expectation>>()
const note = (suite: string, question: string, expect?: RegExp) => {
    if (!expectations.has(suite)) expectations.set(suite, new Map())
    expectations.get(suite)!.set(question, {expect, refuse: expect === undefined})
}
for (const c of fundamentals) note('fundamentals', c.question, c.expect)
for (const c of paraphrase) note('paraphrase', c.question, c.expect)
for (const c of retrieval) note('retrieval', c.question, c.expect)
for (const c of realistic) note('realistic', c.question, c.expect)

const suites = ['retrieval', 'paraphrase', 'fundamentals', 'realistic']

type Reading = {
    present: Map<string, {hit: number; of: number}>
    refusalsHeld: number
    refusalsOf: number
    losses: string[]
    gains: string[]
}

const run = (pool: CapturedPool, answerFloor: number) =>
    rankCandidates(pool.question, pool.candidates.map(rehydrate), scoresOf(pool), pool.titles, {
        ...defaultCut(),
        answerFloor
    })

function measure(answerFloor: number, epoch: number): Reading {
    const r: Reading = {present: new Map(), refusalsHeld: 0, refusalsOf: 0, losses: [], gains: []}
    for (const pool of pools) {
        if (pool.epoch !== epoch) continue
        const kept = run(pool, answerFloor)
        const before = run(pool, Number.NEGATIVE_INFINITY)
        for (const suite of pool.suites) {
            const expectation = expectations.get(suite)?.get(pool.question)
            if (!expectation) continue
            if (expectation.refuse) {
                r.refusalsOf++
                if (kept.length === 0) r.refusalsHeld++
                if (kept.length === 0 && before.length > 0) r.gains.push(`${suite}: ${pool.question}`)
                continue
            }
            const slot = r.present.get(suite) ?? {hit: 0, of: 0}
            slot.of++
            if (kept.some(c => expectation.expect!.test(c.chapter))) slot.hit++
            else if (before.some(c => expectation.expect!.test(c.chapter)))
                r.losses.push(`${suite}: ${pool.question}  (best ${before[0]!.score.toFixed(2)})`)
            r.present.set(suite, slot)
        }
    }
    return r
}

const floors = [Number.NEGATIVE_INFINITY, -2, -1, -0.5, -0.25, 0, 0.5]
const epochs = [...new Set(pools.map(p => p.epoch))].sort()
const label = (floor: number) => (Number.isFinite(floor) ? floor.toFixed(2) : 'off')

console.log(
    `pools: ${pools.length} (${epochs.length} epoch(s)), backend ${stamp.backend}, corpus ${stamp.corpusRows} rows\n`
)

const widths = [6, 10, 11, 13, 10, 8]
const row = (cells: (string | number)[]) => cells.map((c, i) => String(c).padStart(widths[i] ?? 8)).join(' ')
console.log(row(['floor', ...suites, 'refuse']))
for (const floor of floors) {
    const r = measure(floor, 0)
    console.log(
        row([
            label(floor),
            ...suites.map(s => {
                const slot = r.present.get(s)
                return slot ? `${slot.hit}/${slot.of}` : '-'
            }),
            `${r.refusalsHeld}/${r.refusalsOf}`
        ])
    )
}

// An arm whose numbers move between epochs is inside the expansion noise floor
// and is not evidence. Only epoch 0 is committed as the fixture.
if (epochs.length > 1) {
    console.log('\nstability across epochs (suite hits then refusals, epoch 0 / 1 / ...):')
    for (const floor of floors) {
        const perEpoch = epochs.map(e => {
            const r = measure(floor, e)
            return `${suites.map(s => r.present.get(s)?.hit ?? 0).join('-')}/${r.refusalsHeld}`
        })
        console.log(
            `  ${new Set(perEpoch).size === 1 ? '  ' : '!!'} ${label(floor).padStart(5)}  ${perEpoch.join('  |  ')}`
        )
    }
    console.log('  !! = moves between epochs, so the difference is expansion noise, not the floor')
}

if (verbose) {
    for (const floor of floors.slice(1)) {
        const r = measure(floor, 0)
        console.log(`\nfloor ${label(floor)}: +${r.gains.length} refusals, -${r.losses.length} answers`)
        for (const g of r.gains) console.log(`    gained  ${g}`)
        for (const l of r.losses) console.log(`    lost    ${l}`)
    }
}
