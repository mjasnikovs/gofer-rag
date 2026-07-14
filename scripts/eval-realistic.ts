// Realistic-questions eval: how users ACTUALLY ask — vague symptom reports,
// misspellings, Godot-3 vocabulary, questions naming two classes at once,
// pasted error messages, and gamedev-adjacent off-topic. Every shape here is
// one the templated/paraphrase evals deliberately avoid, so this is the
// blind-spot hunter: expect misses, then diagnose them.
//
// Every `expect` was verified against the corpus (grep, 2026-07-14) — the
// chapters really do answer the question. Off-topic cases have no expect and
// run through the FULL query() (reranker gate + LLM gate), because realistic
// off-topic questions mention Godot words and won't score below the reranker
// threshold; refusing them is the LLM gate's job. Wants the llama server up
// (docker start llama-turboquant) for expansion AND the off-topic cases.
//
//   bun run scripts/eval-realistic.ts             quiet: fails + per-category summary
//   bun run scripts/eval-realistic.ts --verbose   every question, expansions, timings
//
// Baseline 29/33 (2026-07-14, GPU box). The 4 stable misses are all
// EXPANSION-VOCABULARY-BOUND — the 27B's term list lacks the docs' answer
// vocabulary, so the right chapter loses the pool or the rerank:
//   falls through the floor    needs "Continuous Collision Detection" /
//                              tunneling; model emits movement terms instead
//   freezes when loading       needs "Background loading" / threaded loading;
//                              model emits scene-change terms
//   export to andriod (typo)   typo kills BM25/titleSearch; expansion says
//                              "Android" but not "Exporting for Android"
//   how big can my world be    needs "Large world coordinates"; model invents
//                              FloatingPointPrecision
// A "terms may be docs page titles" prompt clause was probed 3x with different
// examples (2026-07-14): each example choice fixed some of these and collapsed
// other questions' terms (yield→NONE, mouse/chase losing RayCast3D/
// NavigationAgent2D) — same prompt-roulette verdict as the fourth session's
// six wordings. Fixing these needs a non-prompt lever (question spell-correct
// against corpus vocabulary, or grounding expansion terms in the real chapter
// list). Health-bar and null-instance-error cases flip with expansion
// nondeterminism (±2), hence the margin in REALISTIC_MIN.

import {loadEmbedder} from '../src/ai/embedder'
import {loadReranker} from '../src/ai/reranker'
import {retrieveDetailed, query} from '../src/core/query'
import {loadTable} from '../src/store/db'

type Category = 'vague' | 'typo' | 'godot3' | 'multi' | 'howto' | 'error' | 'offtopic'
// expect = chapter regex a kept chunk must match; text = that same chunk must
// also match this (guards against passing via an expected chapter's unrelated
// chunk). No expect = must refuse, judged via full query().
type Case = {cat: Category; question: string; expect?: RegExp; text?: RegExp}

