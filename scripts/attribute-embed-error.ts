// Attribute the ONNX-q8 vs llama.cpp-Q8_0 disagreement: compare each against an
// fp32 ONNX reference of the same model. If both sit ~equally far from fp32, the
// gap is quantization noise on both sides (decorrelated); if one side is far off,
// that side's pipeline differs (tokenization/pooling), not just precision.
//
// Runs itself twice: parent = fp32 pass, child (RAG_DTYPE=q8) = q8 pass.

import {readChapters} from '../ingest/epub'
import {chunkChapter} from '../ingest/chunk'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8089'
const N = 8

function cosine(a: number[], b: number[]): number {
    let dot = 0
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
    return dot // both runtimes L2-normalize, so dot == cosine
}

const chapters = await readChapters()
const all = chapters.flatMap(chunkChapter)
const step = Math.floor(all.length / N)
const texts = Array.from({length: N}, (_, i) => all[i * step]!.text)

if (process.env.EMBED_CHILD) {
    const {embedDocuments} = await import('../src/ai/embedder')
    console.log(JSON.stringify(await embedDocuments(texts)))
    process.exit(0)
}

// Each dtype in its own child process — transformers.js caches the pipeline
// per-process, so two dtypes can't share one. fp16 is the reference: it exists
// in .models (verified) and fp16-vs-fp32 error is negligible for embeddings.
function onnxPass(dtype: string): number[][] {
    const child = Bun.spawnSync(['bun', 'run', import.meta.path], {
        env: {...process.env, EMBED_CHILD: '1', RAG_DTYPE: dtype},
        stdout: 'pipe'
    })
    return JSON.parse(child.stdout.toString().trim().split('\n').pop()!) as number[][]
}
const q8 = onnxPass('q8')
const fp32 = onnxPass('fp16')

const res = await fetch(`${LLAMA_URL}/v1/embeddings`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({input: texts})
})
const json = (await res.json()) as {data: {index: number; embedding: number[]}[]}
const llama = json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)

console.log('text          q8~fp16   llama~fp16   q8~llama')
const stats = {a: [] as number[], b: [] as number[], c: [] as number[]}
texts.forEach((_t, i) => {
    const a = cosine(q8[i]!, fp32[i]!)
    const b = cosine(llama[i]!, fp32[i]!)
    const c = cosine(q8[i]!, llama[i]!)
    stats.a.push(a)
    stats.b.push(b)
    stats.c.push(c)
    console.log(`chunk ${String(i).padStart(2)}     ${a.toFixed(5)}   ${b.toFixed(5)}      ${c.toFixed(5)}`)
})
const mean = (x: number[]) => (x.reduce((p, q) => p + q) / x.length).toFixed(5)
console.log(`mean         ${mean(stats.a)}   ${mean(stats.b)}      ${mean(stats.c)}`)
