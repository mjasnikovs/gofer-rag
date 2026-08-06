// The fundamentals case list, shared by eval-fundamentals.ts and the A/B
// harness. Lives in its own module because the eval runs at import time —
// importing it from anywhere else would execute it (same reason as
// realistic-cases.ts).
//
// Twenty questions a beginner actually asks, each pointing at the TUTORIAL
// chapter that teaches the thing — never a class-reference page. Every expected
// chapter was verified against the corpus (2026-08-06) by reading its own
// chunks, not by assuming the title fits:
//
//   Using signals 21-2/21-5      "Connecting a signal in the editor" and the
//                                timer.timeout.connect(_on_timer_timeout) walkthrough
//   Overridable functions 362-0  "_enter_tree() and _ready() ... when the node
//                                enters the scene tree"
//   Nodes and scene instances    "how to get nodes, create nodes, add them as a
//     361-0                      child, and instantiate scenes from code"
//   2D movement overview 90-0    'Every beginner has been there: "How do I move
//                                my character?"'
//   Creating instances 17-0      explicitly editor-only ("To learn how to instance
//                                scenes from code, see Nodes and scene instances"),
//                                so the runtime-instancing questions do NOT accept it
//
// Where two chapters teach the same thing equally well both are accepted
// (Overridable functions / Godot notifications; Idle and Physics Processing /
// Overridable functions) — the point of the set is "a tutorial, not a class
// page", not "one blessed chapter".

export type FundamentalCase = {question: string; expect: RegExp}

export const cases: FundamentalCase[] = [
    {question: 'How do I connect a signal to a method in GDScript?', expect: /Using signals/},
    {question: 'How do I declare my own signal and emit it from a script?', expect: /Using signals|Instancing with signals/},
    {question: 'How do I run code when a node enters the scene tree?', expect: /Overridable functions|Godot notifications/},
    {question: 'How do I run code every frame?', expect: /Idle and Physics Processing|Overridable functions/},
    {question: 'How do I create a scene instance from code while the game is running?', expect: /Nodes and scene instances/},
    {question: 'How do I get a reference to another node from my script?', expect: /Nodes and scene instances/},
    {question: 'How do I add a child node from code?', expect: /Nodes and scene instances/},
    {question: 'How do I move a character with the keyboard?', expect: /2D movement overview|Moving the player with code|Kinematic character/},
    {question: 'How do I read the keys and mouse buttons the player presses?', expect: /Listening to player input|Input examples|Using InputEvent|Input handling/},
    {question: 'How do I write my first script and attach it to a node?', expect: /Creating your first script/},
    {question: 'How do I make a variable editable in the inspector?', expect: /GDScript exported properties/},
    {question: 'How do I store a value that every scene can read?', expect: /Singletons \(Autoload\)|Autoloads versus regular nodes/},
    {question: 'How do I pause the game?', expect: /Pausing games and process mode/},
    {question: 'How do I save the player progress to a file?', expect: /Saving games/},
    // "Using SceneTree" 372-3 has the "Changing current scene" section with the
    // get_tree().change_scene_to_file() example, so it answers this as squarely
    // as "Change scenes manually" does (checked 2026-08-06, after a first run
    // ranked it above the narrower expectation).
    {question: 'How do I change to another scene from code?', expect: /Change scenes manually|Using SceneTree/},
    {question: 'How do I keep the HUD on screen while the camera moves?', expect: /Canvas layers/},
    {question: 'How do I pick a random number?', expect: /Random number generation/},
    {question: 'How do I detect when two objects collide?', expect: /Physics introduction|Using Area2D/},
    {question: 'How do I make an object fall with gravity?', expect: /Physics introduction|Using Jolt Physics/},
    {question: 'How do I play a sound effect?', expect: /Audio streams|Audio buses/}
]
