// The actual ingestion work: wipe the vector DB and rebuild it from the EPUB.
// Accuracy first: fresh table, structure-aware chunks, document-mode embeddings.
//
// This is the inner worker. It runs on the HOST — parsing, chunking and the
// LanceDB write are host work. Only the embedding itself goes over HTTP to the
// llama.cpp box that `rag-update` starts (EMBED_URL). Don't run this directly;
// without the box there is nothing to embed with.

import {readChapters} from './epub'
import {chunkChapter} from './chunk'
import {embedDocuments} from './embed'
import {recreateTable} from '../src/store/db'
import {config} from '../src/config'
import type {StoredChunk} from '../src/types'

const BATCH_SIZE = Number(process.env.RAG_BATCH) || 32
// Set RAG_MAX_CHUNKS to ingest only the first N chunks — a fast way to validate
// the pipeline end-to-end without waiting for the full embed.
const MAX_CHUNKS = Number(process.env.RAG_MAX_CHUNKS) || Infinity

const started = Date.now()

const embedLabel = process.env.EMBED_LABEL ?? process.env.EMBED_URL ?? 'llama.cpp box'

console.log(`embedding box = ${embedLabel}`)
console.log(`Reading ${config.epubPath} ...`)
const chapters = await readChapters()
console.log(`  ${chapters.length} chapters`)

let chunks = chapters.flatMap(chunkChapter)
if (chunks.length > MAX_CHUNKS) chunks = chunks.slice(0, MAX_CHUNKS)
console.log(`  ${chunks.length} chunks`)

// Embed shortest-first so each padded batch holds similar-length texts. Padding
// every batch to its longest member is wasted compute; grouping by length cuts it.
// Row order in LanceDB is irrelevant — each chunk keeps its chapter/order metadata.
const ordered = [...chunks].sort((a, b) => a.text.length - b.text.length)

console.log(`Embedding (${embedLabel}) ...`)
const rows: StoredChunk[] = []
for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
    const batch = ordered.slice(i, i + BATCH_SIZE)
    const vectors = await embedDocuments(batch.map(c => c.text))
    batch.forEach((chunk, j) =>
        rows.push({id: chunk.id, vector: vectors[j]!, text: chunk.text, chapter: chunk.chapter, order: chunk.order})
    )
    if (i > 0 && i % (BATCH_SIZE * 10) === 0) console.log(`  ${i}/${ordered.length}`)
}

console.log('Writing to LanceDB ...')
await recreateTable(rows)

console.log(`Done. ${rows.length} chunks in ${((Date.now() - started) / 1000).toFixed(1)}s`)
process.exit(0)
