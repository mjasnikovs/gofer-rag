// Programmatic retrieval coverage: extract every documented entity (class,
// method, property, signal, constant) from the corpus itself, ask a templated
// question about each, and check the entity's own documentation comes back.
//
// The inventory is grepped from LanceDB chunk text — class-ref pages open with
// "ClassName\nInherits:" and every documented member line ends with a 🔗 anchor
// — so the test needs no hand-written question list and covers the whole corpus.
//
// Cost model (measured 2026-07-13): candidate stage (embed + vector + FTS) is
// ~0.12s/query, so the whole corpus is testable; the reranker is ~13s/query on
// CPU, so it is only estimated on a random sample (--rerank N).
//
//   bun run scripts/eval-coverage.ts                      # all classes + 1000-member sample
//   bun run scripts/eval-coverage.ts --members all        # full 27k member sweep (~1h)
//   bun run scripts/eval-coverage.ts --rerank 25          # + end-to-end retrieve() on 25 samples
//   bun run scripts/eval-coverage.ts --lowercase          # class names typed lowercase ("sprite2d")
//   bun run scripts/eval-coverage.ts --verbose            # per-kind breakdown, progress, all misses
//
// Quiet by default: one summary line, exit 1 on fail. The candidate stage is
// the verdict — it must reach 100% (97% under --lowercase, where the ~46
// single-English-word class misses are accepted). The --rerank block is an
// end-to-end estimate/diagnostic and never affects the exit code.
//
// PASS (candidate stage) = the hybrid candidate pool (vector vectorTopK ∪ FTS
// ftsTopK, exactly what retrieve() reranks) contains a chunk from the entity's
// chapter — for members, one that also mentions the member's name.

import {embedQuery, loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieve} from '../src/core/query'
import {loadTable, vectorSearch, ftsSearch, titleSearch} from '../src/store/db'
import {config} from '../src/config'
import * as lancedb from '@lancedb/lancedb'
import type {StoredChunk} from '../src/types'

type Kind = 'class' | 'method' | 'signal' | 'property' | 'constant'
type Entity = {kind: Kind; cls: string; name: string; question: string}

// --- CLI args ---------------------------------------------------------------
const argv = process.argv.slice(2)
const argOf = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
}
const memberArg = argOf('--members') ?? '1000'
const rerankSample = Number(argOf('--rerank') ?? 0)
// --lowercase: type class names the way a casual user does ("sprite2d").
// Exercises the case-insensitive branch of titleSearch; single-English-word
// classes (Control, Timer, ...) are expected casualties — they stay
// case-sensitive by design (see distinctiveTitle in src/store/db.ts).
const lowercase = argv.includes('--lowercase')
const verbose = argv.includes('--verbose')
// Candidate-stage pass threshold. Baseline is 100%; --lowercase accepts the
// ~46 single-English-word class misses, so it floors at 97%.
const COVERAGE_MIN_PCT = lowercase ? 97 : 100

// Deterministic RNG so a rerun samples the same entities.
function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
const rng = mulberry32(42)
const sample = <T>(arr: T[], n: number): T[] => {
    const copy = [...arr]
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
    }
    return copy.slice(0, n)
}

// --- inventory from the corpus ------------------------------------------------
if (verbose) console.log('Building entity inventory from LanceDB ...')
const db = await lancedb.connect(config.dbPath)
const table = await db.openTable(config.table)
const rows = (await table.query().select(['chapter', 'text']).toArray()) as {chapter: string; text: string}[]

const classChapters = new Set<string>()
for (const r of rows) {
    if (/^[A-Z][A-Za-z0-9]*$/.test(r.chapter) && r.text.includes(`${r.chapter}\nInherits:`)) classChapters.add(r.chapter)
}

