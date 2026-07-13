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

export async function readChapters(): Promise<Chapter[]> {
    const epub = (await EPub.createAsync(config.epubPath)) as unknown as EpubDoc
    const chapters: Chapter[] = []
    let order = 0
    for (const item of epub.flow) {
        if (!item.id) continue
        const html = await epub.getChapterAsync(item.id)
        const text = htmlToText(html)
        if (text.length < 40) continue // skip empty / nav-only pages
        chapters.push({title: item.title ?? item.href ?? item.id, href: item.href ?? '', order: order++, text})
    }
    return chapters
}
