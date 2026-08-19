// The paraphrase case list, shared by eval-paraphrase.ts and the A/B harness.
// Lives in its own module because the eval runs at import time — importing it
// from anywhere else would execute it (same reason as fundamentals-cases.ts).
//
// How-to questions that name NO class or member symbol, so titleSearch cannot
// fire on the raw question and retrieval rides on vector similarity + BM25 +
// LLM query expansion. Each lists the chapters a Godot developer would accept.

export type ParaphraseCase = {question: string; expect: RegExp}

export const cases: ParaphraseCase[] = [
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
