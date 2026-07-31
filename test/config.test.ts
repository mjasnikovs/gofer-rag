import {afterEach, describe, expect, test} from 'bun:test'
import {join} from 'node:path'
import {configure, defaultCacheDir, getOptions, resetConfiguration} from '../src/config'

const originalEnvironment = {...process.env}

afterEach(() => {
    process.env = {...originalEnvironment}
    resetConfiguration()
})

describe('runtime configuration', () => {
    test('uses native user cache locations on Linux, macOS, and Windows', () => {
        delete process.env.GOFER_RAG_CACHE_DIR
        delete process.env.XDG_CACHE_HOME
        delete process.env.LOCALAPPDATA
        expect(defaultCacheDir('linux', '/users/test')).toBe(join('/users/test', '.cache', 'gofer-rag'))
        expect(defaultCacheDir('darwin', '/users/test')).toBe(join('/users/test', 'Library', 'Caches', 'gofer-rag'))
        expect(defaultCacheDir('win32', 'C:\\Users\\test')).toBe('C:\\Users\\test\\AppData\\Local\\gofer-rag')
    })

    test('accepts validated programmatic LLM and absolute path overrides', () => {
        const options = configure({
            cacheDir: '/tmp/gofer-cache',
            databasePath: '/tmp/gofer-db',
            llmBaseUrl: 'https://llm.example.test/v1/',
            llmModel: 'local-model'
        })
        expect(options.cacheDir).toBe('/tmp/gofer-cache')
        expect(options.databasePath).toBe('/tmp/gofer-db')
        expect(options.llmBaseUrl).toBe('https://llm.example.test/v1')
        expect(options.llmModel).toBe('local-model')
    })

    test('reads documented environment variables', () => {
        process.env.GOFER_RAG_CACHE_DIR = '/tmp/environment-cache'
        process.env.GOFER_RAG_DATABASE_PATH = '/tmp/environment-db'
        process.env.GOFER_RAG_LLM_BASE_URL = 'http://llm.test/v1'
        process.env.GOFER_RAG_LLM_MODEL = 'environment-model'
        process.env.GOFER_RAG_ALLOW_MODEL_DOWNLOADS = 'true'
        const options = getOptions()
        expect(options).toMatchObject({
            cacheDir: '/tmp/environment-cache',
            databasePath: '/tmp/environment-db',
            llmBaseUrl: 'http://llm.test/v1',
            llmModel: 'environment-model',
            allowModelDownloads: true
        })
    })

    test('rejects invalid paths, URLs, models, and booleans', () => {
        expect(() => configure({cacheDir: 'relative'})).toThrow('absolute path')
        resetConfiguration()
        expect(() => configure({llmBaseUrl: 'file:///tmp/socket'})).toThrow('http: or https:')
        resetConfiguration()
        expect(() => configure({llmModel: ' '})).toThrow('must not be empty')
        resetConfiguration()
        process.env.GOFER_RAG_ALLOW_MODEL_DOWNLOADS = 'maybe'
        expect(() => getOptions()).toThrow('must be one of')
    })
})
