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

export function htmlToText(html: string): string {
    return decodeEntities(
        html
            .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)[^>]*>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
    )
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ *\n */g, '\n')
        .trim()
}
