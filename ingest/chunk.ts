// Structure-aware chunking: split each chapter into ~chunkChars passages, packing
// whole paragraphs together and never crossing a chapter boundary.
//
// Overlap is carried ONLY out of the hard-split path. A paragraph seam needs no
// overlap: packing never cuts a paragraph in half, so there is no thought to
// carry across. Copying the tail there cost 1,659,378 chars — 11.87% of the
// corpus — to guard 102 of 8889 chunks (1.1%), the only ones a hard split can
// cut mid-sentence. Worse, the copy landed at the HEAD of the next chunk, so
// every kept chunk opened with a mid-sentence fragment: 7.47% of everything the
// answer LLM read was that fragment (scripts/diag-context-noise.ts, 50
// questions, 2026-08-12). Removing it drops the corpus 11.91%, 8889 chunks to
// 8004 (scripts/diag-chunk-variants.ts).
//
// Do NOT "disable" this by setting config.overlapChars to 0. The old tail copier
// used text.slice(-overlap), and slice(-0) is slice(0) — the whole chunk. That
// path measured 88,559 chunks and 190 MB, a 1258% blowup.

import {config} from '../src/config'
import type {Chapter, Chunk} from '../src/types'

// Never cut between a UTF-16 surrogate pair. The docs carry emoji, and half a
// pair is not valid JSON: the embedding box rejects the whole batch with
// "surrogate U+DC00..U+DFFF must follow U+D800..U+DBFF". Latent since the hard
// split was written — it only fires when a chunk boundary happens to land on an
// emoji, which changing the chunking makes it do.
function surrogateSafe(text: string, index: number): number {
    const previous = text.charCodeAt(index - 1)
    return previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index
}

function splitToBudget(text: string, budget: number, overlap: number): string[] {
    const paragraphs = text
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
    const chunks: string[] = []
    let current = ''
    for (const paragraph of paragraphs) {
        if (current && current.length + paragraph.length + 1 > budget) {
            chunks.push(current)
            current = ''
        }
        current = current ? `${current}\n${paragraph}` : paragraph
        // A single paragraph larger than the budget gets hard-split.
        while (current.length > budget * 1.5) {
            chunks.push(current.slice(0, surrogateSafe(current, budget)))
            current = current.slice(surrogateSafe(current, budget - overlap))
        }
    }
    if (current.trim()) chunks.push(current)
    return chunks
}

export function chunkChapter(chapter: Chapter): Chunk[] {
    return splitToBudget(chapter.text, config.chunkChars, config.overlapChars).map((text, chunkIndex) => ({
        id: `${chapter.order}-${chunkIndex}`,
        chapter: chapter.title,
        order: chapter.order,
        chunkIndex,
        text
    }))
}
