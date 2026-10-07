// Capture the candidate pools once, replay every cut policy against them
// forever. This is the A/B harness the source comments have been citing since
// 2026-08-06 without it ever existing — see scripts/pools.ts for why that
// matters and what the fixture holds.
//
// Three phases, deliberately separate, because they want different hardware and
// because splitting them is what pins the expansions:
//
//   --pools    needs llama.cpp (query expansion), no reranker.
//              bun run scripts/capture-pools.ts --pools [--epochs 3]
//
//   --scores   needs the GPU rerank box, NOT llama.cpp. Reads the expansions
//              the pool phase recorded and never re-rolls them, so every later
//              arm is paired by construction (confound 1 in the
//              gofer-rag-ab-method notes: two captures of one unchanged corpus
//              differed in 182 of 225 pool memberships).
//              bun run scripts/rerank-box.ts bun run scripts/capture-pools.ts --scores --require-box
//
//   --recut    NO MODELS AT ALL. Replays the frozen pools through the current
//              default cut and rewrites the golden kept-sets. Run it whenever a
//              deliberate change to rankCandidates lands.
//              bun run scripts/capture-pools.ts --recut
//
// The expensive half (scores) freezes once. The cheap half (expected kept sets)
// regenerates offline in a second.

import {loadEmbedder} from '../src/ai/embedder'
import {rerank, loadReranker} from '../src/ai/reranker'
import {gatherCandidates, rankCandidates, defaultCut, defaultDependencies} from '../src/core/query'
import {loadTable, databaseInfo, symbolTokens} from '../src/store/db'
import {config} from '../src/config'
import {loadPools, savePools, rehydrate, scoresOf, strip, type CapturedPool, type PoolFile} from './pools'
import {cases as fundamentals} from './fundamentals-cases'
import {cases as realistic} from './realistic-cases'
import {cases as paraphrase} from './paraphrase-cases'
import {cases as retrieval} from './retrieval-cases'
import {writeFileSync, mkdirSync} from 'node:fs'

const FULL = '.pools/pools-full.ndjson'
const FIXTURE = 'test/fixtures/pools.ndjson'
const GOLDEN = 'test/fixtures/kept-default.json'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const epochs = Number(argv.find(a => a.startsWith('--epochs='))?.split('=')[1] ?? 1)
// --expansions-from=<pools file>: replay that capture's LLM expansions instead
// of asking the LLM. A re-capture of a changed store must see the same terms as
// the capture it is compared with, or every pool moves for a reason unrelated
// to the change (confound 1 in the A/B notes). Archive the file first — the
// pool phase overwrites .pools/pools-full.ndjson.
const expansionsFrom = argv.find(a => a.startsWith('--expansions-from='))?.split('=')[1]

// Every question once, carrying the set(s) it came from. Two questions appear in
// two sets each, and keying results by question text alone once let one set's
// outcome overwrite the other's — hence `suites` as a list.
function questions(): Map<string, string[]> {
    const all = new Map<string, string[]>()
    const add = (suite: string, list: {question: string}[]) => {
        for (const c of list) all.set(c.question, [...(all.get(c.question) ?? []), suite])
    }
    add('fundamentals', fundamentals)
    add('paraphrase', paraphrase)
    add('retrieval', retrieval)
    add('realistic', realistic)
    return all
}

// A case with no `expect` is one that must be refused. Those are excluded from
// the starvation check below: expandQuery rejects a reply that is not a term
// list, and an off-topic question is exactly the input that produces one, so an
// empty expansion there is the design working rather than the model being down.
function offTopic(): Set<string> {
    return new Set([...retrieval, ...realistic].filter(c => c.expect === undefined).map(c => c.question))
}

async function capturePools(): Promise<void> {
    await Promise.all([loadEmbedder(), loadTable()])
    const asked = questions()
    const pools: CapturedPool[] = []
    const pinned = expansionsFrom ? loadPools(expansionsFrom).pools : undefined

    for (let epoch = 0; epoch < epochs; epoch++) {
        for (const [question, suites] of asked) {
            const old = pinned?.find(p => p.question === question && p.epoch === epoch)
            if (pinned && !old) throw new Error(`${expansionsFrom} has no pool for epoch ${epoch}: ${question}`)
            const dependencies =
                old ? {...defaultDependencies, expandQuery: () => Promise.resolve(old.expansion)} : undefined
            const {candidates, expansion, titles} = await gatherCandidates(question, dependencies)
            // Titles decide whether expansion runs at all, so a pinned expansion
            // is only the same input if the titles are the same too.
            if (old && JSON.stringify(titles) !== JSON.stringify(old.titles))
                throw new Error(`titles moved for "${question}": ${old.titles.join(', ')} -> ${titles.join(', ')}`)
            const symbols = symbolTokens(question)
            pools.push({
                question,
                suites,
                epoch,
                expansion,
                titles,
                symbols,
                candidates: candidates.map(c => ({
                    id: c.id,
                    chapter: c.chapter,
                    order: c.order,
                    textChars: c.text.length,
                    has: symbols.filter(symbol => c.text.includes(symbol)),
                    text: c.text
                }))
            })
        }
        if (verbose) console.log(`epoch ${epoch}: ${asked.size} pools`)
    }

    savePools(FULL, {
        stamp: {
            capturedAt: new Date().toISOString(),
            packageVersion: process.env.npm_package_version ?? 'dev',
            backend: 'unscored',
            rerankThreshold: config.rerankThreshold,
            prefilterKeep: config.prefilterKeep,
            corpusRows: (await databaseInfo()).rows,
            embedModel: config.embedModel
        },
        pools
    })

    // A shared 27B under load returns no expansion and says so once per process.
    // A capture taken while it was starved is contaminated and every arm read
    // off it is worthless, so make that loud rather than discovering it later.
    const refusable = offTopic()
    const answerable = pools.filter(p => p.titles.length === 0 && !refusable.has(p.question))
    const starved = answerable.filter(p => p.expansion === '')
    console.log(`pools: ${pools.length} written to ${FULL} (${asked.size} questions x ${epochs} epoch(s))`)
    console.log(
        `expansion: ${answerable.length - starved.length}/${answerable.length} answerable title-less questions expanded`
    )
    if (starved.length > 2) {
        console.error(`CONTAMINATED — ${starved.length} answerable questions got no expansion, so the`)
        console.error('model was starved. Wait for localhost:8080/slots to idle and re-run.')
        for (const p of starved) console.error(`  ${p.question}`)
        process.exit(1)
    }
}

