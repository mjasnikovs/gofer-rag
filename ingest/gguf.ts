// Fetch a GGUF once, then check it against its pinned sha256 on every run.
//
// Stored vectors and calibrated rerank thresholds are only valid against the
// exact file that produced them, and Hub repos re-upload under the same name
// (ggml-org reconverts automatically). Streaming keeps the hash at constant
// memory beside a running 27B server.

import {existsSync, mkdirSync, renameSync, rmSync} from 'node:fs'
import {resolve} from 'node:path'

export type PinnedGguf = {
    path: string
    url: string
    sha256: string
}

export async function ensureGguf(gguf: PinnedGguf): Promise<void> {
    if (!existsSync(gguf.path)) {
        mkdirSync(resolve(gguf.path, '..'), {recursive: true})
        const res = await fetch(gguf.url)
        if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${gguf.url}`)
        await Bun.write(`${gguf.path}.part`, res)
        renameSync(`${gguf.path}.part`, gguf.path)
    }
    const hasher = new Bun.CryptoHasher('sha256')
    for await (const chunk of Bun.file(gguf.path).stream()) hasher.update(chunk)
    const actual = hasher.digest('hex')
    if (actual === gguf.sha256) return
    rmSync(gguf.path)
    throw new Error(`${gguf.path} has sha256 ${actual}, expected ${gguf.sha256}. Removed; re-run to fetch it again.`)
}
