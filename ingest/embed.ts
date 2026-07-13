// HTTP client for the llama.cpp embedding box. Document embeddings only —
// serve-time query embeddings stay in-process (src/ai/embedder.ts, fp16), which
// matches these vectors at cosine 0.9997 (validated).

const EMBED_URL = process.env.EMBED_URL ?? 'http://localhost:8091'

export async function embedDocuments(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({input: texts})
    })
    if (!res.ok) throw new Error(`embedding box ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as {data: {index: number; embedding: number[]}[]}
    // llama.cpp preserves order, but sort by index anyway — it's the contract.
    return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}
