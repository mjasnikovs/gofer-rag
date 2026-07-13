// Score-parity check: in-process ONNX q8 rerank vs the llama.cpp rerank box.
//
// The -4 refusal threshold was calibrated on ONNX q8 logits, so before evals
// trust the box we need the box's relevance_score to be the same number — same
// scale, same sign, small pairwise error, and (most importantly) no candidate
// flipping sides of the threshold.
//
// Run WITHOUT RAG_RERANK_URL (so rerank() takes the ONNX path) while the box is
// up, e.g.:
//   bun run scripts/rerank-box.ts sleep 600    # terminal 1 (box only)
//   bun run scripts/validate-llamacpp-rerank.ts # terminal 2
// or start the box by hand. The script talks to the box directly by URL.

import {gatherCandidates} from '../src/core/query'
import {loadEmbedder} from '../src/ai/embedder'
import {rerank, loadReranker} from '../src/ai/reranker'
import {loadTable} from '../src/store/db'
import {config} from '../src/config'

const boxUrl = process.env.RAG_RERANK_URL || `http://localhost:${config.rerankPort}`
if (config.rerankUrl) {
    console.error('unset RAG_RERANK_URL for this script — rerank() must take the ONNX path')
    process.exit(1)
}

// Mix of question shapes: symbol lookups, casual paraphrases (expansion path),
// and the two must-refuse off-topic probes whose margins the threshold protects.
const questions = [
    'What is a NavigationAgent2D used for?',
    'How do I detect when a body enters an Area2D?',
    'How to draw a rectangle?',
    "How do I save the player's progress so it persists between sessions?",
    'How do I make the enemy chase the player?',
    'Who won the FIFA World Cup in 2022?',
    'What is the best sourdough starter recipe?'
]

type BoxResponse = {results: {index: number; relevance_score: number}[]}

async function rerankBox(query: string, passages: string[]): Promise<number[]> {
    const res = await fetch(`${boxUrl}/v1/rerank`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query, documents: passages, top_n: passages.length})
    })
    if (!res.ok) throw new Error(`box request failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as BoxResponse
    const scores = new Array<number>(passages.length)
    for (const r of data.results) scores[r.index] = r.relevance_score
    return scores
}

await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

let pairs = 0
let maxDiff = 0
let sumDiff = 0
let flips = 0
let grayFlips = 0
let top1Disagreements = 0

for (const q of questions) {
    const {candidates, expansion} = await gatherCandidates(q)
    if (candidates.length === 0) continue
    const query = expansion ? `${q} ${expansion}` : q
    const texts = candidates.map(c => c.text)

    const tOnnx = performance.now()
    const onnx = await rerank(query, texts)
    const onnxMs = performance.now() - tOnnx
    const tBox = performance.now()
    const box = await rerankBox(query, texts)
    const boxMs = performance.now() - tBox

    let worst = 0
    for (let i = 0; i < texts.length; i++) {
        const diff = Math.abs(onnx[i]! - box[i]!)
        worst = Math.max(worst, diff)
        maxDiff = Math.max(maxDiff, diff)
        sumDiff += diff
        pairs++
        const t = config.rerankThreshold
        if (onnx[i]! >= t !== box[i]! >= t) {
            flips++
            // Gray zone is judged on the ONNX side — the calibrated reference.
            // Measured flips all had ONNX within ±0.5 of the threshold.
            if (Math.abs(onnx[i]! - t) <= 1) grayFlips++
            console.log(`  THRESHOLD FLIP: onnx ${onnx[i]!.toFixed(2)} vs box ${box[i]!.toFixed(2)} (${candidates[i]!.chapter})`)
        }
    }
    const top1Onnx = onnx.indexOf(Math.max(...onnx))
    const top1Box = box.indexOf(Math.max(...box))
    if (top1Onnx !== top1Box) top1Disagreements++

    console.log(
        `${q}\n  ${texts.length} candidates  onnx ${(onnxMs / 1000).toFixed(1)}s / box ${(boxMs / 1000).toFixed(1)}s  ` +
            `top1 onnx ${onnx[top1Onnx]!.toFixed(2)} box ${box[top1Box]!.toFixed(2)}  worst |Δ| ${worst.toFixed(3)}  ` +
            `top1 ${top1Onnx === top1Box ? 'agree' : 'DISAGREE'}`
    )
}

console.log(
    `\n${pairs} pairs: mean |Δ| ${(sumDiff / pairs).toFixed(3)}, max |Δ| ${maxDiff.toFixed(3)}, ` +
        `threshold flips ${flips}, top-1 disagreements ${top1Disagreements}`
)
// Perfect parity is impossible: ONNX q8 and GGUF Q8_0 are different
// quantizations of the same fp16 model, each with its own error, and the -4
// threshold has ONNX's error baked in. Measured 2026-07-13: mean |Δ| 0.34,
// flips confined to the ±1-logit gray zone around -4, refusal margins intact —
// and the binding test, eval-retrieval (10/10) + eval-paraphrase (21/22)
// through the box, matched the ONNX baselines exactly. So the gate here is
// scale sanity, not equality: fail on scale-level divergence or on a flip
// OUTSIDE the gray zone (a clear keep turning into a clear refusal or vice
// versa), which would mean the box no longer speaks the calibrated logit scale.
const grayZoneFlipsOnly = flips === grayFlips
const ok = sumDiff / pairs < 0.75 && grayZoneFlipsOnly
if (!grayZoneFlipsOnly) console.log('a candidate flipped OUTSIDE the ±1 gray zone around the threshold')
console.log(ok ? 'PASS — box logits track ONNX q8 within eval-validated tolerance' : 'FAIL — recalibrate before trusting the box')
process.exit(ok ? 0 : 1)
