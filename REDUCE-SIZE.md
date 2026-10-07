# Make gofer-rag shippable

## Why

Gofer is a Tauri desktop app. Today its built binary ships no JavaScript at all. It spawns
`node` on `.mjs` files read live from the developer's source tree, and those files resolve
their imports against the developer's `node_modules`. Editing a worker changes what an
already-built app runs.

The fix on the Gofer side is to bundle each worker and ship it as a Tauri resource. Two of
the five workers bundle clean. The three that touch gofer-rag do not, because gofer-rag
pulls native `.node` binaries that no bundler can inline.

So gofer-rag decides how big a shipped Gofer is.

## Measured today (linux x64)

| Thing                                | Size   |
| ------------------------------------ | ------ |
| `onnxruntime-node` bin/napi-v6/linux/x64 | 336 MB |
| — of which `libonnxruntime_providers_cuda.so` | 315 MB |
| — of which `libonnxruntime.so.1`     | 35 MB  |
| — of which `libonnxruntime_providers_tensorrt.so` | 0.9 MB |
| — of which `onnxruntime_binding.node` | 0.4 MB |
| `@lancedb/lancedb-linux-x64-gnu`     | 174 MB |
| — same binary, `strip --strip-all`   | 152 MB |
| `.lancedb/` shipped data             | 40 MB  |
| `@huggingface/transformers` JS       | 15 MB  |

Table `chunks`: 7671 rows, 1024-dim vectors. As float32 that is 31 MB.

## Goal

Gofer can ship gofer-rag with under ~80 MB of native code and data, and no dependency on a
developer's `node_modules`.

## Task 1 — drop the CUDA provider

`src/config.ts:130` defaults `device` to `'cpu'`. Nothing in Gofer sets `RAG_DEVICE`. The
CUDA and TensorRT providers are never loaded, and together they are 316 MB of the 336.

Work out how gofer-rag tells a consumer which onnxruntime files are actually required, so
Gofer's bundler can copy those and skip the rest. Options worth weighing:

- Export a manifest of required native files from the package.
- Document the CPU-only file set in the README.
- Pin the execution provider explicitly instead of leaving it env-overridable.

Acceptance: a consumer can determine the required file list without guessing, and running
the eval suite against only those files still passes.

## Task 2 — remove `@lancedb/lancedb`

This is the 174 MB. It is used only in `src/store/db.ts`, and only for:

- `vectorSearch` — cosine top-k over 7671 × 1024.
- `ftsSearch` — BM25 over the same rows.
- `titleSearch` — BM25 and `LIKE` filtered to named chapters.
- `chapterList` — distinct chapter values.
- `recreateTable` / `countRows` — ingest and diagnostics.

Brute-force cosine over 7671 × 1024 is 7.8 million multiply-adds. That is single-digit
milliseconds in plain JS. No ANN index is needed at this corpus size. BM25 over 7671 chunks
is a few hundred lines.

Replace the store with an in-process implementation. Keep the exported function signatures
in `src/store/db.ts` identical so `src/core/query.ts` does not change.

Design questions to settle first, not to assume:

- On-disk format. One file, or vectors and text separately. Float32 vs float16 vs int8.
- Load time and resident memory. Measure both. `mmap`-style lazy read vs read-all.
- Tokenizer parity. LanceDB's FTS tokenizer is the current behaviour, and the evals were
  tuned against it. Match it closely enough that scores hold, or retune deliberately.
- The 40-char token cap noted in `titleSearch`. Decide if the new index keeps it.

Acceptance: `bun run test:evals` scores are equal or better than the LanceDB baseline. Record
the before and after numbers in this file. `@lancedb/lancedb` is gone from `dependencies`.

## Rules

- Measure before and after. Do not ship a change to retrieval quality by accident.
- Capture the LanceDB eval baseline **first**, on the current `master`, before touching
  anything.
- `AGENTS.md` applies. `AGENT=1`, master only, prettier owns formatting.
- If Task 2 turns out to cost retrieval quality, say so with numbers and stop. Task 1 alone
  is already 315 MB.
