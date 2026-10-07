import {afterEach, describe, expect, test} from 'bun:test'
import {env} from '@huggingface/transformers'
import {useLocalCache} from '../src/ai/local-cache'

const before = {allowLocalModels: env.allowLocalModels, localModelPath: env.localModelPath}

afterEach(() => Object.assign(env, before))

// Offline, transformers.js only finds a cached tokenizer through the local model
// path (measured under `unshare -rn`), so every loader must point it at the cache.
describe('local model cache', () => {
    test('points transformers.js at the cache dir as its local model path', () => {
        useLocalCache('/tmp/gofer-cache-a')
        expect(env.allowLocalModels).toBeTrue()
        expect(env.localModelPath).toBe('/tmp/gofer-cache-a')
        useLocalCache('/tmp/gofer-cache-b')
        expect(env.localModelPath).toBe('/tmp/gofer-cache-b')
    })
})
