// What each ingest-side noise fix actually does to the corpus — measured on the
// real EPUB, with no embedding and no database write. Pure host work, ~1 min.
//
//   bun run scripts/diag-chunk-variants.ts
//
// Exists because an ingest arm costs a full re-embed plus an unpairable A/B
// (see the gofer-rag-ab-method notes: recreateTable reshuffles every pool). The
// chunk-shape half of the question needs neither. Run this first, then only
// re-ingest the variants whose shape is worth paying for.

import {readChapters} from '../ingest/epub'
import {config} from '../src/config'

const BOILERPLATE =
    /There is currently no description for this [a-z ]+\. Please help us by contributing one \[[^\]]+\]!/g
const BRACKETED_URL = /\[(?:https?|ftp):\/\/[^\]\s]*\]/g

// Verbatim copy of ingest/chunk.ts overlapTail(). Note slice(-0) === slice(0):
// with overlap 0 this returns the WHOLE chunk, not an empty string.
function overlapTail(text: string, overlap: number): string {
    if (text.length <= overlap) return text
    const tail = text.slice(-overlap)
    const space = tail.indexOf(' ')
    return space === -1 ? tail : tail.slice(space + 1)
}

type Variant = {
    label: string
    overlap: number
    // true = carry the tail ONLY out of the hard-split path, never across a
    // paragraph seam (the fix REDUCE-NOISE.md finding 1 actually wants)
    hardSplitOnly: boolean
    scrub: boolean
}

function split(text: string, budget: number, variant: Variant): string[] {
    const paragraphs = text
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
    const chunks: string[] = []
    let current = ''
    for (const paragraph of paragraphs) {
        if (current && current.length + paragraph.length + 1 > budget) {
            chunks.push(current)
            current = variant.hardSplitOnly ? '' : overlapTail(current, variant.overlap)
        }
        current = current ? `${current}\n${paragraph}` : paragraph
        while (current.length > budget * 1.5) {
            chunks.push(current.slice(0, budget))
            current = current.slice(budget - variant.overlap)
        }
    }
    if (current.trim()) chunks.push(current)
    return chunks
}

function scrubText(text: string): string {
    return text
        .replace(BOILERPLATE, '')
        .replace(BRACKETED_URL, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ *\n */g, '\n')
        .trim()
}

// Longest prefix of `text` that is also a suffix of `previous` — the duplicated
// copy, measured the same way scripts/diag-context-noise.ts measures it.
function overlapHeadLength(previous: string, text: string): number {
    const max = Math.min(300, previous.length, text.length)
    for (let n = max; n > 0; n--) {
        if (previous.endsWith(text.slice(0, n))) return n
    }
    return 0
}

const chapters = await readChapters()
console.log(`EPUB: ${chapters.length} chapters, ${chapters.reduce((a, c) => a + c.text.length, 0)} raw chars\n`)

const variants: Variant[] = [
    {label: 'current (overlap 240)', overlap: config.overlapChars, hardSplitOnly: false, scrub: false},
    {label: 'overlapChars = 0 (broken)', overlap: 0, hardSplitOnly: false, scrub: false},
    {label: 'overlap on hard-split only', overlap: config.overlapChars, hardSplitOnly: true, scrub: false},
    {label: 'hard-split only + scrub', overlap: config.overlapChars, hardSplitOnly: true, scrub: true}
]

const header = 'variant'.padEnd(28) + 'chunks'.padStart(7) + 'chars'.padStart(11) + 'dup'.padStart(10) + 'dup%'.padStart(8)
console.log(header)
console.log('-'.repeat(header.length))

let baseChars = 0
for (const variant of variants) {
    const perChapter = chapters.map(c => split(variant.scrub ? scrubText(c.text) : c.text, config.chunkChars, variant))
    const flat = perChapter.flat()
    const chars = flat.reduce((a, t) => a + t.length, 0)
    let dup = 0
    for (const list of perChapter) {
        for (let i = 1; i < list.length; i++) dup += overlapHeadLength(list[i - 1]!, list[i]!)
    }
    if (baseChars === 0) baseChars = chars
    console.log(
        variant.label.padEnd(28) +
            String(flat.length).padStart(7) +
            String(chars).padStart(11) +
            String(dup).padStart(10) +
            `${((dup / chars) * 100).toFixed(2)}%`.padStart(8) +
            (chars === baseChars ? '' : `   ${((chars / baseChars - 1) * 100).toFixed(2)}% vs current`)
    )
}
process.exit(0)
