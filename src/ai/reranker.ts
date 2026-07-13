// bge-reranker-v2-m3 — a cross-encoder that scores how well a passage answers a
// query. Higher logit = more relevant.
//
// NOTE: do NOT use the text-classification pipeline. This model has a single
// output label, and that pipeline softmaxes over it, which always yields 1.0 and
// throws the score away. We call the model directly and read the raw logit.

import {
    AutoTokenizer,
    AutoModelForSequenceClassification,
    type PreTrainedTokenizer,
    type PreTrainedModel
} from '@huggingface/transformers'
import './runtime'
import {config} from '../config'

let tokenizer: PreTrainedTokenizer | null = null
let model: PreTrainedModel | null = null

async function load(): Promise<{tokenizer: PreTrainedTokenizer; model: PreTrainedModel}> {
    if (!tokenizer) tokenizer = await AutoTokenizer.from_pretrained(config.rerankModel)
    if (!model)
        model = await AutoModelForSequenceClassification.from_pretrained(config.rerankModel, {
            dtype: config.rerankDtype,
            device: config.device
        })
    return {tokenizer, model}
}

// Warm the model so the first real request isn't slow.
export async function loadReranker(): Promise<void> {
    await load()
}

type SequenceClassifierOutput = {
    logits: {tolist(): number[][]}
}

// Returns one relevance logit per passage, in the same order as the input.
export async function rerank(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return []
    const {tokenizer: tok, model: mdl} = await load()
    const inputs = tok(new Array<string>(passages.length).fill(query), {
        text_pair: passages,
        padding: true,
        truncation: true
    })
    const output = (await mdl(inputs)) as unknown as SequenceClassifierOutput
    return output.logits.tolist().map(row => row[0]!)
}
