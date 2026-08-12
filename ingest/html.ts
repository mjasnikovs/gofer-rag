// Minimal HTML → plain text for the Godot docs' clean generated XHTML.
// Drops script/style, turns block tags into newlines, strips remaining tags,
// and decodes the handful of entities the docs actually use.

const ENTITIES: Record<string, string> = {
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' '
}

function decodeEntities(text: string): string {
    return text
        .replace(/&(?:lt|gt|amp|quot|apos|nbsp);|&#39;/g, m => ENTITIES[m] ?? m)
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

// Code blocks are lifted out before the whitespace passes and put back after.
// Those passes collapse runs of spaces and then strip what is left at the head
// of a line, which is correct for prose and destroys code: 3940 samples in this
// book came out as `func _physics_process(delta):` followed by `pass` at column
// zero. GDScript is indent-based, so every one of them was structurally wrong,
// and finding 5 of REDUCE-NOISE.md measured that code samples are most of what
// the reranker actually keeps.
//
// The placeholder is NUL-delimited because nothing in the docs contains a NUL,
// and because it must survive every pass in between: it holds no space, no
// newline and no angle bracket, so the space collapse and the tag strip both
// leave it alone.
const PRE_BLOCK = /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi
const PLACEHOLDER = /\0(\d+)\0/g

export function htmlToText(html: string): string {
    const code: string[] = []
    const lifted = html.replace(PRE_BLOCK, (_, body: string) => {
        code.push(decodeEntities(body.replace(/<[^>]+>/g, '')).replace(/\s+$/, ''))
        // Blank lines on both sides: they make the code block its own paragraph,
        // which is the unit splitToBudget() packs by. Glued to the prose around
        // it, a sample can be cut in half at a budget boundary instead.
        return `\n\n\0${code.length - 1}\0\n\n`
    })
    return decodeEntities(
        lifted
            .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)[^>]*>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
    )
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ *\n */g, '\n')
        .trim()
        .replace(PLACEHOLDER, (_, i: string) => code[Number(i)] ?? '')
}
