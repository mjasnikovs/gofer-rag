import {afterEach, describe, expect, test} from 'bun:test'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp} from 'node:fs/promises'
import {configure, resetConfiguration} from '../src/config'
import {
    authorizeModelDownloads,
    embedDtype,
    embedderDefinition,
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
            'onnx-community/embeddinggemma-2-ONNX',
            'onnx-community/bge-reranker-v2-m3-ONNX'
        ])
        expect(offered.every(model => model.source.startsWith('https://huggingface.co/'))).toBeTrue()
        expect(offered.every(model => model.destination.startsWith(cacheDir))).toBeTrue()
        expect(offered.map(model => model.expectedBytes)).toEqual([346_397_233, 587_812_045])
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
        for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
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
                model: 'onnx-community/embeddinggemma-2-ONNX',
                status: 'progress',
                file: 'model.onnx',
                loaded: 10,
                total: 100,
                progress: 10
            }
        ])
    })

    test('a cache without tokenizer_config.json is not cached, since the tokenizer cannot load offline', async () => {
        const cacheDir = await cacheDirectory()
        configure({cacheDir})
        const destination = modelDownload('reranker').destination
        for (const file of ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']) {
            await mkdir(join(destination, file, '..'), {recursive: true})
            await writeFile(join(destination, file), 'cached')
        }
        expect(await isModelCached('reranker')).toBeFalse()
    })

    test('an unsupported RAG_DTYPE fails before consent instead of checking the q8 files', () => {
        expect(embedDtype('q8')).toBe('q8')
        expect(embedDtype('fp32')).toBe('fp32')
        expect(() => embedDtype('q4')).toThrow('RAG_DTYPE=q4 is not supported')
        expect(() => embedDtype('fp16')).toThrow('fp16 overflows')
    })

    test('the embedder manifest follows the dtype, weights file and its external data together', () => {
        expect(embedderDefinition('q8')).toEqual({
            id: 'onnx-community/embeddinggemma-2-ONNX',
            expectedBytes: 346_397_233,
            requiredFiles: [
                'config.json',
                'tokenizer.json',
                'tokenizer_config.json',
                'onnx/model_quantized.onnx',
                'onnx/model_quantized.onnx_data'
            ]
        })
        expect(embedderDefinition('fp32').requiredFiles.slice(3)).toEqual(['onnx/model.onnx', 'onnx/model.onnx_data'])
        expect(embedderDefinition('fp32').expectedBytes).toBe(1_116_768_801)
    })
})
