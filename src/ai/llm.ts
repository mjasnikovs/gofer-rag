// Talks to the local llama.cpp server (OpenAI-compatible) to write the final
// answer. The system prompt forbids using anything outside the supplied context,
// which is our second line of defence against guessing (the reranker gate is the
// first — this only runs on passages that already cleared it).
//
// Both model calls in this package go through completeChat() below, so a host
// that supplied options.complete owns the connection for both. The prompts and
// the guards on the replies stay here either way.

import {config, getOptions} from '../config.js'
import type {LlmCompletionRequest} from '../types.js'

type ChatMessage = {
    role: 'system' | 'user'
    content: string
}

// Thinking models return the visible answer in content and their scratchpad in
// a separate reasoning_content, and content can legitimately be absent — the
// declared-required content of the old type was a lie that cost us the whole
// expansion feature.
type ChatChoice = {
    message: {content?: string; reasoning_content?: string}
}

type ChatCompletionResponse = {
    choices: ChatChoice[]
}

type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

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
// Measured on the 22-question paraphrase set: pool hits 18 → 21, ~0.5s/query
// against the non-reasoning model this was tuned on (2026-07-13). The same
// prompt against a reasoning model costs 5.5-29.4s (mean 11.2s, measured
// 2026-08-16) because the terms now arrive after a scratchpad — see
// EXPAND_MAX_TOKENS. Only questions that name no chapter title pay it, and a
// host that wants the old latency back can inject a non-reasoning connection
// through the `complete` option instead.
//
// The Godot-4-naming line stops the model emitting Godot 3 class names
// (Physics2DDirectSpaceState etc.), which only match the "Upgrading from
// Godot 3" chapter and trigger refusals. Two refinements from the realistic
// eval (2026-07-14, scripts/eval-realistic.ts, each probed 3-4x stable):
// the naming line alone made QUESTIONS in Godot 3 vocabulary trip the NONE
// clause ("translation of a Spatial node" → NONE, expansion '' 4/4), so the
// "list its Godot 4 replacement" clause turns those into modern terms
// (Spatial → Node3D; KinematicBody2D → CharacterBody2D), and NONE is scoped
// to nothing-to-do-with-games so it stops firing on legacy-named questions
// while sourdough/FIFA still get NONE. Earlier finding (2026-07-13, six
// wordings): pushier phrasings collapse other useful terms — keep it minimal.
const EXPAND_PROMPT = [
    'You are a Godot 4 engine expert.',
    'Given a question, list the Godot class names and documentation topic keywords most useful for finding the answer in the official docs.',
    'Reply with ONLY a comma-separated list of 3 to 8 terms. Use exact Godot spelling and capitalization (e.g. CharacterBody2D, Tween, CanvasLayer).',
    'Use the current Godot 4 class names, never the old Godot 3 names (e.g. Node3D not Spatial, AnimatedSprite2D not AnimatedSprite); if the question uses a Godot 3 name, list its Godot 4 replacement.',
    'Only if the question has nothing to do with games or Godot at all (e.g. cooking, sports, politics), reply with exactly NONE.',
    'No explanations. /no_think'
].join(' ')

// The expansion is appended to the rerank query, so a non-compliant reply must
// never get through: for off-topic questions the model tends to answer in
// prose ("This query is unrelated ..."), and appending THAT inflated generic
// intro chunks from -6 to -1.5, breaking the refusal gate (measured
// 2026-07-13). A term list has commas and no sentence punctuation.
const looksLikeTermList = (s: string) =>
    s.length > 0 && s.length < 300 && s.includes(',') && !s.includes('. ') && !/\bNONE\b/.test(s)

