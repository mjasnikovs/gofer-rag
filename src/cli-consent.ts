import {formatBytes} from './ai/downloads.js'
import type {ModelDownload} from './types.js'

export type ConsentQuestion = (prompt: string) => Promise<string>

export function downloadPrompt(models: ModelDownload[]): string {
    const details = models
        .map(
            model =>
                `- ${model.name}\n  source: ${model.source}\n  destination: ${model.destination}\n  expected: ${formatBytes(model.expectedBytes)} (${model.expectedBytes} bytes)`
        )
        .join('\n')
    return `The following models are not cached and must be downloaded:\n${details}\nDownload now? [y/N] `
}

export async function requestDownloadConsent(models: ModelDownload[], ask: ConsentQuestion): Promise<boolean> {
    const answer = await ask(downloadPrompt(models))
    return /^(y|yes)$/i.test(answer.trim())
}
