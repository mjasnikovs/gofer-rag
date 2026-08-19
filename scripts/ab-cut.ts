// Paired A/B over the frozen pools: every cut arm, every captured question, no
// models. Seconds, not the 5.5 contended-GPU minutes an eval arm costs, and
// exactly paired — same pools, same scores, same expansions in every arm.
//
//   bun run scripts/ab-cut.ts             summary tables
//   bun run scripts/ab-cut.ts --verbose   per-question losses, and the rescued group
//
// WHAT THIS CAN AND CANNOT SAY. It measures the cut and only the cut. Nothing
// upstream of rerank is observable through frozen pools, and the LLM refusal
// gate is not replayable — an off-topic reading here is the reranker threshold
// alone, which is why eval-realistic runs those through the full query().
//
// Stated before the numbers exist, so this is a test and not a fishing trip: a
// GLOBAL maxGap is predicted to cost paraphrase and realistic cases, because
// those two sets exist precisely to hold questions whose right answer ranks 3-5.
// A TITLE-GATED gap should not touch paraphrase at all — that set is title-less
// by construction. If an arm costs zero across all four sets and saves >= 25% of
// the bytes, it is worth a follow-up proposal; otherwise the family is closed
// and this file is the record of it.

import {rankCandidates, defaultCut, type CutPolicy} from '../src/core/query'
import {loadPools, rehydrate, scoresOf, type CapturedPool} from './pools'
import {cases as fundamentals} from './fundamentals-cases'
import {cases as realistic} from './realistic-cases'
import {cases as paraphrase} from './paraphrase-cases'
import {cases as retrieval} from './retrieval-cases'
import type {RankedChunk} from '../src/types'
import {existsSync} from 'node:fs'

const verbose = process.argv.includes('--verbose')
// The committed fixture carries epoch 0 only. When the full multi-epoch capture
// is still on disk, use it — the stability block below is the whole reason the
// extra epochs were captured.
const FULL = '.pools/pools-full.ndjson'
const {stamp, pools} = loadPools(existsSync(FULL) ? FULL : 'test/fixtures/pools.ndjson')

type Arm = {label: string; policy: (pool: CapturedPool) => CutPolicy}

const fixed = (label: string, overrides: Partial<CutPolicy>): Arm => ({
    label,
    policy: () => ({...defaultCut(), ...overrides})
})

const arms: Arm[] = [
    fixed('baseline', {}),
    fixed('max 5', {maxPassages: 5}),
    fixed('max 4', {maxPassages: 4}),
    fixed('max 3', {maxPassages: 3}),
    fixed('max 2', {maxPassages: 2}),
    fixed('gap 2.5', {maxGap: 2.5}),
    fixed('gap 2.0', {maxGap: 2.0}),
    fixed('gap 1.5', {maxGap: 1.5}),
    fixed('gap 1.0', {maxGap: 1.0}),
    // 110 of the consumer's 130 real queries name a chapter verbatim; those are
    // the class-ref lookups where rank 4-5 spill is pure noise. eval-paraphrase
    // is title-less by construction, so this arm cannot reach it.
    {
        label: 'gap 1.5 if titled',
        policy: pool => ({...defaultCut(), maxGap: pool.titles.length > 0 ? 1.5 : Number.POSITIVE_INFINITY})
    },
    {
        label: 'gap 2.0 if titled',
        policy: pool => ({...defaultCut(), maxGap: pool.titles.length > 0 ? 2.0 : Number.POSITIVE_INFINITY})
    },
    fixed('max 3 + gap 1.5', {maxPassages: 3, maxGap: 1.5}),
    // The counterfactual for the pin budget in rankCandidates. pinReserve 0 is
    // "just take the top N by score" — what a consumer's slice would have done
    // if the pins had not been there to lose.
    fixed('max 4, no pin slot', {maxPassages: 4, pinReserve: 0}),
    fixed('max 3, no pin slot', {maxPassages: 3, pinReserve: 0}),
    fixed('max 2, no pin slot', {maxPassages: 2, pinReserve: 0})
]

// Expectations live in the case modules, never in the fixture: a RegExp does not
// serialize, and freezing them beside the pools would let the two drift.
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

const run = (pool: CapturedPool, cut: CutPolicy): RankedChunk[] =>
    rankCandidates(pool.question, pool.candidates.map(rehydrate), scoresOf(pool), pool.titles, cut)

const charsOf = (pool: CapturedPool, kept: RankedChunk[]): number => {
    const byId = new Map(pool.candidates.map(c => [c.id, c.textChars]))
    return kept.reduce((n, c) => n + (byId.get(c.id) ?? 0), 0)
}

