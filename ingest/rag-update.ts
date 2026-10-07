// `bun run rag-update` — the smart launcher.
//
// It runs the ingest worker (ingest/ingest.ts) on the HOST — parsing, chunking
// and the LanceDB write are plain host work. The only heavy lifting, embedding,
// happens in a STOCK llama.cpp server container that does embedding and nothing
// else: no custom image, no baked node_modules, just the official
// ghcr.io/ggml-org/llama.cpp image plus ggml-org's EmbeddingGemma 2 GGUF
// (auto-downloaded to .models/gguf on first run, checked against its sha256).
//
// Why llama.cpp and not ONNX in the box (measured on this machine):
//   - fidelity: GGUF Q8_0 matches the PyTorch fp32 reference at cosine ≥ 0.9991
//     on all 7671 chunks, the serve-time q8 ONNX query vectors at ≥ 0.99994.
//   - speed: the full corpus in ~2 min on one GPU (2026-10-07).
//   - --pooling mean is the model's own pooling. The 512→768 projection after
//     it is inside the GGUF graph, so the box returns the finished vector.
//
// The box uses the GPU when a card has room, otherwise the CPU image. Whichever
// path is chosen is announced LOUDLY so a slow CPU run is never a surprise.

import {resolve} from 'node:path'
import {existsSync, mkdirSync, rmSync} from 'node:fs'
import {config} from '../src/config'

const BOX = 'gofer-embed'
const repoRoot = resolve(import.meta.dir, '..')
const ggufPath = resolve(repoRoot, config.embedGgufPath)

// The 270M Q8_0 model + context buffers want well under 2GB; below this much
// free VRAM the card is busy (usually the 27B llama.cpp server) — use CPU.
const MIN_FREE_MIB = 3000

function sh(cmd: string[]): {ok: boolean; out: string} {
    const p = Bun.spawnSync(cmd, {stdout: 'pipe', stderr: 'pipe'})
    return {ok: p.success, out: new TextDecoder().decode(p.stdout).trim()}
}

