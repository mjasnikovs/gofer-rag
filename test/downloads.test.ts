import {afterEach, describe, expect, test} from 'bun:test'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp} from 'node:fs/promises'
import {configure, resetConfiguration} from '../src/config'
import {
    authorizeModelDownloads,
    isModelCached,
    modelDownload,
    progressCallback,
    resetDownloadApprovals
} from '../src/ai/downloads'
import type {ModelDownload} from '../src/types'

const temporaryDirectories: string[] = []

async function cacheDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'gofer-download-test-'))
    temporaryDirectories.push(directory)
    return directory
}

afterEach(async () => {
    resetConfiguration()
    resetDownloadApprovals()
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})))
})

describe('model download consent', () => {
    test('reports every missing model and records approval without downloading', async () => {
        const cacheDir = await cacheDirectory()
        let offered: ModelDownload[] = []
        configure({
            cacheDir,
            allowModelDownloads: models => {
                offered = models
                return true
            }
        })
        await authorizeModelDownloads(['embedder', 'reranker'])
        expect(offered.map(model => model.name)).toEqual([
            'onnx-community/Qwen3-Embedding-0.6B-ONNX',
            'onnx-community/bge-reranker-v2-m3-ONNX'
        ])
        expect(offered.every(model => model.source.startsWith('https://huggingface.co/'))).toBeTrue()
        expect(
            offered.every(model => model.destination.startsWith(cacheDir) && model.expectedBytes > 500_000_000)
        ).toBeTrue()
    })

    test('honors explicit rejection before creating cache files', async () => {
        const cacheDir = await cacheDirectory()
        configure({cacheDir, allowModelDownloads: () => false})
        expect(authorizeModelDownloads(['embedder'])).rejects.toThrow('Model download approval required')
        expect(await isModelCached('embedder')).toBeFalse()
    })

    test('fails actionably by default in noninteractive programmatic usage', async () => {
        configure({cacheDir: await cacheDirectory()})
        expect(authorizeModelDownloads(['reranker'])).rejects.toThrow('allowModelDownloads: true')
    })

    test('does not request consent when required files are cached', async () => {
        const cacheDir = await cacheDirectory()
        configure({cacheDir, allowModelDownloads: () => Promise.reject(new Error('must not prompt'))})
        const destination = modelDownload('reranker').destination
        for (const file of ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']) {
            await mkdir(join(destination, file, '..'), {recursive: true})
            await writeFile(join(destination, file), 'cached')
        }
        expect(await isModelCached('reranker')).toBeTrue()
        await authorizeModelDownloads(['reranker'])
    })

    test('forwards useful model download progress', async () => {
        const events: unknown[] = []
        configure({cacheDir: await cacheDirectory(), onDownloadProgress: event => events.push(event)})
        progressCallback('embedder')({status: 'progress', file: 'model.onnx', loaded: 10, total: 100, progress: 10})
        expect(events).toEqual([
            {
                model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
                status: 'progress',
                file: 'model.onnx',
                loaded: 10,
                total: 100,
                progress: 10
            }
        ])
    })
})
