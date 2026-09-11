# @mjasnikovs/gofer-rag

![Gofer mascot reading the Godot Manual](docs/assets/gofer-hero.png)

Node.js retrieval and grounded answer generation over a packaged LanceDB snapshot of the official Godot Engine 4.7
documentation. Bun is used for repository development and ingestion, but is not required by package consumers.

## Install

```sh
npm install @mjasnikovs/gofer-rag
```

Node.js 22 or newer is required.

## Programmatic API

```ts
import {query, retrieve} from '@mjasnikovs/gofer-rag'

const passages = await retrieve('How do I connect a signal?', {
    allowModelDownloads: models => {
        for (const model of models) console.log(model.name, model.source, model.destination, model.expectedBytes)
        return true
    },
    onDownloadProgress: progress => console.log(progress)
})

const answer = await query('How do I connect a signal?', {
    llmBaseUrl: 'http://localhost:8080/v1',
    llmModel: 'Qwen3.6-27B-NVFP4-MTP.gguf',
    allowModelDownloads: true
})
```

`retrieve()` is independent of answer generation and does not require the LLM server. `query()` retrieves first and then
calls an OpenAI-compatible local chat-completions endpoint. Importing the package starts no CLI or server.

### Bounding how much comes back

`retrieve()` returns about five passages of up to ~1800 characters each. A host on a context budget can cap that with
`maxPassages`:

```ts
const passages = await retrieve('How do I connect a signal?', {maxPassages: 4, allowModelDownloads: true})
```

**Use this instead of slicing the returned array.** Some passages are title pins — a chapter the question named
verbatim, rescued into the result because the reranker under-ranked its reference page. A pin always scores below every
passage the score kept, so it always sits last, so `slice(0, n)` cuts the rescues first. `maxPassages` is applied before
pinning and reserves room for one, so the rescue survives. Pinned passages carry `pinned: true` if you need to tell them
apart.

Measured over the 83 labelled questions in this repo's eval sets (`bun run scripts/ab-cut.ts`):

| `maxPassages` | passages/call | share of the bytes | labelled cases lost |
| ------------- | ------------- | ------------------ | ------------------- |
| unset         | 4.58          | 100%               | —                   |
| 4             | 3.63          | 79%                | none                |
| 3             | 2.73          | 60%                | 2                   |
| 2             | 1.83          | 39%                | 6                   |

Like every option here it is sticky: `configure()` merges into module-level state, so setting it once sets it for the
process. `GOFER_RAG_MAX_PASSAGES` does the same from the environment.

### Nothing found is an answer

`retrieve()` returns an empty array when the corpus has nothing on the question, and `query()` returns `{found: false}`.
That is a real result, not a failure — treat it as "the documentation does not cover this" and say so, rather than
falling back to the nearest passage.

Two gates produce it. A passage must clear the reranker threshold to be returned at all, and the _best_ passage must
also clear an answer floor: a pool whose top scores below it holds no answer, only the page that ranked least badly.
Without the floor, "gofer node.set_cells cell parameter atlas source format" — a question about a tool that is not in
the Godot manual — came back as an unrelated tilemap passage. The floor sits at -0.5 rather than 0 because 0 also
discards correct answers to casually worded questions, whose right chapter lands just under zero.
`bun run scripts/ab-floor.ts` is the paired measurement.

## Supplying your own model connection

A host that already has a configured model connection can hand it over with the `complete` option instead of pointing
this package at a second endpoint. Both model calls — query expansion and answer generation — then run through it, so
`llmBaseUrl` and `llmModel` are unused.

```ts
const answer = await query('How do I smoothly animate a value?', {
    complete: async ({system, user, maxTokens}) => myModel.chat({system, user, maxTokens}),
    allowModelDownloads: true
})
```

Return the assistant's text with any thinking or reasoning already stripped — only the host knows its provider's
dialect. Honour `maxTokens`: it is sized to cover a reasoning model's scratchpad plus its reply, and a smaller budget
truncates the answer away. The prompts and the guards stay in this package: the expansion is still rejected unless it
comes back as a term list, and the answer is still checked against the refusal gate. A `complete` that throws degrades
exactly like an unreachable server — expansion is skipped and retrieval runs unexpanded.

Programmatic calls never prompt. On first use, callers must set `allowModelDownloads: true` or provide a consent
callback. Without consent, the call fails before downloading and reports model names, sources, destinations, and
expected sizes. The three runtime models require approximately 1.13 GiB, 0.55 GiB and 0.02 GiB. Cached models require no
consent.

The default cache is the operating system's user cache directory:

- Linux: `$XDG_CACHE_HOME/gofer-rag`, or `~/.cache/gofer-rag`
- macOS: `~/Library/Caches/gofer-rag`
- Windows: `%LOCALAPPDATA%\\gofer-rag`

Use the absolute-path `cacheDir` option or `GOFER_RAG_CACHE_DIR` to override it. LLM settings can also be supplied with
`GOFER_RAG_LLM_BASE_URL` and `GOFER_RAG_LLM_MODEL`, and the passage ceiling with `GOFER_RAG_MAX_PASSAGES`. The packaged
database is resolved from the installed module, not the working directory; an absolute `databasePath` or
`GOFER_RAG_DATABASE_PATH` can override it.

## CLI

```sh
gofer-rag --help
gofer-rag --retrieve 'What is CharacterBody2D?'
gofer-rag --allow-downloads 'How do I move a player?'
```

An interactive terminal asks before first-run downloads. Noninteractive use must pass `--allow-downloads`, set
`GOFER_RAG_ALLOW_MODEL_DOWNLOADS=true`, or use an already populated cache.

## Documentation data

The included LanceDB is an adapted, chunked, and embedded form of the official Godot Engine 4.7 documentation. See
`NOTICE-DATA.md` and the accompanying CC BY 3.0 and MIT data license files.

## License

The package code is available under the MIT License in `LICENSE`. The packaged documentation data retains its upstream
CC BY 3.0 and MIT terms described in `NOTICE-DATA.md`.
