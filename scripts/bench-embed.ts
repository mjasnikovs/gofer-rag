// Benchmark document embedding throughput, mirroring ingest.ts exactly:
// first N chunks of the EPUB, shortest-first ordering, batches of 32.
//
//   MODE=llama LLAMA_URL=http://localhost:8089 bun run scripts/bench-embed.ts
//   MODE=onnx RAG_DEVICE=cuda RAG_DTYPE=fp16 bun run scripts/bench-embed.ts   (inside the box)
//
// Known baseline to beat: ~432s for 300 chunks, ONNX q8 on host CPU.

import {readChapters} from '../ingest/epub'
import {chunkChapter} from '../ingest/chunk'

const MODE = process.env.MODE ?? 'llama'
const N = Number(process.env.BENCH_CHUNKS) || 300
const BATCH = Number(process.env.RAG_BATCH) || 32
const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8089'

const chapters = await readChapters()
const chunks = chapters.flatMap(chunkChapter).slice(0, N)
const ordered = [...chunks].sort((a, b) => a.text.length - b.text.length)
console.log(`${MODE}: ${ordered.length} chunks, batch ${BATCH}`)

let embedBatch: (texts: string[]) => Promise<number[][]>
const loadStart = Date.now()
if (MODE === 'llama') {
    embedBatch = async texts => {
        const res = await fetch(`${LLAMA_URL}/v1/embeddings`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({input: texts})
        })
        if (!res.ok) throw new Error(`llama.cpp ${res.status}: ${await res.text()}`)
        const json = (await res.json()) as {data: {index: number; embedding: number[]}[]}
        return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
    }
} else {
    const {embedDocuments, loadEmbedder} = await import('../src/ai/embedder')
    await loadEmbedder()
    embedBatch = embedDocuments
}
// One tiny warmup batch so first-call graph/kernel setup isn't billed as throughput.
await embedBatch([ordered[0]!.text])
console.log(`model ready in ${((Date.now() - loadStart) / 1000).toFixed(1)}s`)

const t0 = Date.now()
let dims = 0
for (let i = 0; i < ordered.length; i += BATCH) {
    const vectors = await embedBatch(ordered.slice(i, i + BATCH).map(c => c.text))
    dims = vectors[0]!.length
}
const secs = (Date.now() - t0) / 1000
console.log(`embedded ${ordered.length} chunks (${dims}-dim) in ${secs.toFixed(1)}s → ${(ordered.length / secs).toFixed(1)} chunks/s`)
