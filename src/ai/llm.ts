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
