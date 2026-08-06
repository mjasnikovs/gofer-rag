// Reads the EPUB in spine order, one Chapter per page, keeping the page title as
// the chapter label. Validated on the 206 MB Godot docs: 1677 titled pages,
// ~500 MB RSS. Pages are read on demand so we never hold the whole book as text.

import {EPub} from 'epub2'
import {config} from '../src/config'
import {htmlToText} from './html'
import type {Chapter} from '../src/types'

// epub2 ships a broken .d.ts (its TocElement index signature conflicts with its
// own fields), which typescript-eslint resolves to `error` and flags as unsafe.
// We isolate it behind this minimal, correct view of the bits we actually use.
type SpineItem = {
    id?: string
    href?: string
    title?: string
}

type EpubDoc = {
    flow: SpineItem[]
    getChapterAsync(chapterId: string): Promise<string>
}

// 62 of the 1677 spine items carry no title (measured 2026-08-06), and the old
// href fallback turned those into chapter labels like
// "tutorials/scripting/c_sharp/c_sharp_signals.xhtml". A path is not a title:
// matchedTitles()/titleSearch() key on chapter titles appearing verbatim in a
// question, so those 62 chapters were unreachable by name — no user types a
// file path. Every one of them has a clean <h1> ("Creating a 3D particle
// system", "Particle turbulence", ...), which is the title the docs themselves
// use. Preferred only when the spine has none, so the 1615 already-titled
// chapters keep their existing labels and the corpus doesn't drift.
function headingTitle(html: string): string | null {
    const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    if (!match) return null
    const text = htmlToText(match[1]!).replace(/\s+/g, ' ').trim()
    return text.length > 0 && text.length <= 120 ? text : null
}

export async function readChapters(): Promise<Chapter[]> {
    const epub = (await EPub.createAsync(config.epubPath)) as unknown as EpubDoc
    const chapters: Chapter[] = []
    let order = 0
    for (const item of epub.flow) {
        if (!item.id) continue
        const html = await epub.getChapterAsync(item.id)
        const text = htmlToText(html)
        if (text.length < 40) continue // skip empty / nav-only pages
        const title = item.title ?? headingTitle(html) ?? item.href ?? item.id
        chapters.push({title, href: item.href ?? '', order: order++, text})
    }
    return chapters
}
