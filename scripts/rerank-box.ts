// Rerank box launcher — runs any command with a llama.cpp reranker container
// alive and RAG_RERANK_URL pointing at it:
//
//   bun run scripts/rerank-box.ts bun run scripts/eval-retrieval.ts
//
// Why: the in-process ONNX CPU rerank is ~20s per query (scripts/diag-timing.ts,
// 2026-07-13) and dominates eval time. The box serves the SAME model
// (bge-reranker-v2-m3 Q8_0, auto-downloaded) via /v1/rerank; score parity with
// the ONNX logits was validated by scripts/validate-llamacpp-rerank.ts.
// Serving is untouched — only commands run through this launcher use the box.
//
// GPU only: the CPU box is SLOWER than in-process ONNX (measured 2026-07-13:
// 27.3s vs 19.7s for 38 candidates; GPU box is 0.9s). With no roomy GPU the
// command runs WITHOUT the box — plain in-process rerank — announced loudly.
// The container is torn down in a finally; no process.exit before it (a
// skipped finally leaked the embed box once).

import {resolve} from 'node:path'
import {existsSync, mkdirSync} from 'node:fs'
import {config} from '../src/config'

const BOX = 'gofer-rerank'
const repoRoot = resolve(import.meta.dir, '..')
const ggufPath = resolve(repoRoot, config.rerankGgufPath)

// 568M-param Q8 encoder: measured ~565 MiB total on-card at -ub 1024. Below
// this much free VRAM, skip the box (in-process rerank beats the CPU box).
const MIN_FREE_MIB = 1000

const command = process.argv.slice(2)
if (command.length === 0) {
    console.error('usage: bun run scripts/rerank-box.ts <command...>')
    process.exit(1)
}

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

// Roomiest GPU first, if any card clears the bar (same policy as rag-update).
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
    return {order: gpus.map(g => g.idx).join(','), note: `GPU ${best.idx} has ${best.free} MiB free`}
}

async function runCommand(env: Record<string, string> = {}): Promise<number> {
    const p = Bun.spawn(command, {
        cwd: repoRoot,
        stdio: ['inherit', 'inherit', 'inherit'],
        env: {...process.env, ...env}
    })
    return await p.exited
}

// No docker or no roomy GPU → the box can't help (CPU box measured slower than
// in-process). Run the command as-is, slow but correct. A stale box from a
// crashed run holds VRAM and would skew the GPU pick — clear it first.
const dockerOk = sh(['docker', 'version']).ok
if (dockerOk) sh(['docker', 'rm', '-f', BOX])
const gpu = dockerOk ? pickGpus() : null
if (!gpu) {
    banner([
        'No GPU has enough free VRAM (or Docker is missing) — running WITHOUT the',
        'rerank box, on the slow in-process CPU reranker (~20s/query).',
        'Free ~1GB of VRAM and re-run for the fast path.'
    ])
    process.exit(await runCommand())
}

if (!existsSync(ggufPath)) {
    banner(['Downloading bge-reranker-v2-m3 Q8_0 GGUF (~600MB, one-time) ...'])
    mkdirSync(resolve(ggufPath, '..'), {recursive: true})
    const res = await fetch(config.rerankGgufUrl)
    if (!res.ok) {
        console.error(`download failed: ${res.status} ${res.statusText}`)
        process.exit(1)
    }
    await Bun.write(`${ggufPath}.part`, res)
    Bun.spawnSync(['mv', `${ggufPath}.part`, ggufPath])
}

banner(['Reranking in the llama.cpp box on GPU (~0.5s/query vs ~20s in-process).', gpu.note])

// Encoder models process each (query, passage) pair as one non-causal batch,
// so the ubatch must fit a whole pair — measured up to 639 tokens (query +
// expansion + 1800-char chunk); -ub 1024 covers it while keeping the compute
// buffer small enough for a busy card. -np 4 slots rerank pairs in parallel.
// CUDA_DEVICE_ORDER=PCI_BUS_ID is load-bearing: without it CUDA enumerates
// fastest-first inside the container, so CUDA_VISIBLE_DEVICES picked the WRONG
// card (measured: the box landed on the busy 5070 Ti and squeezed it to
// 22 MiB free).
const started = sh([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    BOX,
    '--gpus',
    'all',
    '-e',
    'CUDA_DEVICE_ORDER=PCI_BUS_ID',
    '-e',
    `CUDA_VISIBLE_DEVICES=${gpu.order}`,
    '-v',
    `${resolve(ggufPath, '..')}:/models:ro`,
    '-p',
    `${config.rerankPort}:8080`,
    config.embedImageCuda,
    '-m',
    `/models/${ggufPath.split('/').pop()}`,
    '--rerank',
    '-np',
    '4',
    '-c',
    '8192',
    '-b',
    '1024',
    '-ub',
    '1024',
    '-ngl',
    '99',
    '--host',
    '0.0.0.0',
    '--port',
    '8080'
])
if (!started.ok) {
    console.error('failed to start the rerank box (docker run failed)')
    process.exit(1)
}

let exitCode = 1
try {
    const deadline = Date.now() + 120_000
    let healthy = false
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://localhost:${config.rerankPort}/health`)
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
        console.error('rerank box never became healthy; logs:')
        const logs = Bun.spawn(['docker', 'logs', BOX], {stdio: ['inherit', 'inherit', 'inherit']})
        await logs.exited
    } else {
        exitCode = await runCommand({RAG_RERANK_URL: `http://localhost:${config.rerankPort}`})
    }
} finally {
    sh(['docker', 'rm', '-f', BOX])
}
process.exit(exitCode)
