// Talks to the local llama.cpp server (OpenAI-compatible) to write the final
// answer. The system prompt forbids using anything outside the supplied context,
// which is our second line of defence against guessing (the reranker gate is the
// first — this only runs on passages that already cleared it).

import {config} from '../config'

type ChatMessage = {
    role: 'system' | 'user'
    content: string
}

type ChatChoice = {
    message: {content: string}
}

type ChatCompletionResponse = {
    choices: ChatChoice[]
}

const SYSTEM_PROMPT = [
    'You are a Godot Engine documentation assistant.',
    'Answer the question using ONLY the provided context passages.',
    `If the context does not contain the answer, reply exactly: "${config.notFoundMessage}"`,
    'Cite the chapter titles you drew from.'
].join(' ')

// Query expansion for casual questions. "How do I smoothly animate a value?"
// shares no vocabulary with the Tween docs, so the right chapter sits at vector
// rank 91–300+ (measured 2026-07-13, scripts/diag-paraphrase-rank.ts) and BM25 /
// titleSearch have nothing to grab. The 27B lists the Godot class names and doc
// topics the question is really about; those terms give every candidate source
// traction — they are often chapter titles themselves (Tween, CanvasLayer).
// Measured on the 22-question paraphrase set: pool hits 18 → 21, ~0.5s/query.
//
// The Godot-4-naming line stops the model emitting Godot 3 class names
// (Physics2DDirectSpaceState etc.), which only match the "Upgrading from
// Godot 3" chapter and trigger refusals. It does NOT fix the one remaining
// miss ("object under the mouse cursor"): the 27B reads that as a UI/Control
// question, not physics picking, in every prompt wording tried (six variants,
// 2026-07-13) — an interpretation problem, not a naming one. Wordings that
// pushed harder ("implement the answer", subsystem coverage, game-dev
// perspective, docs-page vocabulary) all collapsed other useful terms or
// locked in the UI reading; keep this prompt minimal.
const EXPAND_PROMPT = [
    'You are a Godot 4 engine expert.',
    'Given a question, list the Godot class names and documentation topic keywords most useful for finding the answer in the official docs.',
    'Reply with ONLY a comma-separated list of 3 to 8 terms. Use exact Godot spelling and capitalization (e.g. CharacterBody2D, Tween, CanvasLayer).',
    'Use the current Godot 4 class names, never the old Godot 3 names (e.g. Node3D not Spatial, AnimatedSprite2D not AnimatedSprite).',
    'If the question is unrelated to Godot or game development, reply with exactly NONE.',
    'No explanations. /no_think'
].join(' ')

// The expansion is appended to the rerank query, so a non-compliant reply must
// never get through: for off-topic questions the model tends to answer in
// prose ("This query is unrelated ..."), and appending THAT inflated generic
// intro chunks from -6 to -1.5, breaking the refusal gate (measured
// 2026-07-13). A term list has commas and no sentence punctuation.
const looksLikeTermList = (s: string) =>
    s.length > 0 && s.length < 300 && s.includes(',') && !s.includes('. ') && !/\bNONE\b/.test(s)

let warnedExpansionDown = false

// Returns '' when the LLM server is unreachable or the reply is not a usable
// term list — retrieval then runs unexpanded, exactly the pre-expansion
// pipeline, instead of failing.
export async function expandQuery(question: string): Promise<string> {
    try {
        const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                model: config.llmModel,
                messages: [
                    {role: 'system', content: EXPAND_PROMPT},
                    {role: 'user', content: question}
                ],
                temperature: 0,
                max_tokens: 100,
                stream: false
            }),
            signal: AbortSignal.timeout(15_000)
        })
        if (!res.ok) throw new Error(`LLM request failed: ${res.status}`)
        const data = (await res.json()) as ChatCompletionResponse
        const terms = (data.choices[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        return looksLikeTermList(terms) ? terms : ''
    } catch (err) {
        if (!warnedExpansionDown)
            console.warn(
                `query expansion unavailable (${err instanceof Error ? err.message : String(err)}) — retrieving without it`
            )
        warnedExpansionDown = true
        return ''
    }
}

export async function generateAnswer(question: string, context: string): Promise<string> {
    const messages: ChatMessage[] = [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}`}
    ]
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: config.llmModel, messages, temperature: 0.2, stream: false})
    })
    if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as ChatCompletionResponse
    return data.choices[0]?.message.content.trim() ?? ''
}
