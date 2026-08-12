// Drop the C# half of a GDScript/C# tab pair at ingest.
//
// The Godot docs show the same example once per language in a tab widget.
// htmlToText() flattens the widget, so both copies land in the same chunk with
// nothing between them but a bare `GDScript` / `C#` marker line:
//
//   GDScript
//   func _on_close_button_pressed():
//       get_tree().paused = false
//   C#
//   private void OnCloseButtonPressed()
//   {
//       GetTree().Paused = false;
//   }
//   You should now have a working pause menu.
//
// Measured over the 50 eval questions, the C# copies were 7.48% of everything
// the answer LLM read — the same size as the chunk-overlap duplication — and
// not one of those questions was about C# (scripts/diag-context-noise.ts,
// 2026-08-12). Five slots is the whole budget, so that is 7.48% of the budget
// spent restating an answer the reader already has.
//
// This is a deliberate trade, not a free win: a C# question now gets GDScript
// samples. Chapters that name C# in their own title are exempt — "C# API
// differences to GDScript" is 22 tab pairs whose entire purpose is showing the
// two languages side by side, and 894 of the corpus's C# markers, only 25 sit
// in a C#-titled chapter.
//
// The cut is made on the HTML, not on the flattened text. The first version of
// this worked on the text and had to GUESS where the C# block ended: it ran to
// the next language marker or the next line of "real prose", prose being a line
// of six or more words ending in `.!?`. htmlToText() hard-wraps paragraphs, so
// the opening lines of the paragraph AFTER a tab almost never end in
// punctuation — and were eaten with the code. Measured on the real EPUB: 404 of
// the 894 blocks over-ate, at least 935 prose lines and ~60k chars, e.g. in
// "Creating your first script" the whole paragraph explaining `extends`
// disappeared and the chunk read `extends Sprite2D` / `Godot uses to manage
// your application's memory.` In HTML the boundary is a tag, so there is
// nothing to guess.

// htmlToText() keeps every link target inline as `[https://...]`, next to the
// link text it already kept. Nothing downstream reads them: the answer prompt
// never mentions citations, and query() builds its `sources` from chapter
// metadata, not from the passage text. So they are embedded, indexed by BM25
// and shipped to the LLM for no reader at all — 3954 of them, 316,229 chars,
// 2.26% of the corpus and ~1.1% of what the LLM reads.
//
// The largest single host is github.com (1053) and the second is
// contributing.godotengine.org (707), which is the "please help us write this
// entry" link on unwritten class-reference stubs.
//
// The link TEXT stays. Only the target goes — EXCEPT where the text is noise
// too. Sampling what sits next to all 3954 URLs found two shapes where cutting
// the target alone leaves something worse than what was there:
//
//   687  "...no description for this method. Please help us by contributing
//          one [url]!"           -> "Please help us by contributing one!"
//   200+ "GH-80813 [url]"        -> "GH-80813"
//
// Both are removed whole. The third shape, "Third Person Shooter (TPS) Demo
// [url]", keeps its text: that IS the answer to "is there a demo project".
const BRACKETED_URL = /[ \t]*\[(?:https?|ftp):\/\/[^\]\s]*\]/g
const NO_DESCRIPTION =
    /[ \t]*There is currently no description for this [a-z ]+\. Please help us by contributing one \[[^\]]*\]!/g
const BARE_ISSUE_LINK = /[ \t]*\bGH-\d+ \[(?:https?|ftp):\/\/[^\]\s]*\]/g

// A chapter whose own title names C#. Its samples are the subject, not a
// duplicate of a GDScript sample above them.
export function namesCsharp(title: string): boolean {
    return /(?:^|\W)C#/.test(title)
}

// The tab label, and the highlighted code pane it labels. Sphinx emits exactly
// one spelling of each in this book: 892 labels and 1028 panes over 1682
// chapters, every pane opening `<div class="highlight-csharp notranslate">`.
//
// The 136 panes with no label are NOT tabs — they are standalone C# samples on
// a page that has no GDScript twin, and they stay. Pairing label to pane keeps
// this cut to the same 892 duplicates the text-based version removed.
const CSHARP_LABEL = /<p[^>]*>C#<\/p>/gi
const CSHARP_PANE = '<div class="highlight-csharp'
const DIV_TAG = /<div\b|<\/div>/gi

// Index just past the `</div>` closing the tag that opens at `start`, counting
// depth so the nested `<div class="highlight">` inside a pane cannot end the
// cut early. -1 if the document runs out first.
function divEnd(html: string, start: number): number {
    DIV_TAG.lastIndex = start
    let depth = 0
    for (let m = DIV_TAG.exec(html); m; m = DIV_TAG.exec(html)) {
        depth += m[0].startsWith('</') ? -1 : 1
        if (depth === 0) return DIV_TAG.lastIndex
    }
    return -1
}

// Takes HTML, before htmlToText() flattens it. Cuts from each `C#` tab label
// through the end of the code pane that follows it. Between the two sit only
// empty layout containers, so cutting the span takes no content with it.
export function dropCsharpTabs(html: string): string {
    let out = ''
    let from = 0
    CSHARP_LABEL.lastIndex = 0
    for (let label = CSHARP_LABEL.exec(html); label; label = CSHARP_LABEL.exec(html)) {
        if (label.index < from) continue
        const pane = html.indexOf(CSHARP_PANE, label.index)
        if (pane === -1) break
        const end = divEnd(html, pane)
        if (end === -1) break
        out += html.slice(from, label.index)
        from = end
        CSHARP_LABEL.lastIndex = end
    }
    return out + html.slice(from)
}

// Line by line, because a line that held nothing but a link should go while a
// line that was ALREADY blank must stay: blank lines are the paragraph
// separator splitToBudget() splits on. Deleting them collapses a chapter into
// one giant paragraph, which sends the whole corpus down the hard-split path —
// measured, and it put the overlap duplication straight back at 6.34% of the
// LLM context.
//
// Within a line, order matters: the two whole-phrase patterns end in a URL
// themselves, so they must run before the bare-target pass eats what they
// match on.
export function dropBracketedUrls(text: string): string {
    return text
        .split('\n')
        .map(line => ({
            line,
            scrubbed: line.replace(NO_DESCRIPTION, '').replace(BARE_ISSUE_LINK, '').replace(BRACKETED_URL, '').trimEnd()
        }))
        .filter(({line, scrubbed}) => line.trim() === '' || scrubbed.trim() !== '')
        .map(({scrubbed}) => scrubbed)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}