type Reading = {
    passages: number
    chars: number
    pins: number
    calls: number
    present: Map<string, {hit: number; of: number}>
    topThree: {hit: number; of: number}
    refusalsHeld: number
    refusalsOf: number
    losses: string[]
}

function measure(arm: Arm, epoch: number): Reading {
    const r: Reading = {
        passages: 0,
        chars: 0,
        pins: 0,
        calls: 0,
        present: new Map(),
        topThree: {hit: 0, of: 0},
        refusalsHeld: 0,
        refusalsOf: 0,
        losses: []
    }
    for (const pool of pools) {
        if (pool.epoch !== epoch) continue
        const kept = run(pool, arm.policy(pool))
        r.calls++
        r.passages += kept.length
        r.chars += charsOf(pool, kept)
        r.pins += kept.filter(c => c.pinned).length

        for (const suite of pool.suites) {
            const expectation = expectations.get(suite)?.get(pool.question)
            if (!expectation) continue
            if (expectation.refuse) {
                r.refusalsOf++
                if (kept.length === 0) r.refusalsHeld++
                continue
            }
            const slot = r.present.get(suite) ?? {hit: 0, of: 0}
            slot.of++
            const hit = kept.some(c => expectation.expect!.test(c.chapter))
            if (hit) slot.hit++
            else r.losses.push(`${suite}: ${pool.question}`)
            r.present.set(suite, slot)
            if (suite === 'fundamentals') {
                r.topThree.of++
                if (kept.slice(0, 3).some(c => expectation.expect!.test(c.chapter))) r.topThree.hit++
            }
        }
    }
    return r
}

const suites = ['retrieval', 'paraphrase', 'fundamentals', 'realistic']
const epochs = [...new Set(pools.map(p => p.epoch))].sort()

console.log(`pools: ${pools.length} (${epochs.length} epoch(s)), backend ${stamp.backend}, corpus ${stamp.corpusRows} rows\n`)

const base = measure(arms[0]!, 0)
const header = ['arm', 'psg/call', 'chars', '% bytes', 'pins', ...suites.map(s => s.slice(0, 5)), 'top3', 'refuse']
const widths = [18, 8, 8, 7, 5, 9, 10, 12, 9, 5, 6]
const row = (cells: (string | number)[]) => cells.map((c, i) => String(c).padStart(widths[i] ?? 8)).join(' ')
console.log(row(header))

const readings = new Map<string, Reading>()
for (const arm of arms) {
    const r = measure(arm, 0)
    readings.set(arm.label, r)
    console.log(
        row([
            arm.label,
            (r.passages / r.calls).toFixed(2),
            r.chars,
            `${((100 * r.chars) / base.chars).toFixed(0)}%`,
            r.pins,
            ...suites.map(s => {
                const slot = r.present.get(s)
                return slot ? `${slot.hit}/${slot.of}` : '-'
            }),
            `${r.topThree.hit}/${r.topThree.of}`,
            `${r.refusalsHeld}/${r.refusalsOf}`
        ])
    )
}

// An arm whose suite scores move between epochs is inside the expansion noise
// floor, and its number is not evidence. Only epoch 0 is committed as the
// fixture; the rest exist to answer exactly this question.
if (epochs.length > 1) {
    console.log('\nstability across epochs (present counts per suite, epoch 0 / 1 / ...):')
    for (const arm of arms) {
        const perEpoch = epochs.map(e => {
            const r = measure(arm, e)
            return suites.map(s => r.present.get(s)?.hit ?? 0).join('-')
        })
        const stable = new Set(perEpoch).size === 1
        console.log(`  ${stable ? '  ' : '!!'} ${arm.label.padEnd(18)} ${perEpoch.join('  |  ')}`)
    }
    console.log('  !! = moves between epochs, so the difference is expansion noise, not the arm')
}

if (verbose) {
    console.log('\nlosses vs baseline:')
    const baseLosses = new Set(base.losses)
    for (const arm of arms.slice(1)) {
        const extra = readings.get(arm.label)!.losses.filter(l => !baseLosses.has(l))
        console.log(`\n  ${arm.label}: ${extra.length} new`)
        for (const l of extra) console.log(`    ${l}`)
    }

    // The group diag-gap.ts was written to protect: questions the -4 threshold
    // rescued, whose tops sit near -3. A cut must not take these down to nothing
    // useful.
    console.log('\nrescued group (baseline top score below 0):')
    for (const pool of pools.filter(p => p.epoch === 0)) {
        const kept = run(pool, defaultCut())
        if (kept.length === 0 || kept[0]!.score >= 0) continue
        console.log(`  ${pool.question}`)
        for (const c of kept) console.log(`    ${c.score.toFixed(2)}  gap ${(kept[0]!.score - c.score).toFixed(2)}  ${c.chapter}${c.pinned ? '  [pin]' : ''}`)
    }
}