// A reasoning model spends its budget thinking BEFORE it writes anything, so
// the budget has to cover the scratchpad plus the answer. Measured 2026-08-16
// against the local 27B on the 22 paraphrase questions plus the two off-topic
// ones, temperature 0:
//
//   max_tokens  100   0/24 usable — every reply came back finish_reason
//                     "length" with content "" (the smallest complete reply in
//                     the set needs 131 tokens, so 100 cannot ever land)
//   max_tokens  200   still truncated mid-thought (probed separately)
//   max_tokens 1200   lands for the easy questions, short of the worst
//   max_tokens 2048   24/24 finish_reason "stop", worst reply 1491 tokens,
//                     mean 490 — 37% headroom over the worst
//
// /no_think in the prompt does not stop it, and neither does the provider's
// reasoning-off switch (both probed) — budget for thinking as the normal case.
const EXPAND_MAX_TOKENS = 2048

// Wall clock for the same 24 replies: mean 11.2s, worst 29.4s (the 1491-token
// one, ~51 tokens/s), and a cold server is slower still. The old 15s aborted 5
// of the 24 outright. 60s is 2x the worst warm call and covers the 2048-token
// ceiling at the measured rate with room for a cold start. It is not sized to
// wait out a busy server — a single-slot llama.cpp shared with another client
// queues for as long as that client takes, and one paraphrase question did hit
// this timeout that way (eval-paraphrase, 2026-08-16, still 21/22). Losing one
// expansion to unexpanded retrieval is the cheaper failure.
const EXPAND_TIMEOUT_MS = 60_000

// The answer path was unbounded. Measured over four real 5-passage contexts
// (2026-08-16): 309-529 completion tokens, prompt 1738-2267. This ceiling is
// ~8x the worst observed answer; it exists only to bound a runaway, not to
// shape the reply.
const ANSWER_MAX_TOKENS = 4096

// Thinking models put their scratchpad in reasoning_content and the visible
// reply in content. Prefer content; fall back to the scratchpad only when
// content is empty, which is what a truncated reasoning reply looks like. Older
// servers inline the scratchpad in content as <think> tags instead.
const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

function messageText(data: ChatCompletionResponse): string {
    const message = data.choices[0]?.message
    if (!message) return ''
    return stripThinking(message.content ?? '') || stripThinking(message.reasoning_content ?? '')
}

// The single seam through which this package reaches a model. When the host
// supplied options.complete it owns the connection and has already stripped its
// provider's thinking; otherwise the built-in OpenAI-compatible call runs. The
// caller still guards whatever comes back (looksLikeTermList / isRefusal),
// because an injected connection is no more trusted than a local server.
async function completeChat(
    request: LlmCompletionRequest,
    temperature: number,
    timeoutMs: number | undefined,
    fetcher: FetchFunction
): Promise<string> {
    const options = getOptions()
    if (options.complete) return (await options.complete(request)).trim()

    const messages: ChatMessage[] = [
        {role: 'system', content: request.system},
        {role: 'user', content: request.user}
    ]
    const res = await fetcher(`${options.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: options.llmModel,
            messages,
            temperature,
            max_tokens: request.maxTokens,
            stream: false
        }),
        ...(timeoutMs === undefined ? {} : {signal: AbortSignal.timeout(timeoutMs)})
    })
    if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`)
    return messageText((await res.json()) as ChatCompletionResponse)
}

let warnedExpansionDown = false

// Returns '' when the model is unreachable — or the injected connection throws
// — or the reply is not a usable term list. Retrieval then runs unexpanded,
// exactly the pre-expansion pipeline, instead of failing.
export async function expandQuery(question: string, fetcher: FetchFunction = fetch): Promise<string> {
    try {
        const terms = await completeChat(
            {system: EXPAND_PROMPT, user: question, maxTokens: EXPAND_MAX_TOKENS},
            0,
            EXPAND_TIMEOUT_MS,
            fetcher
        )
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

export async function generateAnswer(
    question: string,
    context: string,
    fetcher: FetchFunction = fetch
): Promise<string> {
    return completeChat(
        {
            system: SYSTEM_PROMPT,
            user: `Context:\n${context}\n\nQuestion: ${question}`,
            maxTokens: ANSWER_MAX_TOKENS
        },
        0.2,
        undefined,
        fetcher
    )
}
