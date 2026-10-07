// Read cached model files straight from the cache directory.
//
// transformers.js asks the Hub for tokenizer_config.json on every tokenizer
// load, even when cache_dir already holds it: get_tokenizer_files drops the
// options it was given. Offline that request fails and AutoTokenizer throws
// "undefined is not an object (evaluating 'tokenizerConfig.tokenizer_class')".
// Measured 2026-10-07 under `unshare -rn` for all three models with a full cache.
//
// Pointing the local model path at the cache dir makes the library find every
// file on disk first. A missing file still falls through to the Hub and lands
// in cache_dir, so a first download works as before (also measured).
//
// `env` is module-global, so it is set before every load rather than once:
// a process may use two cache dirs, and a host may share the module.

import {env} from '@huggingface/transformers'

export function useLocalCache(cacheDir: string): void {
    env.allowLocalModels = true
    env.localModelPath = cacheDir
}
