import {execFileSync, spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

const root = resolve(import.meta.dirname, '..')
const npm = process.env.npm_execpath ? process.execPath : 'npm'
const npmArguments = arguments_ => (process.env.npm_execpath ? [process.env.npm_execpath, ...arguments_] : arguments_)
const temporary = mkdtempSync(join(tmpdir(), 'gofer-rag-consumer-'))
const project = join(temporary, 'project')
const unrelated = join(temporary, 'unrelated-working-directory')
mkdirSync(project)
mkdirSync(unrelated)

const run = (command, args, options = {}) =>
    execFileSync(command, args, {cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options})

try {
    const suppliedTarball = process.argv[2]
    const packResult =
        suppliedTarball ? undefined : (
            JSON.parse(
                execFileSync(npm, npmArguments(['pack', '--json']), {
                    cwd: root,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                })
            )
        )
    const packed = packResult?.[0]
    if (!suppliedTarball && !packed?.filename) throw new Error('npm pack did not return a tarball filename')
    const tarball = suppliedTarball ? resolve(suppliedTarball) : join(root, packed.filename)

    writeFileSync(join(project, 'package.json'), JSON.stringify({private: true, type: 'module'}, null, 2))
    run(npm, npmArguments(['install', '--ignore-scripts', tarball, 'typescript@6.0.3']))

    const node = process.env.GOFER_TEST_NODE ?? process.execPath
    const importTest = join(project, 'import-test.mjs')
    writeFileSync(
        importTest,
        "import * as gofer from '@mjasnikovs/gofer-rag'; const invalidOptions = [[{unknownOption: true}, 'unknown option'], [{allowModelDownloads: 'false'}, 'boolean or consent callback']]; for (const [options, expected] of invalidOptions) { try { await gofer.query('Node', options); throw new Error('invalid options accepted') } catch (error) { if (!String(error).includes(expected)) throw error } } console.log(typeof gofer.retrieve, typeof gofer.query)"
    )
    const importOutput = run(node, [importTest], {cwd: unrelated})
    if (importOutput.trim() !== 'function function') throw new Error(`unexpected import output: ${importOutput}`)

    if (process.env.GOFER_RUN_MODEL_SMOKE === '1') {
        const modelSmoke = join(project, 'model-smoke.mjs')
        writeFileSync(
            modelSmoke,
            "import {retrieve} from '@mjasnikovs/gofer-rag'; const chunks = await retrieve('What is Node?', {cacheDir: process.env.GOFER_RAG_CACHE_DIR}); if (!chunks.length) throw new Error('no retrieval results'); console.log(chunks[0].chapter)"
        )
        const smoke = run(node, [modelSmoke], {cwd: unrelated})
        if (!smoke.trim()) throw new Error('retrieval smoke test returned no chapter')
    }

    const packageRoot = join(project, 'node_modules', '@mjasnikovs', 'gofer-rag')
    const cli = join(packageRoot, 'dist', 'cli.js')
    const help = run(node, [cli, '--help'], {cwd: unrelated})
    if (!help.includes('Usage:')) throw new Error('CLI help did not render')
    const database = run(node, [cli, '--database-info'], {cwd: unrelated})
    if (!database.includes(`database: ${realpathSync(join(packageRoot, '.lancedb'))}`))
        throw new Error(`database did not resolve from the installed module: ${database}`)
    if (!/rows: [1-9][0-9]*/.test(database)) throw new Error(`packaged database was empty: ${database}`)

    const emptyCache = join(temporary, 'empty-cache')
    const rejected = spawnSync(node, [cli, '--retrieve', 'What is Node?'], {
        cwd: unrelated,
        encoding: 'utf8',
        env: {...process.env, GOFER_RAG_CACHE_DIR: emptyCache, GOFER_RAG_ALLOW_MODEL_DOWNLOADS: 'false'}
    })
    if (rejected.status === 0 || !rejected.stderr.includes('Model download approval required'))
        throw new Error(`noninteractive rejection failed: ${rejected.stderr}`)
    if (existsSync(emptyCache)) throw new Error('noninteractive rejection wrote to the model cache')

    writeFileSync(
        join(project, 'consumer.ts'),
        "import {query, retrieve, type GoferOptions, type QueryResult, type RankedChunk} from '@mjasnikovs/gofer-rag'\nconst options: GoferOptions = {allowModelDownloads: false}\nconst result: Promise<QueryResult> = query('Node', options)\nconst chunks: Promise<RankedChunk[]> = retrieve('Node', options)\nfunction render(value: QueryResult): string { return value.found ? value.answer : value.message }\nvoid result\nvoid chunks\nvoid render\n"
    )
    writeFileSync(
        join(project, 'invalid-consumer.ts'),
        "import {query, type QueryResult} from '@mjasnikovs/gofer-rag'\n// @ts-expect-error unknown options must be rejected\nvoid query('Node', {unknownOption: true})\n// @ts-expect-error consent must be a boolean or callback\nvoid query('Node', {allowModelDownloads: 'false'})\n// @ts-expect-error successful responses always contain an answer and sources\nconst invalidSuccess: QueryResult = {found: true}\nvoid invalidSuccess\n"
    )
    writeFileSync(
        join(project, 'tsconfig.json'),
        JSON.stringify(
            {compilerOptions: {strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true}},
            null,
            2
        )
    )
    run(node, [join(project, 'node_modules', 'typescript', 'bin', 'tsc')])

    const installedBytes = Number(
        run(node, [
            '--input-type=module',
            '--eval',
            `import{readdirSync,statSync}from'node:fs';import{join}from'node:path';const size=p=>readdirSync(p,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?size(join(p,e.name)):statSync(join(p,e.name)).size),0);console.log(size(${JSON.stringify(packageRoot)}))`
        ]).trim()
    )
    console.log(
        JSON.stringify(
            {tarball, packed: packed ?? null, installedBytes, node: run(node, ['--version']).trim()},
            null,
            2
        )
    )
} finally {
    rmSync(temporary, {recursive: true, force: true})
}
