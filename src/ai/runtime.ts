// Central place to configure the transformers.js runtime. Imported for its
// side effect by the embedder and reranker so the cache dir is set exactly once.

import {env} from '@huggingface/transformers'
import {config} from '../config'

env.cacheDir = config.cacheDir
