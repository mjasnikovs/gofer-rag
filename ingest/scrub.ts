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

const LANGUAGE_MARKER = /^(?:GDScript|C#|C\+\+|GLSL|Shader|Text|Output|INI|XML|JSON)$/
// Code comments read exactly like prose ("// Called when the node enters the
// scene tree."), so they must not be mistaken for the paragraph that ends a
// code block. `#` alone is the tail of the `C#` marker, never a comment.
const COMMENT = /^(?:\/\/|\/\*|\*|#(?!\s*$))/

function isProse(line: string): boolean {
    if (COMMENT.test(line)) return false
    return line.split(/\s+/).length >= 6 && /[.!?]$/.test(line)
}

// A chapter whose own title names C#. Its samples are the subject, not a
// duplicate of a GDScript sample above them.
export function namesCsharp(title: string): boolean {
    return /(?:^|\W)C#/.test(title)
}

// A `C#` marker line opens the block. The block runs to the next language
// marker, the next line of real prose, or the end of the chapter — the three
// things that can follow a flattened tab.
export function dropCsharpTabs(text: string): string {
    const kept: string[] = []
    let inCsharp = false
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (inCsharp) {
            if (!LANGUAGE_MARKER.test(trimmed) && !isProse(trimmed)) continue
            inCsharp = false
        }
        if (trimmed === 'C#') {
            inCsharp = true
            continue
        }
        kept.push(line)
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}
