// Gap-distribution diagnostic for a relative rerank cutoff ("drop kept chunks
// more than G logits below top-1"). Prints, for each question, the kept chunks'
// scores and their gap from top-1, so a cutoff can be chosen from data.
//
// Two groups matter:
//   - polluted: questions where tangential chunks reached the LLM at -4
//     (observed: Text-to-speech woven into the save-game answer) — the cutoff
//     should trim these,
//   - rescued: questions the -4 threshold rescued from false refusal (tops sit
//     near -3) — the cutoff must NOT cut them down to nothing useful.

import {loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieve} from '../src/core/query'
import {loadTable} from '../src/store/db'

const questions = [
    // observed pollution case
    "How do I save the player's progress so it persists between sessions?",
    // the five paraphrases threshold 0 refused (tops near/below 0)
    'How do I switch to another level when the player reaches the exit?',
    'How do I make my game adapt to different screen sizes?',
    'How can I pause the game and resume it later?',
    'How do I run some code on every frame?',
    'How do I create copies of a scene from code while the game runs?',
    // symbol lookups for contrast (tops usually high)
    'What is a NavigationAgent2D used for?',
    'How do I detect when a body enters an Area2D?'
]

await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

for (const q of questions) {
    const kept = await retrieve(q)
    console.log(`\n${q}`)
    if (kept.length === 0) {
        console.log('  (refused)')
        continue
    }
    const top = kept[0]!.score
    for (const c of kept) console.log(`  ${c.score.toFixed(2)}  gap ${(top - c.score).toFixed(2)}  ${c.chapter}`)
}