async function captureScores(): Promise<void> {
    if (argv.includes('--require-box') && !config.rerankUrl) {
        console.error('--require-box: RAG_RERANK_URL is unset, so this would silently run the ~20s/query')
        console.error('in-process CPU reranker and change the backend inside the arm. Refusing.')
        process.exit(1)
    }
    await loadReranker()
    const file = loadPools(FULL)
    let done = 0
    for (const pool of file.pools) {
        const text = pool.expansion ? `${pool.question} ${pool.expansion}` : pool.question
        const scores = await rerank(
            text,
            pool.candidates.map(c => c.text ?? '')
        )
        pool.candidates.forEach((candidate, i) => (candidate.score = scores[i]!))
        done++
        if (verbose) console.log(`${done}/${file.pools.length}  ${pool.question}`)
    }
    file.stamp.backend = config.rerankUrl ? 'box' : 'onnx'
    file.stamp.capturedAt = new Date().toISOString()
    // The committed fixture replaces each chunk's text with the question symbols
    // it contained. That is lossless for how rankCandidates reads text TODAY,
    // and this is where that claim gets checked — the full text is in hand right
    // now and never will be again. A future change that reads text differently
    // fails here rather than silently encoding a wrong golden file.
    let drift = 0
    for (const pool of file.pools) {
        const scores = scoresOf(pool)
        const real = pool.candidates.map(c => ({
            id: c.id,
            vector: [] as number[],
            text: c.text ?? '',
            chapter: c.chapter,
            order: c.order
        }))
        const key = (chunks: {id: string; pinned?: true}[]) =>
            chunks.map(c => `${c.id}${c.pinned ? 'P' : ''}`).join(',')
        const a = key(rankCandidates(pool.question, real, scores, pool.titles, defaultCut()))
        const b = key(rankCandidates(pool.question, pool.candidates.map(rehydrate), scores, pool.titles, defaultCut()))
        if (a !== b) {
            drift++
            console.error(`RECONSTRUCTION DRIFT  ${pool.question}\n  real    ${a}\n  compact ${b}`)
        }
    }
    if (drift > 0) {
        console.error(`${drift} pool(s) behave differently once text is compacted — the fixture would be a lie.`)
        process.exit(1)
    }
    console.log(`reconstruction: faithful on all ${file.pools.length} pools`)

    savePools(FULL, file)
    // Only epoch 0 is committed. The extra epochs exist to answer one question —
    // does an arm's reading move when the expansion is re-rolled — and that is a
    // measurement run from .pools/, not a fixture the test suite needs to carry.
    savePools(FIXTURE, strip({stamp: file.stamp, pools: file.pools.filter(pool => pool.epoch === 0)}))
    console.log(`scores: ${done} pools scored on the ${file.stamp.backend} backend`)
    console.log(`fixture: ${FIXTURE} (epoch 0 only), full capture kept at ${FULL}`)
}

// The golden kept-sets. Regenerating these is the ONLY sanctioned way to change
// what test/cut.test.ts expects — if a diff here was not intended, the refactor
// moved the default path and that is the bug the fixture exists to catch.
function recut(): void {
    const file: PoolFile = loadPools(FIXTURE)
    const golden: Record<string, string[]> = {}
    for (const pool of file.pools) {
        if (pool.epoch !== 0) continue
        const kept = rankCandidates(
            pool.question,
            pool.candidates.map(rehydrate),
            scoresOf(pool),
            pool.titles,
            defaultCut()
        )
        golden[pool.question] = kept.map(c => `${c.id}${c.pinned ? ' pinned' : ''}`)
    }
    mkdirSync('test/fixtures', {recursive: true})
    writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 4)}\n`)
    const sizes = Object.values(golden).map(k => k.length)
    console.log(
        `recut: ${sizes.length} questions, mean ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2)} kept`
    )
}

if (argv.includes('--pools')) await capturePools()
else if (argv.includes('--scores')) await captureScores()
else if (argv.includes('--recut')) recut()
else {
    console.error('usage: capture-pools.ts (--pools [--epochs=N] | --scores [--require-box] | --recut) [--verbose]')
    process.exit(1)
}
