import {afterEach, describe, expect, test} from 'bun:test'
import {LogLevel, env} from '@huggingface/transformers'
import {loadFromCache} from '../src/ai/local-cache'

const host = {allowLocalModels: false, localModelPath: '/host/models', logLevel: LogLevel.INFO}
const before = {allowLocalModels: env.allowLocalModels, localModelPath: env.localModelPath, logLevel: env.logLevel}

afterEach(() => Object.assign(env, before))

const snapshot = () => ({
    allowLocalModels: env.allowLocalModels,
    localModelPath: env.localModelPath,
    logLevel: env.logLevel
})

// Offline, transformers.js only finds a cached tokenizer through the local model
// path (measured under `unshare -rn`). The env is shared with the host, so it
// must hold gofer's values during a load and the host's after.
describe('loading from the model cache', () => {
    test('points transformers.js at the cache during the load and restores the host env after', async () => {
        Object.assign(env, host)
        const during = await loadFromCache('/tmp/gofer-cache', () => Promise.resolve(snapshot()), true)
        expect(during).toEqual({allowLocalModels: true, localModelPath: '/tmp/gofer-cache', logLevel: LogLevel.ERROR})
        expect(snapshot()).toEqual(host)
    })

    test('restores the host env when the load throws', async () => {
        Object.assign(env, host)
        const failing = loadFromCache('/tmp/gofer-cache', () => Promise.reject(new Error('no model')), true)
        expect(failing).rejects.toThrow('no model')
        await failing.catch(() => undefined)
        expect(snapshot()).toEqual(host)
    })

    test('overlapping loads run one after another, so neither restores the other env', async () => {
        Object.assign(env, host)
        const order: string[] = []
        const slow = (name: string) => async () => {
            order.push(`${name} start ${env.localModelPath}`)
            await new Promise(resolve => setTimeout(resolve, 10))
            order.push(`${name} end`)
        }
        await Promise.all([loadFromCache('/a', slow('a'), true), loadFromCache('/b', slow('b'))])
        expect(order).toEqual(['a start /a', 'a end', 'b start /b', 'b end'])
        expect(snapshot()).toEqual(host)
    })
})
