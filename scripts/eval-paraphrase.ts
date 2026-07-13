// Paraphrase eval: how-to questions that name NO class or member symbol, so
// titleSearch can't fire on the raw question and retrieval rides on vector
// similarity + BM25 + LLM query expansion (which triggers precisely because no
// title matches). This is the part of retrieval with no programmatic ground
// truth, hence a hand-written set; it doubles as the regression suite for any
// embedder swap. Wants the llama.cpp server up (docker start llama-turboquant);
// without it, expansion falls back to nothing and this measures the old
// unexpanded pipeline (baseline 18/22).
//
//   bun run scripts/eval-paraphrase.ts             quiet: one summary line, exit 1 on fail
//   bun run scripts/eval-paraphrase.ts --verbose   every question + timings
//
// Pass = at least RERANK_MIN survive rerank. Timings are diagnostics.
//
// Each question lists the chapters a Godot developer would accept as the right
// place to answer from (class-ref chapters count — the question just must not
// contain the symbol). PASS = an expected chapter survives rerank + threshold;
// "pool" tells you whether a failure was retrieval or the reranker's judgment.

import {loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieveDetailed} from '../src/core/query'
import {loadTable} from '../src/store/db'

type Case = {question: string; expect: RegExp}

const cases: Case[] = [
    {question: 'How do I make an enemy chase the player?', expect: /NavigationAgent|navigation overview|2D movement/i},
    {question: "How do I save the player's progress so it persists between sessions?", expect: /Saving games/},
    {question: 'How do I make the camera smoothly follow the player character?', expect: /Camera2D|Camera3D|Third-person camera/},
    {question: 'How do I detect when two objects collide?', expect: /Physics introduction|Area2D|Collision shapes|RigidBody/},
    // "Finishing up" is the Your-first-2D-game chapter that adds background music.
    {question: 'How do I play background music in my game?', expect: /Audio streams|AudioStreamPlayer|Finishing up/},
    {question: "How do I show the player's score as text on the screen?", expect: /Heads up display|Label|Score and replay/},
    {question: 'How can I pause the game and resume it later?', expect: /Pausing games/},
    {question: 'How do I generate random numbers?', expect: /Random number generation|RandomNumberGenerator|@GlobalScope/},
    {question: 'How do I make my game adapt to different screen sizes?', expect: /Multiple resolutions/},
    {question: 'How do I create a character that walks and jumps in a platformer?', expect: /CharacterBody|Kinematic character/},
    {question: 'How do I switch to another level when the player reaches the exit?', expect: /Change scenes manually|Background loading|SceneTree/},
    {question: 'How do I run some code on every frame?', expect: /Idle and Physics Processing|Overridable functions/},
    {question: 'How do I make one node notify another when something happens?', expect: /signals/i},
    {question: 'How do I translate my game into multiple languages?', expect: /Internationaliz|translation|Localization/i},
    {question: 'How do I keep the UI in place while the camera moves around?', expect: /Canvas layers/},
    {question: 'How do I create copies of a scene from code while the game runs?', expect: /Creating instances|Nodes and scene instances|PackedScene/},
    {question: 'How do I find out which object is under the mouse cursor?', expect: /Ray-casting|Mouse and input coordinates/},
    {question: 'How do I smoothly animate a value from one number to another in code?', expect: /Tween/},
    {question: 'How do I read which keys the player is pressing?', expect: /input/i},
    {question: 'How do I store global game state that every scene can access?', expect: /Autoload|Singleton/i},
    {question: 'How do I make objects fall with gravity and bounce off each other?', expect: /Physics introduction|RigidBody/},
    {question: 'How do I add multiplayer over the network to my game?', expect: /multiplayer/i}
]

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')

// At least this many questions must survive rerank. Measured 2026-07-13:
// 21/22 with LLM query expansion (pool 22/22; pre-expansion baseline was
// 18/22). Min 20 tolerates a single flip from expansion nondeterminism —
// the 27B's term list varies slightly run to run. Two flips, or any
// FAIL-pool, means a real regression: investigate, don't lower this.
const RERANK_MIN = 20

if (verbose) console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

let passPool = 0
let passKept = 0
let rerankMs = 0
for (const c of cases) {
    const t0 = performance.now()
    const {candidates: pool, expansion, kept} = await retrieveDetailed(c.question)
    rerankMs += performance.now() - t0
    const inPool = pool.some(x => c.expect.test(x.chapter))
    const pass = kept.some(x => c.expect.test(x.chapter))
    if (inPool) passPool++
    if (pass) passKept++
    // Quiet: only failing questions; --verbose: every question.
    if (verbose || !pass) console.log(`${pass ? 'PASS' : inPool ? 'FAIL-rerank' : 'FAIL-pool'}  ${c.question}`)
    if (verbose && expansion) console.log(`    expansion: ${expansion}`)
    if (!pass) console.log(`    kept: ${kept.length ? kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ') : '(nothing above threshold)'}`)
}

if (verbose) {
    console.log('\n=== summary ===')
    console.log(`candidate pool: ${passPool}/${cases.length}   after rerank: ${passKept}/${cases.length}   retrieve mean ${(rerankMs / cases.length / 1000).toFixed(1)}s`)
}

const ok = passKept >= RERANK_MIN
console.log(`paraphrase: ${ok ? 'PASS' : 'FAIL'}  ${passKept}/${cases.length} after rerank (min ${RERANK_MIN})`)
process.exit(ok ? 0 : 1)
