// The exact text EmbeddingGemma 2 sees. Ingest (llama.cpp) and serve (ONNX)
// must format identically, so both import from here. No imports on purpose:
// the ingest process must not load transformers.js just to build a string.

// Gemma's tokenizer reads these as control tokens even inside plain text.
// "<|image|>" in a question makes the model expect an image, and the forward
// pass throws; "<bos>" restarts the sequence. This is the tokenizer's full list
// of named special tokens (2026-10-07). Godot's docs contain none of them (0 of
// 7671 chunks), so dropping them costs nothing. Ordinary tags like <image> or
// <T> are not special and tokenize as plain text.
const SPECIAL_TOKENS = [
    '<pad>',
    '<eos>',
    '<bos>',
    '<unk>',
    '<mask>',
    '<|tool>',
    '<tool|>',
    '<|tool_call>',
    '<tool_call|>',
    '<|tool_response>',
    '<tool_response|>',
    '<|"|>',
    '<|think|>',
    '<|channel>',
    '<channel|>',
    '<|turn>',
    '<turn|>',
    '<|image>',
    '<|audio>',
    '<|image|>',
    '<|audio|>',
    '<image|>',
    '<audio|>',
    '<|video|>'
]
const SPECIAL_TOKEN = new RegExp(SPECIAL_TOKENS.map(token => token.replace(/[|]/g, '\\|')).join('|'), 'g')

export function cleanText(text: string): string {
    return text.replace(SPECIAL_TOKEN, '')
}

export function hasSpecialToken(text: string): boolean {
    return cleanText(text) !== text
}

// The model card's default for search is "task: search result | query: ".
// Measured 2026-10-07 over the 249 frozen pools, the code-retrieval prefix
// found the expected chapter in 234/240 vector top-20s against 228, and lost
// no end-to-end answer while gaining one ("how do i make a main menu with
// buttons"). The rule was set before the run: a variant had to gain 5.
export const QUERY_PREFIX = 'task: code retrieval | query: '

export const DOCUMENT_FORMAT = 'title: {title} | text: {text}'

export function queryText(question: string): string {
    return `${QUERY_PREFIX}${cleanText(question)}`
}

export function documentText(title: string, text: string): string {
    return DOCUMENT_FORMAT.replace('{title}', cleanText(title)).replace('{text}', () => cleanText(text))
}
