// One-off diagnostic: for the 4 paraphrase questions whose expected chapter
// never reaches the candidate pool, find where that chapter first appears in
// a deep vector scan. Distinguishes "just below topK 20" (cheap fix: bump K)
// from "nowhere" (needs query rewriting / HyDE).

import {embedQuery, loadEmbedder} from '../src/ai/embedder'
import {loadTable, vectorSearch} from '../src/store/db'

const cases = [
    {question: 'How do I make an enemy chase the player?', expect: /NavigationAgent|navigation overview|2D movement/i},
    {question: 'How do I keep the UI in place while the camera moves around?', expect: /Canvas layers/},
    {question: 'How do I find out which object is under the mouse cursor?', expect: /Ray-casting|Mouse and input coordinates/},
    {question: 'How do I smoothly animate a value from one number to another in code?', expect: /Tween/}
]

const DEPTH = 300

await Promise.all([loadEmbedder(), loadTable()])

for (const c of cases) {
    const vector = await embedQuery(c.question)
    const hits = (await vectorSearch(vector, DEPTH))
    const rank = hits.findIndex(h => c.expect.test(h.chapter))
    console.log(`\n${c.question}`)
    console.log(`  expected-chapter first vector rank: ${rank === -1 ? `not in top ${DEPTH}` : rank + 1}`)
    if (rank !== -1) console.log(`  hit: ${hits[rank]!.chapter}`)
    console.log(`  top 5: ${hits.slice(0, 5).map(h => h.chapter).join(' | ')}`)
}
