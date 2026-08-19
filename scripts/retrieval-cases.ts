// The retrieval case list, shared by eval-retrieval.ts and the A/B harness.
// Lives in its own module because the eval runs at import time — importing it
// from anywhere else would execute it (same reason as fundamentals-cases.ts).
//
// Class-name lookups, how-to questions that already work, and the two off-topic
// probes that hold the refusal gate.

export type RetrievalCase = {question: string; expect?: RegExp} // no expect = must refuse

export const cases: RetrievalCase[] = [
    // class-name lookups — the known weak spot
    {question: 'What is a NavigationAgent2D used for?', expect: /NavigationAgent/},
    {question: 'How does NavigationAgent2D obstacle avoidance work?', expect: /NavigationAgent/},
    {question: 'What does the CharacterBody2D node do?', expect: /CharacterBody2D/},
    // "Introduction to the animation features" opens by defining AnimationPlayer,
    // so it counts as a correct source alongside the class-ref chapter.
    {question: 'What is an AnimationPlayer node?', expect: /AnimationPlayer|Introduction to the animation features/},
    // how-to questions — currently working, must not regress
    {question: 'How do I connect a signal to a method in GDScript?', expect: /signals/i},
    {question: 'How do I create an autoload singleton?', expect: /autoload|singleton/i},
    {question: 'How do I export a variable so it shows in the inspector?', expect: /export/i},
    {question: 'How do I detect when a body enters an Area2D?', expect: /Area2D/},
    // off-topic — the refusal gate must keep holding
    {question: 'How do I bake sourdough bread?'},
    {question: 'Who won the 2022 FIFA World Cup?'}
]
