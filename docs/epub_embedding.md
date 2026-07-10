# EPUB Embedding with LanceDB

## How AnythingLLM Does It

### Architecture

The AnythingLLM monorepo has a **collector** service (separate Express server) that handles document parsing. The flow is:

```
Upload .epub → processSingleFile/index.js → asEPub.js → writeToServerDocuments → server embeds + stores in LanceDB
```

### Key Files

| Path | Role |
|---|---|
| `collector/utils/constants.js` | Maps `.epub` → `"./convert/asEPub.js"` in `SUPPORTED_FILETYPE_CONVERTERS` |
| `collector/processSingleFile/index.js` | Routes file extensions to the right converter via dynamic `require()` |
| `collector/processSingleFile/convert/asEPub.js` | **The actual epub handler** |
| `collector/utils/files/index.js` | `writeToServerDocuments()` — writes parsed docs as JSON to disk |

### How `asEPub.js` Works

```js
// Uses LangChain's EPubLoader (from @langchain/community)
const loader = new EPubLoader(fullFilePath, { splitChapters: false });
const docs = await loader.load();
docs.forEach((doc) => (content += doc.pageContent));
```

- Uses **LangChain's `EPubLoader`** (under the hood it uses `epub2` — a forked version via `git+https://github.com/Mintplex-Labs/epub2-static.git#main`)
- `splitChapters: false` → concatenates **all chapters into one big text blob**
- The concatenated text is wrapped in metadata and passed to `writeToServerDocuments()`
- That function just writes a `.json` file to disk — **no chunking or embedding happens here**

### Where Chunking/Embedding Happens

The collector only **parses and extracts text**. The actual chunking + embedding + LanceDB storage happens in the **server** component, which reads those `.json` files from the collector's output folder and processes them via its own embedding pipeline (using whatever embedder is configured — built-in, Ollama, OpenAI, etc.).

### Dependencies Used

From `collector/package.json`:

- **`epub2`** — forked as `git+https://github.com/Mintplex-Labs/epub2-static.git#main` (they had to patch it due to bugs)
- **`@langchain/community`** — provides `EPubLoader` which wraps epub2
- **`langchain`** — document loading/chaining utilities
- **`turndown`**, **`html-to-text`**, **`node-html-parser`** — HTML → text conversion
- **`@xenova/transformers`** — for built-in embeddings (sentence-transformers in browser/Node)
- **`js-tiktoken`** — token counting for chunk sizing

### Notable Gotchas