// Parse 🔗-anchored member lines. Formats seen in the corpus:
//   Color get_accent_color() const            → method
//   target_reached()                          → signal (no return type)
//   bool exclude_parent = true                → property
//   RESOLVER_MAX_QUERIES = 256                → constant
function parseMember(line: string): {kind: Kind; name: string} | null {
    const method = line.match(/^(?:[\w[\].]+\s+)(\w+)\s*\(/)
    if (method) return {kind: 'method', name: method[1]!}
    const signal = line.match(/^(\w+)\s*\(/)
    if (signal) return {kind: 'signal', name: signal[1]!}
    const constant = line.match(/^([A-Z][A-Z0-9_]+)\s*=/)
    if (constant) return {kind: 'constant', name: constant[1]!}
    const property = line.match(/^[\w[\].]+\s+(\w+)(?:\s*=.*)?$/)
    if (property) return {kind: 'property', name: property[1]!}
    return null
}

const question = (e: {kind: Kind; cls: string; name: string}): string => {
    const cls = lowercase ? e.cls.toLowerCase() : e.cls
    switch (e.kind) {
        case 'class':
            return `What is ${cls} used for in Godot?`
        case 'method':
            return `What does the ${e.name}() method of ${cls} do?`
        case 'signal':
            return `When is the ${e.name} signal of ${cls} emitted?`
        case 'property':
            return `What does the ${e.name} property of ${cls} control?`
        case 'constant':
            return `What is the ${e.name} constant of ${cls}?`
    }
}

const seen = new Set<string>()
const members: Entity[] = []
for (const r of rows) {
    if (!classChapters.has(r.chapter)) continue
    for (const m of r.text.matchAll(/^(.{2,140}) 🔗\s*$/gm)) {
        const parsed = parseMember(m[1]!.trim())
        if (!parsed) continue
        const key = `${r.chapter}.${parsed.name}`
        if (seen.has(key)) continue
        seen.add(key)
        members.push({...parsed, cls: r.chapter, question: question({...parsed, cls: r.chapter})})
    }
}
const classes: Entity[] = [...classChapters].map(cls => ({kind: 'class', cls, name: cls, question: question({kind: 'class', cls, name: cls})}))

const kindCount = (es: Entity[]) => {
    const c = new Map<Kind, number>()
    for (const e of es) c.set(e.kind, (c.get(e.kind) ?? 0) + 1)
    return [...c.entries()].map(([k, n]) => `${k}:${n}`).join(' ')
}
if (verbose) console.log(`inventory: ${classes.length} classes, ${members.length} unique members (${kindCount(members)})`)

const testSet = [...classes, ...(memberArg === 'all' ? members : sample(members, Number(memberArg)))]
if (verbose) console.log(`testing ${testSet.length} entities (members: ${memberArg})`)

// --- candidate-stage sweep ----------------------------------------------------
if (verbose) console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadTable(), rerankSample > 0 ? loadReranker() : Promise.resolve()])

async function candidatePool(q: string): Promise<StoredChunk[]> {
    const vector = await embedQuery(q)
    const [vec, fts, titles] = await Promise.all([
        vectorSearch(vector, config.vectorTopK),
        ftsSearch(q, config.ftsTopK),
        titleSearch(q, config.titleTopK)
    ])
    return [...new Map(vec.concat(fts, titles).map(c => [c.id, c])).values()]
}

const failures: Entity[] = []
const passByKind = new Map<Kind, {pass: number; total: number}>()
const t0 = performance.now()
for (const [i, e] of testSet.entries()) {
    const pool = await candidatePool(e.question)
    const pass =
        e.kind === 'class'
            ? pool.some(c => c.chapter === e.cls)
            : pool.some(c => c.chapter === e.cls && c.text.includes(e.name))
    const s = passByKind.get(e.kind) ?? {pass: 0, total: 0}
    s.total++
    if (pass) s.pass++
    else failures.push(e)
    passByKind.set(e.kind, s)
    if (verbose && (i + 1) % 250 === 0) {
        const rate = (performance.now() - t0) / (i + 1)
        console.log(`  ${i + 1}/${testSet.length}  (${(rate / 1000).toFixed(2)}s/query, ~${Math.round(((testSet.length - i - 1) * rate) / 60000)}min left)`)
    }
}

if (verbose) {
    console.log('\n=== candidate-stage coverage (pool = what the reranker would see) ===')
    for (const [kind, s] of passByKind) {
        console.log(`${kind.padEnd(9)} ${s.pass}/${s.total}  (${((100 * s.pass) / s.total).toFixed(1)}%)`)
    }
}
const total = [...passByKind.values()].reduce((a, s) => ({pass: a.pass + s.pass, total: a.total + s.total}), {pass: 0, total: 0})
const pct = (100 * total.pass) / total.total
const ok = pct >= COVERAGE_MIN_PCT
if (verbose) console.log(`overall   ${total.pass}/${total.total}  (${pct.toFixed(1)}%)`)

// Show the misses when the suite actually fails, or on --verbose. On a passing
// --lowercase run the accepted single-word misses stay hidden.
if (failures.length > 0 && (!ok || verbose)) {
    console.log(`\nfailures (${failures.length}):`)
    for (const f of failures.slice(0, 40)) console.log(`  [${f.kind}] ${f.cls}.${f.name} — "${f.question}"`)
    if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`)
}

const label = lowercase ? 'coverage-lowercase' : 'coverage'
console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}  ${total.pass}/${total.total} candidate ${pct.toFixed(1)}% (min ${COVERAGE_MIN_PCT}%)`)

// --- end-to-end estimate on a sample (includes the reranker + threshold gate) --
if (rerankSample > 0) {
    console.log(`\n=== end-to-end retrieve() on ${rerankSample} random entities (rerank + threshold) ===`)
    let pass = 0
    for (const e of sample(testSet, rerankSample)) {
        const kept = await retrieve(e.question)
        const ok = e.kind === 'class' ? kept.some(c => c.chapter === e.cls) : kept.some(c => c.chapter === e.cls && c.text.includes(e.name))
        if (ok) pass++
        else console.log(`  MISS [${e.kind}] ${e.cls}.${e.name} → kept: ${kept.map(c => c.chapter).join(' | ') || '(refused)'}`)
    }
    console.log(`end-to-end: ${pass}/${rerankSample} pass`)
}

// Exit code reflects the candidate-stage verdict only; the --rerank estimate
// above is a diagnostic.
process.exit(ok ? 0 : 1)
