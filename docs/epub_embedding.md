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

1. **Parse EPUB** → `epub` or `@lingo-reader/epub-parser` to extract chapter text
2. **Strip HTML** (if using `getChapter()` which returns HTML) — e.g., with `turndown` or `linkedom`
3. **Chunk the text** — split into ~1000-char chunks with overlap
4. **Embed** — use a LanceDB embedding function (built-in like OpenAI/Sentence Transformers, or your own custom one)
5. **Upsert into LanceDB** — store vectors + metadata (chapter title, page range, etc.)

## References

- [AnythingLLM GitHub](https://github.com/mintplex-labs/anything-llm)
- [LanceDB Embedding Docs](https://docs.lancedb.com/embedding)
- [LanceDB Custom Embedding Functions](https://lancedb.github.io/lancedb/embeddings/custom_embedding_function/)
- [EPUB Support Feature Request (#709)](https://github.com/Mintplex-Labs/anything-llm/issues/709)
- [EPUB Bug Report (#3418)](https://github.com/Mintplex-Labs/anything-llm/issues/3418)