- They use a **forked `epub2`** because the upstream had bugs (e.g., [issue #3418](https://github.com/Mintplex-Labs/anything-llm/issues/3418) — `trim is not a function` crash in epub2's nav parsing). They applied patches via `patch-package`.
- EPUB support was added relatively late ([feature request #709](https://github.com/Mintplex-Labs/anything-llm/issues/709)) and has had reliability issues with certain files.

---

## Alternative EPUB Parsing Libraries (Node.js)

| Library | Notes |
|---|---|
| [`epub`](https://www.npmjs.com/package/epub) | Well-maintained. Parse with `new EPub(path).parse()`, then iterate `epub.flow` to get chapter IDs, call `getChapter(id)` for HTML text or `getChapterRaw()` for raw content. Also exposes metadata, images, etc. |
| [`@lingo-reader/epub-parser`](https://www.npmjs.com/package/@lingo-reader/epub-parser) | More feature-rich API: `getFileInfo()`, `getMetadata()`, `getManifest()`, `loadChapter(id)`. Part of a larger e-book parser ecosystem. |
| [`epub2`](https://www.npmjs.com/package/epub2) | Simpler, older alternative. Similar API surface. Last updated ~3 years ago. |
| [`epub-to-text`](https://github.com/Projet-TAMIS/epub-to-text) | Converts EPUB → plain text chapters directly. Simple callback-based API: `extract(path, cb)` yields plain text per chapter. Good if you just need raw text without HTML. |

## LanceDB Embedding Side

LanceDB supports **custom embedding functions** in TypeScript. You subclass `TextEmbeddingFunction` from `@lancedb/lancedb/embedding`:

```ts
import { TextEmbeddingFunction, register } from "@lancedb/lancedb/embedding"

@register("my-embedder")
class MyEmbedder extends TextEmbeddingFunction {
  name = "your-model-id"
  // implement: init(), ndims(), toJSON(), generateEmbeddings(texts: string[])
}
```

LanceDB's built-in providers include **OpenAI**, **Sentence Transformers**, **Hugging Face**, and **Cohere** — so you can pair any epub parser with any of those.

## Recommended Pipeline for `.epub` → LanceDB

> **Note:** Don't copy AnythingLLM's `splitChapters: false` blob-concatenation. EPUB already carries clean structural boundaries (chapters, headings, TOC) — those are the single most valuable retrieval signal, so preserve them instead of flattening the book into one text blob.

### Baseline (best value — start here)

1. **Parse EPUB preserving structure** → `epub` or `@lingo-reader/epub-parser`, keeping chapter/heading boundaries and the TOC. (On **Bun**: smoke-test the parser first — these libs lean on Node zip/stream internals.)
2. **Strip HTML** (if using `getChapter()` which returns HTML) — e.g., with `turndown` or `linkedom`.
3. **Chunk with structure awareness** — recursive splitting at **~400–512 tokens** with overlap, *snapped to chapter/section boundaries* (never let a chunk cross a chapter). This baseline measured ~85–90% recall in Chroma's tests without extra computational cost. Prefer token-based sizing over raw char counts.
4. **Attach rich metadata** — `{ book, chapter title, section/heading, order }`. Metadata gives retrieval signals beyond pure vector similarity.
5. **Embed** — use a LanceDB embedding function (built-in OpenAI/Sentence Transformers, or a custom one).
6. **Upsert into LanceDB** — store vectors + metadata.

### Upgrades (only if baseline retrieval is insufficient)

- **Semantic chunking + merge** — split on embedding-similarity drops, then *merge* fragments up to ~200–400 tokens. The merge step is not optional: naked semantic chunking produces ~43-token fragments that *hurt* accuracy (FloTorch found it ~15 pts behind recursive splitting); merging recovers it and can add ~9% recall. Tune the threshold: **0.7–0.8** for technical docs (e.g. a Godot manual), **0.5–0.6** for narrative prose.
- **Late chunking** ([Jina](https://jina.ai/news/late-chunking-in-long-context-embedding-models/)) — embed the whole long text first with a long-context model, then pool into chunks *after* the transformer, so each chunk embedding carries whole-document context. Strong gains on long documents, and **no extra LLM calls**.
- **Contextual retrieval** ([Anthropic](https://www.anthropic.com/news/contextual-retrieval)) — prepend a 50–100 token LLM-generated context blurb to each chunk before embedding. ~5–15% precision gain, but costs one LLM call per chunk.

## References

- [AnythingLLM GitHub](https://github.com/mintplex-labs/anything-llm)
- [LanceDB Embedding Docs](https://docs.lancedb.com/embedding)
- [LanceDB Custom Embedding Functions](https://lancedb.github.io/lancedb/embeddings/custom_embedding_function/)
- [EPUB Support Feature Request (#709)](https://github.com/Mintplex-Labs/anything-llm/issues/709)
- [EPUB Bug Report (#3418)](https://github.com/Mintplex-Labs/anything-llm/issues/3418)
- [Best Chunking Strategies for RAG in 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-chunking-strategies-rag)
- [Semantic Chunking: 5 Best Practices (Extend)](https://www.extend.ai/resources/semantic-chunking-methods-5-best-practices-rag-results)
- [Late Chunking in Long-Context Embedding Models (Jina)](https://jina.ai/news/late-chunking-in-long-context-embedding-models/)
- [Late Chunking paper (arXiv 2409.04701)](https://arxiv.org/abs/2409.04701)
- [Contextual Retrieval (Anthropic)](https://www.anthropic.com/news/contextual-retrieval)
