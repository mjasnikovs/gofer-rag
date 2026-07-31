// Tiny terminal chat for testing accuracy by hand. Native readline, no deps.
//
//   godot> how do I connect a signal?     → grounded answer + sources
//   godot> /raw how do I connect a signal? → the reranked passages + scores
//   godot> /exit

import {createInterface} from 'node:readline/promises'
import {stdin, stdout} from 'node:process'
import {query, retrieve} from '../core/query.js'

export async function startTui(): Promise<void> {
    const rl = createInterface({input: stdin, output: stdout})
    console.log('Ask a question. /raw <q> shows retrieval, /exit quits.\n')

    for (;;) {
        const line = (await rl.question('godot> ')).trim()
        if (!line) continue
        if (line === '/exit') break

        if (line.startsWith('/raw ')) {
            const ranked = await retrieve(line.slice(5))
            if (ranked.length === 0) console.log('  (nothing above threshold)')
            for (const chunk of ranked) console.log(`  ${chunk.score.toFixed(2)}  ${chunk.chapter}`)
            console.log()
            continue
        }

        const result = await query(line)
        if (!result.found) {
            console.log(`\n${result.message}\n`)
            continue
        }
        console.log(`\n${result.answer}\n`)
        console.log(`sources: ${result.sources!.map(s => s.chapter).join('; ')}\n`)
    }

    rl.close()
}