const cases: Case[] = [
    // --- vague symptom reports, no class names -----------------------------
    // Tunneling; "Enabling Continuous CD" is the documented fix.
    {cat: 'vague', question: 'my player falls through the floor when moving fast', expect: /Troubleshooting physics issues/},
    // Texture filtering (nearest vs linear) — discussed across several pages.
    {cat: 'vague', question: 'why does my sprite look blurry when i scale it up', expect: /Importing images|CanvasItem|ProjectSettings|RenderingServer|Viewport/, text: /filter/i},
    {cat: 'vague', question: 'my game freezes for a second when i load a new level', expect: /Background loading|ResourceLoader/},
    {cat: 'vague', question: 'the game window looks tiny on high resolution screens', expect: /Multiple resolutions/},
    {cat: 'vague', question: 'how do i stop everything while the menu is open', expect: /Pausing games/},

    // --- misspellings -------------------------------------------------------
    {cat: 'typo', question: 'how do i use raycst2d to detect walls', expect: /RayCast2D|Ray-casting/},
    {cat: 'typo', question: 'what does the anmiationplayer node do', expect: /AnimationPlayer|Introduction to the animation features/},
    // "Creating the player scene" walks through adding a CollisionShape2D to
    // the player — verified grounding, not just a mention.
    {cat: 'typo', question: 'how do i add a colison shape to my player', expect: /CollisionShape2D|Collision shapes|Creating the player scene/},
    {cat: 'typo', question: 'how do i export my game to andriod', expect: /Exporting for Android/},

    // --- Godot-3 vocabulary (renamed in 4; the Upgrading chapter has the
    // rename table, so either the modern chapter or Upgrading is grounding) --
    {cat: 'godot3', question: 'how do i move a KinematicBody2D', expect: /CharacterBody2D|Upgrading from Godot 3/},
    {cat: 'godot3', question: 'can i still use yield to wait for a signal', expect: /GDScript reference|Upgrading from Godot 3/},
    {cat: 'godot3', question: 'how do i change the translation of a Spatial node', expect: /Node3D|Upgrading from Godot 3/},

    // --- two classes in one question (the pin caps at 3 titles; this path
    // was never measured) ----------------------------------------------------
    {cat: 'multi', question: 'whats the difference between Area2D and StaticBody2D', expect: /Physics introduction|Area2D|StaticBody2D/},
    {cat: 'multi', question: 'should my player be a CharacterBody2D or a RigidBody2D', expect: /Physics introduction|CharacterBody2D|RigidBody2D|Using CharacterBody/},
    {cat: 'multi', question: 'how do i start an AnimationPlayer when a Timer times out', expect: /AnimationPlayer|Timer|Using signals/},
    {cat: 'multi', question: 'how do i attach a Camera2D to my CharacterBody2D so it follows the player', expect: /Camera2D|CharacterBody2D/},

    // --- casual gamedev how-tos ---------------------------------------------
    // Same accepted set as eval-paraphrase's camera question: the expansion
    // sometimes reads this as 3D and the spring-arm tutorial is a real answer.
    {cat: 'howto', question: 'how do i make the camera follow the player', expect: /Camera2D|Camera3D|Third-person camera/},
    {cat: 'howto', question: 'how do i save the players high score between sessions', expect: /Saving games|ConfigFile/},
    {cat: 'howto', question: 'how do i play a sound effect when the player gets hit', expect: /Audio streams|AudioStreamPlayer/},
    {cat: 'howto', question: 'how do i make my character jump', expect: /CharacterBody|2D movement|Kinematic character/},
    {cat: 'howto', question: 'how do i show a health bar above the player', expect: /TextureProgressBar|ProgressBar|Heads up display/},
    {cat: 'howto', question: 'whats the difference between preload and load', expect: /GDScript reference|When to use scenes versus scripts|Resources/},
    // "Input examples" contains literal click-on-the-sprite example code.
    {cat: 'howto', question: 'how do i detect when the player clicks on a sprite', expect: /CollisionObject2D|Area2D|Mouse and input coordinates|InputEvent|Input handling|Input examples/},
    {cat: 'howto', question: 'how do i make my character look at the mouse', expect: /2D movement|Node2D|Mouse and input coordinates|Vector math/},
    {cat: 'howto', question: 'how do i make an online multiplayer game', expect: /High-level multiplayer/},
    {cat: 'howto', question: 'does godot support c#', expect: /C#/},
    {cat: 'howto', question: 'how big can my game world be before things break', expect: /Large world coordinates/},
    {cat: 'howto', question: 'how do i make a main menu with buttons', expect: /Button|GUI|interface/i},

    // --- pasted error messages ----------------------------------------------
    // "Coding the player" quotes this exact error and explains the cause.
    {cat: 'error', question: "i get the error Attempt to call function 'play' in base 'null instance' on a null instance", expect: /Coding the player|Node/},
    // Same family; the corpus only has "null instance" errors generically.
    {cat: 'error', question: "Invalid get index 'position' (on base: 'null instance')", expect: /Node|Coding the player|Debug/},

    // --- gamedev-adjacent off-topic: must refuse (LLM gate, not threshold —
    // these mention Godot words and rerank above -4) --------------------------
    {cat: 'offtopic', question: 'how do i make a discord bot in gdscript'},
    {cat: 'offtopic', question: 'how do i import my unity project into godot'},
    {cat: 'offtopic', question: 'whats the best pizza topping'}
]

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')

if (verbose) console.log('Loading models ...')
await Promise.all([loadEmbedder(), loadReranker(), loadTable()])

const byCat = new Map<Category, {pass: number; total: number}>()
let ms = 0
for (const c of cases) {
    const t0 = performance.now()
    let pass: boolean
    let detail = ''
    if (c.expect) {
        const {candidates: pool, expansion, kept} = await retrieveDetailed(c.question)
        const hit = (x: {chapter: string; text: string}) => c.expect!.test(x.chapter) && (!c.text || c.text.test(x.text))
        pass = kept.some(hit)
        const inPool = pool.some(hit)
        detail = pass ? 'PASS' : inPool ? 'FAIL-rerank' : 'FAIL-pool'
        if (verbose || !pass) {
            console.log(`${detail}  [${c.cat}]  ${c.question}`)
            if (expansion && (verbose || !pass)) console.log(`    expansion: ${expansion}`)
            if (!pass) console.log(`    kept: ${kept.length ? kept.map(x => `${x.score.toFixed(2)} ${x.chapter}`).join(' | ') : '(nothing above threshold)'}`)
        }
    } else {
        // Must-refuse: the full pipeline has to end in found:false, whichever
        // gate does it. Needs the 27B; a server error counts as a failure so
        // it can't silently pass.
        try {
            const result = await query(c.question)
            pass = !result.found
        } catch (err) {
            pass = false
            detail = ` (query() threw: ${err instanceof Error ? err.message : String(err)})`
        }
        if (verbose || !pass) console.log(`${pass ? 'PASS' : 'FAIL-not-refused'}  [${c.cat}]  ${c.question}${detail}`)
    }
    ms += performance.now() - t0
    const s = byCat.get(c.cat) ?? {pass: 0, total: 0}
    s.total++
    if (pass) s.pass++
    byCat.set(c.cat, s)
}

// Baseline 29/33; the 4 documented misses are stable, the two flaky cases
// cost up to 2 more. Below 27 something new broke: investigate, don't lower.
const REALISTIC_MIN = 27

console.log('\n=== per category ===')
let passTotal = 0
for (const [cat, s] of byCat) {
    console.log(`${cat.padEnd(9)} ${s.pass}/${s.total}`)
    passTotal += s.pass
}
const ok = passTotal >= REALISTIC_MIN
console.log(`realistic: ${ok ? 'PASS' : 'FAIL'}  ${passTotal}/${cases.length} (min ${REALISTIC_MIN}; mean ${(ms / cases.length / 1000).toFixed(1)}s/question)`)
process.exit(ok ? 0 : 1)
