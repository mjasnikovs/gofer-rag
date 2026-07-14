// Judged answer-quality eval — the first eval that READS the LLM's answers
// instead of only checking retrieval or the refusal gate. Runs the realistic
// set's answerable questions through the full pipeline (retrieve + answer),
// then has the 27B grade its own answer against the exact context it saw:
//
//   grounded — every technical claim is supported by the context passages
//              (no invented APIs, no outside knowledge),
//   answers  — the reply actually addresses the user's question.
//
// Self-judging caveat: the grader is the same model that wrote the answer, but
// grounding-vs-context is a checking task, not a generation task, and it is
// the only local model. A refusal (either gate) is reported separately, not
// graded — that's retrieval's failure, eval-realistic's beat. `cited` is a
// free deterministic extra: does the answer name a kept chapter verbatim?
//
// Needs the 27B llama.cpp server; SKIPs cleanly (exit 0) when it's down, same
// contract as eval-llm-gate — so it lives behind "bun run test:llm", NOT in
// test:evals. Slow: ~30 questions x (retrieve + generate + judge).
//
//   bun run scripts/rerank-box.ts bun run scripts/eval-answers.ts
//   ... --verbose   every question, verdicts, judge notes
//
// Baseline (2026-07-14, GPU box, first measurement): graded 24/30, grounded
// 24/24, answers 23/24, cited 23/24, 0 judge-errors. The 6 refusals were the
// documented realistic retrieval misses plus flaky/contention cases (one
// expansion timeout mid-run); the one answers=false was an honest verdict
// (blurry-sprite context covers downscale filtering, question asks about
// upscale). No minimum yet — one measurement, self-judging: gate after the
// judge's run-to-run stability is itself measured.

import {config} from '../src/config'
import {retrieve, warmup} from '../src/core/query'
import {generateAnswer} from '../src/ai/llm'
import {cases} from './realistic-cases'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')

const healthUrl = config.llmBaseUrl.replace(/\/v1\/?$/, '') + '/health'
const up = await fetch(healthUrl, {signal: AbortSignal.timeout(2000)})
    .then(r => r.ok)
    .catch(() => false)
if (!up) {
    console.log(`answers: SKIP  (no server at ${healthUrl})`)
    process.exit(0)
}

const JUDGE_PROMPT = [
    'You are grading a documentation assistant.',
    'You get the user question, the context passages the assistant was shown, and its answer.',
    'Judge two things.',
    'grounded: every technical claim in the answer is supported by the context passages — no invented class names, methods, or behavior. Restating the question or saying the context lacks something is fine.',
    'answers: the reply actually addresses what the user asked, rather than only related information.',
    'Reply with ONLY this JSON, no other text: {"grounded": true or false, "answers": true or false, "problem": "shortest possible quote of the offending claim, or empty string"}',
    '/no_think'
].join(' ')

type Verdict = {grounded: boolean; answers: boolean; problem: string}

async function judge(question: string, context: string, answer: string): Promise<Verdict | null> {
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: config.llmModel,
            messages: [
                {role: 'system', content: JUDGE_PROMPT},
                {
                    role: 'user',
                    content: `Question: ${question}\n\nContext passages:\n${context}\n\nAssistant answer:\n${answer}`
                }
            ],
            temperature: 0,
            max_tokens: 200,
            stream: false
        }),
        signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as {choices: {message: {content: string}}[]}
    const raw = (data.choices[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '')
    const json = raw.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return null
    try {
        const v = JSON.parse(json) as Partial<Verdict>
        if (typeof v.grounded !== 'boolean' || typeof v.answers !== 'boolean') return null
        return {grounded: v.grounded, answers: v.answers, problem: v.problem ?? ''}
    } catch {
        return null
    }
}

// Same normalized-prefix refusal check as query(); the LLM may add punctuation.
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const isRefusal = (answer: string) => normalize(answer).startsWith(normalize(config.notFoundMessage))

if (verbose) console.log('Loading models ...')
await warmup()

const answerable = cases.filter(c => c.expect)
let graded = 0
let refused = 0
let judgeErrors = 0
let groundedCount = 0
let answersCount = 0
let citedCount = 0

for (const c of answerable) {
    const kept = await retrieve(c.question)
    if (kept.length === 0) {
        refused++
        if (verbose) console.log(`REFUSED (gate)  [${c.cat}]  ${c.question}`)
        continue
    }
    const context = kept.map((chunk, i) => `[${i + 1}] (${chunk.chapter})\n${chunk.text}`).join('\n\n')
    const answer = await generateAnswer(c.question, context)
    if (isRefusal(answer)) {
        refused++
        if (verbose) console.log(`REFUSED (llm)   [${c.cat}]  ${c.question}`)
        continue
    }
    const verdict = await judge(c.question, context, answer)
    if (!verdict) {
        judgeErrors++
        console.log(`JUDGE-ERROR     [${c.cat}]  ${c.question}`)
        continue
    }
    graded++
    if (verdict.grounded) groundedCount++
    if (verdict.answers) answersCount++
    const cited = kept.some(k => answer.includes(k.chapter))
    if (cited) citedCount++
    const bad = !verdict.grounded || !verdict.answers
    if (verbose || bad) {
        console.log(
            `${bad ? 'BAD ' : 'OK  '} grounded=${verdict.grounded} answers=${verdict.answers} cited=${cited}  [${c.cat}]  ${c.question}`
        )
        if (verdict.problem) console.log(`    problem: ${verdict.problem}`)
        if (bad || verbose) console.log(`    answer: ${answer.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
}

// First measurement session (2026-07-14): establish the baseline before
// gating. Refusals are eval-realistic's territory; judge errors are loud but
// don't fail the run until the judge's reliability is itself measured.
console.log(
    `\nanswers: graded ${graded}/${answerable.length} (${refused} refused, ${judgeErrors} judge-errors)` +
        `\n  grounded ${groundedCount}/${graded}  answers ${answersCount}/${graded}  cited ${citedCount}/${graded}`
)
