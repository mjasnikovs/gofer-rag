// The realistic-questions case list, shared by eval-realistic.ts (retrieval +
// refusal) and eval-answers.ts (judged answer quality). Lives in its own
// module because both evals run at import time — importing one from the other
// would execute it.
//
// Every `expect` was verified against the corpus (grep, 2026-07-14) — the
// chapters really do answer the question. Off-topic cases have no expect and
// must refuse via the full query() (reranker gate + LLM gate).

export type Category = 'vague' | 'typo' | 'godot3' | 'multi' | 'howto' | 'error' | 'offtopic'
// expect = chapter regex a kept chunk must match; text = that same chunk must
// also match this (guards against passing via an expected chapter's unrelated
// chunk). No expect = must refuse, judged via full query().
export type Case = {cat: Category; question: string; expect?: RegExp; text?: RegExp}

export const cases: Case[] = [
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
