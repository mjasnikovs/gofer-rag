// Load models with transformers.js reading gofer's cache, then put its global
// settings back.
//
// transformers.js asks the Hub for tokenizer_config.json on every tokenizer
// load, even when cache_dir already holds it: get_tokenizer_files drops the
// options it was given. Offline that request fails and AutoTokenizer throws
// "undefined is not an object (evaluating 'tokenizerConfig.tokenizer_class')".
// Measured 2026-10-07 under `unshare -rn` for all three models with a full cache.
// Pointing the local model path at the cache dir makes the library find every
// file on disk first. A missing file still falls through to the Hub and lands
// in cache_dir, so a first download works as before (also measured).
//
// `env` is module-global and shared with any host that uses transformers.js
// itself, so it is only changed for the length of a load and restored after.
// Loads queue behind each other: two overlapping loads that each saved and
// restored the env could leave it holding the other's values for good.

import {LogLevel, env} from '@huggingface/transformers'

let queue: Promise<unknown> = Promise.resolve()

// `quiet` raises the log level to ERROR for this load only.
export function loadFromCache<T>(cacheDir: string, load: () => Promise<T>, quiet = false): Promise<T> {
    const run = async (): Promise<T> => {
        const saved = {
            allowLocalModels: env.allowLocalModels,
            localModelPath: env.localModelPath,
            logLevel: env.logLevel
        }
        env.allowLocalModels = true
        env.localModelPath = cacheDir
        if (quiet) env.logLevel = LogLevel.ERROR
        try {
            return await load()
        } finally {
            Object.assign(env, saved)
        }
    }
    const result = queue.then(run, run)
    queue = result.catch(() => undefined)
    return result
}
