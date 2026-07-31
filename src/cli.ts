#!/usr/bin/env node

import {createInterface} from 'node:readline/promises'
import {stdin, stdout} from 'node:process'
import {configure} from './config.js'
import {formatBytes} from './ai/downloads.js'
import {requestDownloadConsent} from './cli-consent.js'
import {query, retrieve} from './index.js'
import {databaseInfo} from './store/db.js'
import type {DownloadProgress, GoferOptions, ModelDownload} from './types.js'

const HELP = `gofer-rag — query the packaged Godot 4.7 documentation

Usage:
  gofer-rag [--retrieve] [--allow-downloads] <question>
  gofer-rag --database-info
  gofer-rag --help

Options:
  --retrieve          Return ranked documentation passages without generating an answer
  --allow-downloads   Approve required Hugging Face model downloads without prompting
  --database-info     Verify and describe the packaged LanceDB database
  --help              Show this help

Environment:
  GOFER_RAG_CACHE_DIR              Absolute model-cache directory
  GOFER_RAG_DATABASE_PATH          Absolute LanceDB override
  GOFER_RAG_LLM_BASE_URL           OpenAI-compatible base URL (default http://localhost:8080/v1)
  GOFER_RAG_LLM_MODEL              Model name (default Qwen3.6-27B-NVFP4-MTP.gguf)
  GOFER_RAG_ALLOW_MODEL_DOWNLOADS  true/false; explicit noninteractive consent
`

async function promptForDownloads(models: ModelDownload[]): Promise<boolean> {
    const rl = createInterface({input: stdin, output: stdout})
    const allowed = await requestDownloadConsent(models, prompt => rl.question(prompt))
    rl.close()
    return allowed
}

function reportProgress(progress: DownloadProgress): void {
    if (progress.status !== 'progress') return
    const amount = progress.total ? `${formatBytes(progress.loaded ?? 0)} / ${formatBytes(progress.total)}` : 'working'
    stdout.write(`\r${progress.model}: ${progress.file ?? ''} ${amount}`)
}

async function main(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        stdout.write(HELP)
        return
    }
    if (args.includes('--database-info')) {
        const info = await databaseInfo()
        stdout.write(`database: ${info.path}\nrows: ${info.rows}\n`)
        return
    }

    const allowDownloads = args.includes('--allow-downloads')
    const retrievalOnly = args.includes('--retrieve')
    const question = args
        .filter(argument => !argument.startsWith('--'))
        .join(' ')
        .trim()
    if (!question) throw new Error('A question is required. Run gofer-rag --help for usage.')

    const interactive = Boolean(stdin.isTTY && stdout.isTTY)
    const options: GoferOptions = {
        allowModelDownloads:
            allowDownloads ? true
            : interactive ? promptForDownloads
            : false,
        onDownloadProgress: reportProgress
    }
    configure(options)
    const result = retrievalOnly ? await retrieve(question) : await query(question)
    stdout.write(`\n${JSON.stringify(result, null, 2)}\n`)
}

void main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
})