function banner(lines: string[]): void {
    const width = Math.max(...lines.map(l => l.length))
    const bar = '─'.repeat(width + 2)
    console.log(`┌${bar}┐`)
    for (const l of lines) console.log(`│ ${l.padEnd(width)} │`)
    console.log(`└${bar}┘`)
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<number> {
    const p = Bun.spawn(cmd, {cwd: repoRoot, stdio: ['inherit', 'inherit', 'inherit'], env: {...process.env, ...env}})
    return await p.exited
}

// Look at every GPU; return the free-VRAM ordering (roomiest first) if the best
// card clears the bar, else null. null means "embed on CPU".
//
// Only the winner is exposed to the container. Exposing both and letting the
// runtime "place" the model does not place it — llama.cpp splits it across
// every visible device, and a 639 MB model split two ways is pure overhead:
// with CUDA_VISIBLE_DEVICES=1,0 the 4070 SUPER carried 3.7 GB at 64% util
// while the roomier, faster 5070 Ti sat at 1.6 GB and 5%, and the corpus
// embedded at ~470 chunks/min instead of the ~1800 the single-card path gets
// (measured 2026-08-06). PCI_BUS_ID is still load-bearing: without it CUDA
// enumerates fastest-first and the index here selects the wrong card.
function pickGpus(): {order: string; note: string} | null {
    const smi = sh(['nvidia-smi', '--query-gpu=index,memory.free', '--format=csv,noheader,nounits'])
    if (!smi.ok || !smi.out) return null
    const gpus = smi.out
        .split('\n')
        .map(line => {
            const [idx, free] = line.split(',').map(s => Number(s.trim()))
            return {idx: idx!, free: free!}
        })
        .sort((a, b) => b.free - a.free)
    const best = gpus[0]!
    if (best.free < MIN_FREE_MIB) return null
    return {order: String(best.idx), note: `GPU ${best.idx} has ${best.free} MiB free`}
}

// Embedding runs only in the container. If Docker is missing there's no box.
if (!sh(['docker', 'version']).ok) {
    banner([
        'Docker is required for ingestion but was not found.',
        'Embedding runs in the stock llama.cpp Docker box; the host never embeds.',
        'Install Docker and re-run `bun run rag-update`.'
    ])
    process.exit(1)
}

// EmbeddingGemma 2 GGUF, fetched once. 310MB. The stored vectors are only
// valid against this exact file, so it is checked on every run, not just after
// the download.
if (!existsSync(ggufPath)) {
    banner(['Downloading EmbeddingGemma 2 Q8_0 GGUF (310MB, one-time) ...'])
    mkdirSync(resolve(ggufPath, '..'), {recursive: true})
    const res = await fetch(config.embedGgufUrl)
    if (!res.ok) {
        console.error(`download failed: ${res.status} ${res.statusText}`)
        process.exit(1)
    }
    await Bun.write(`${ggufPath}.part`, res)
    Bun.spawnSync(['mv', `${ggufPath}.part`, ggufPath])
}
const ggufHash = new Bun.CryptoHasher('sha256').update(await Bun.file(ggufPath).arrayBuffer()).digest('hex')
if (ggufHash !== config.embedGgufSha256) {
    console.error(
        `${ggufPath} has sha256 ${ggufHash}, expected ${config.embedGgufSha256}. Removed; re-run to fetch it again.`
    )
    rmSync(ggufPath)
    process.exit(1)
}

const gpu = pickGpus()
const image = gpu ? config.embedImageCuda : config.embedImageCpu

if (gpu)
    banner([
        'Embedding on GPU in the stock llama.cpp box — the fast path (~5min full corpus).',
        gpu.note,
        `that card only, so the model is not split across GPUs (CUDA_VISIBLE_DEVICES=${gpu.order})`
    ])
else
    banner([
        'Embedding on CPU in the stock llama.cpp box — the SLOW path.',
        'No GPU has enough free VRAM (is the 27B llama.cpp server running?).',
        'Free the GPU and re-run to use the fast path.'
    ])

// The box: llama.cpp server, embeddings only. --pooling mean is EmbeddingGemma's
// own pooling (validated against PyTorch — do not change casually).
sh(['docker', 'rm', '-f', BOX]) // clear any stale box from a crashed run
const started = sh([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    BOX,
    // PCI_BUS_ID is load-bearing: CUDA's default enumeration is fastest-first,
    // so without it CUDA_VISIBLE_DEVICES picks the WRONG card (measured
    // 2026-07-13 on the rerank box: it landed on the busy 5070 Ti instead of
    // the idle 3070 Ti and squeezed it to 22 MiB free).
    ...(gpu ? ['--gpus', 'all', '-e', 'CUDA_DEVICE_ORDER=PCI_BUS_ID', '-e', `CUDA_VISIBLE_DEVICES=${gpu.order}`] : []),
    '-v',
    `${resolve(ggufPath, '..')}:/models:ro`,
    '-p',
    `${config.embedPort}:8080`,
    image,
    '-m',
    `/models/${ggufPath.split('/').pop()}`,
    '--embeddings',
    '--pooling',
    'mean',
    '-ngl',
    '99',
    '-c',
    '8192',
    '-b',
    '4096',
    '-ub',
    '4096',
    '--host',
    '0.0.0.0',
    '--port',
    '8080'
])
if (!started.ok) {
    console.error('failed to start the embedding box (docker run failed)')
    process.exit(1)
}

// NOTE: no process.exit() inside the try — it would skip the finally and leave
// the box running (this happened; the teardown below must always execute).
let exitCode = 1
try {
    // Wait for the model to load. First run may also pull the image; docker run
    // handles the pull before the container starts, so /health is the only gate.
    const deadline = Date.now() + 120_000
    let healthy = false
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://localhost:${config.embedPort}/health`)
            if (res.ok) {
                healthy = true
                break
            }
        } catch {
            /* not up yet */
        }
        await Bun.sleep(1000)
    }
    if (!healthy) {
        console.error('embedding box never became healthy; logs:')
        await run(['docker', 'logs', BOX])
    } else {
        exitCode = await run(['bun', 'run', resolve(import.meta.dir, 'ingest.ts')], {
            EMBED_URL: `http://localhost:${config.embedPort}`,
            EMBED_LABEL: gpu ? `llama.cpp box, ${gpu.note}` : 'llama.cpp box, CPU'
        })
    }
} finally {
    sh(['docker', 'rm', '-f', BOX])
}
process.exit(exitCode)
