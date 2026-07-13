// Structure-aware chunking: split each chapter into ~chunkChars passages, packing
// whole paragraphs together and never crossing a chapter boundary. Overlap carries
// the tail of one chunk into the next so context isn't lost at the seams.

import {config} from '../src/config'
import type {Chapter, Chunk} from '../src/types'

function overlapTail(text: string, overlap: number): string {
    if (text.length <= overlap) return text
    const tail = text.slice(-overlap)
    const space = tail.indexOf(' ')
    return space === -1 ? tail : tail.slice(space + 1)
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
            current = overlapTail(current, overlap)
        }
        current = current ? `${current}\n${paragraph}` : paragraph
        // A single paragraph larger than the budget gets hard-split.
        while (current.length > budget * 1.5) {
            chunks.push(current.slice(0, budget))
            current = current.slice(budget - overlap)
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
