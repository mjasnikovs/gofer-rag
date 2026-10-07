import {afterEach, describe, expect, test} from 'bun:test'
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ensureGguf} from '../ingest/gguf'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, {recursive: true, force: true})))

function file(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'gofer-gguf-test-'))
    directories.push(directory)
    const path = join(directory, 'model.gguf')
    writeFileSync(path, content)
    return path
}

// sha256 of "gguf"
const SHA = new Bun.CryptoHasher('sha256').update('gguf').digest('hex')

describe('pinned GGUF', () => {
    test('a cached file with the pinned hash is accepted without a download', async () => {
        const path = file('gguf')
        await ensureGguf({path, url: 'http://127.0.0.1:9/never-fetched', sha256: SHA})
        expect(existsSync(path)).toBeTrue()
    })

    test('a cached file with another hash is removed and refused', async () => {
        const path = file('reconverted')
        const checked = ensureGguf({path, url: 'http://127.0.0.1:9/never-fetched', sha256: SHA})
        expect(checked).rejects.toThrow(`expected ${SHA}`)
        await checked.catch(() => undefined)
        expect(existsSync(path)).toBeFalse()
    })
})
