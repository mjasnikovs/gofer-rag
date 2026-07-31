# @mjasnikovs/gofer-rag

Node.js retrieval and grounded answer generation over a packaged LanceDB snapshot of the official Godot Engine 4.7
documentation. Bun is used for repository development and ingestion, but is not required by package consumers.

## Install

```sh
npm install @mjasnikovs/gofer-rag@canary
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

Programmatic calls never prompt. On first use, callers must set `allowModelDownloads: true` or provide a consent
callback. Without consent, the call fails before downloading and reports model names, sources, destinations, and
expected sizes. The two runtime models require approximately 1.13 GiB and 0.55 GiB. Cached models require no consent.

The default cache is the operating system's user cache directory:

- Linux: `$XDG_CACHE_HOME/gofer-rag`, or `~/.cache/gofer-rag`
- macOS: `~/Library/Caches/gofer-rag`
- Windows: `%LOCALAPPDATA%\\gofer-rag`

Use the absolute-path `cacheDir` option or `GOFER_RAG_CACHE_DIR` to override it. LLM settings can also be supplied with
`GOFER_RAG_LLM_BASE_URL` and `GOFER_RAG_LLM_MODEL`. The packaged database is resolved from the installed module, not the
working directory; an absolute `databasePath` or `GOFER_RAG_DATABASE_PATH` can override it.

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
