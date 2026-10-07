// Validation: are llama.cpp (GGUF Q8_0) document embeddings compatible with the
// transformers.js (ONNX q8) embeddings the host uses for queries at serve time?
//
// Embeds the same real chunks through both runtimes and reports cosine similarity
// per text, plus a retrieval sanity check: does a transformers.js *query* vector
// rank the llama.cpp *document* vectors in the same order as the all-ONNX setup?
//
// Usage: LLAMA_URL=http://localhost:8089 bun run scripts/validate-llamacpp-embed.ts
//
// Exits 1 below MIN_COSINE: the stored vectors are only usable if the two
// runtimes agree (EmbeddingGemma 2 measured ≥ 0.9991 on all 7671 chunks).

import {embedDocuments, embedQuery} from '../src/ai/embedder'
import {readChapters} from '../ingest/epub'
import {chunkChapter} from '../ingest/chunk'
import {documentText} from '../src/ai/prompts'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8089'
const N = 24
const MIN_COSINE = 0.999

async function llamaEmbed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${LLAMA_URL}/v1/embeddings`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({input: texts})
    })
    if (!res.ok) throw new Error(`llama.cpp ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as {data: {index: number; embedding: number[]}[]}
    return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

function cosine(a: number[], b: number[]): number {
    let dot = 0,
        na = 0,
        nb = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!
        na += a[i]! * a[i]!
        nb += b[i]! * b[i]!
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Real chunks from the EPUB, spread across the book, varied lengths.
const chapters = await readChapters()
const all = chapters.flatMap(chunkChapter)
const step = Math.floor(all.length / N)
const texts = Array.from({length: N}, (_, i) => documentText(all[i * step]!.chapter, all[i * step]!.text))
console.log(
    `comparing ${texts.length} real chunks (lengths ${Math.min(...texts.map(t => t.length))}–${Math.max(...texts.map(t => t.length))} chars)`
)

const [onnx, llama] = await Promise.all([embedDocuments(texts), llamaEmbed(texts)])
if (llama[0]!.length !== onnx[0]!.length)
    throw new Error(`dim mismatch: llama.cpp ${llama[0]!.length} vs onnx ${onnx[0]!.length}`)

const sims = texts.map((_, i) => cosine(onnx[i]!, llama[i]!))
sims.forEach((s, i) =>
    console.log(`  chunk ${String(i).padStart(2)}: cosine ${s.toFixed(6)} (${texts[i]!.length} chars)`)
)
console.log(`min ${Math.min(...sims).toFixed(6)}  mean ${(sims.reduce((a, b) => a + b) / sims.length).toFixed(6)}`)

// Retrieval sanity: an ONNX query vector must rank llama.cpp doc vectors the same
// way it ranks ONNX doc vectors, or mixed-runtime retrieval would silently drift.
const query = await embedQuery('How do I connect a signal to a method in GDScript?')
const rank = (docs: number[][]) =>
    docs
        .map((d, i) => ({i, s: cosine(query, d)}))
        .sort((a, b) => b.s - a.s)
        .map(x => x.i)
const rankOnnx = rank(onnx)
const rankLlama = rank(llama)
console.log(`query-ranking (onnx docs):  ${rankOnnx.slice(0, 8).join(',')}`)
console.log(`query-ranking (llama docs): ${rankLlama.slice(0, 8).join(',')}`)
console.log(
    `top-5 sets identical: ${JSON.stringify(rankOnnx.slice(0, 5).sort()) === JSON.stringify(rankLlama.slice(0, 5).sort())}`
)
if (Math.min(...sims) < MIN_COSINE) {
    console.error(`FAIL: min cosine ${Math.min(...sims).toFixed(6)} < ${MIN_COSINE}`)
    process.exit(1)
}
