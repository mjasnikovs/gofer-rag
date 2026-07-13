// All tunable knobs live here so nothing important is buried in code.

export const config = {
    // source + labelling
    epubPath: 'docs/GodotEngine.epub',
    book: 'Godot Engine 4.7',

    // on-disk locations
    cacheDir: '.models', // where transformers.js caches model downloads (survives node_modules wipes)
    dbPath: '.lancedb',
    table: 'chunks',

    // local AI models (ONNX, run in-process via transformers.js) — serve time only
    embedModel: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    rerankModel: 'onnx-community/bge-reranker-v2-m3-ONNX',
    // fp16 is REQUIRED for the query embedder: documents are embedded by
    // llama.cpp (GGUF Q8_0), which tracks the true model space almost exactly
    // (cosine 0.9997 vs fp16 — measured). ONNX q8 lives in its own distorted
    // space (cosine 0.91 vs fp16 — measured), so q8 queries against llama.cpp
    // documents would silently wreck retrieval. fp16 costs ~106ms vs ~66ms per
    // query on CPU — noise next to the reranker + LLM.
    embedDtype: (process.env.RAG_DTYPE ?? 'fp16') as 'q8' | 'fp16' | 'fp32',
    // The reranker never touches the vector space — it reads (query, passage)
    // text pairs — so it stays q8: that's what its logit threshold was
    // calibrated on, and its fp16 ONNX export fails to load anyway
    // (SimplifiedLayerNormFusion graph bug, hit 2026-07-13).
    rerankDtype: 'q8' as 'q8' | 'fp16' | 'fp32',
    embedDims: 1024,

    // execution device for the serve-time ONNX models. Serving stays on CPU;
    // the GPU belongs to the 27B llama.cpp server.
    device: (process.env.RAG_DEVICE ?? 'cpu') as 'cpu' | 'cuda' | 'auto',

    // ingestion embedding box: a STOCK llama.cpp server container that embeds
    // and does nothing else. Same Qwen3-Embedding-0.6B model as above, official
    // GGUF; --pooling mean matches the transformers.js query embedder (verified
    // by cosine comparison, see scripts/validate-llamacpp-embed.ts).
    embedGgufPath: '.models/gguf/Qwen3-Embedding-0.6B-Q8_0.gguf',
    embedGgufUrl: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf',
    embedImageCuda: 'ghcr.io/ggml-org/llama.cpp:server-cuda',
    embedImageCpu: 'ghcr.io/ggml-org/llama.cpp:server',
    embedPort: 8091,

    // chunking — chars, not tokens (~4 chars per token → ~450 tokens / ~60 overlap)
    chunkChars: 1800,
    overlapChars: 240,

    // retrieval pipeline — hybrid: vector candidates catch paraphrases, BM25
    // full-text candidates catch exact tokens (class names like NavigationAgent2D,
    // which embedding similarity can miss entirely — measured: not in vector
    // top 100 for "What is a NavigationAgent2D used for?"). The union goes to
    // the reranker, which is the sole judge of relevance.
    vectorTopK: 20, // rough candidates pulled from LanceDB by embedding similarity
    // 10 BM25 candidates: every FTS-rescued chapter in the eval set ranks ≤5,
    // and each extra 10 candidates costs ~7s of CPU rerank per query
    // (measured 2026-07-13, scripts/eval-retrieval.ts).
    ftsTopK: 10, // rough candidates pulled by BM25 full-text match
    titleTopK: 8, // candidates from chapters whose title (= class name) appears in the question
    rerankKeep: 5, // how many survive reranking and reach the LLM
    rerankThreshold: 0, // raw reranker logit cutoff — below this we answer "not found"

    // the single refusal sentence — the LLM is told to emit it verbatim when the
    // context doesn't answer the question, and we detect it to return found:false
    notFoundMessage: "I don't have that information in the Godot documentation.",

    // answer generation (existing llama.cpp server, OpenAI-compatible)
    llmBaseUrl: 'http://localhost:8080/v1',
    llmModel: 'Qwen3.6-27B-NVFP4-MTP.gguf',

    apiPort: 3000
} as const
