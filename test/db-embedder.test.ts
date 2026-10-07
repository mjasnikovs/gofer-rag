import {afterEach, describe, expect, test} from 'bun:test'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {configure, resetConfiguration} from '../src/config'
import {EmbedderMismatchError, currentEmbedder, databaseInfo, recreateTable} from '../src/store/db'
import type {StoredChunk} from '../src/types'

const directories: string[] = []

async function database(width: number): Promise<string> {
    const databasePath = await mkdtemp(join(tmpdir(), 'gofer-db-test-'))
    directories.push(databasePath)
    configure({databasePath})
    const rows: StoredChunk[] = [0, 1].map(i => ({
        id: `${i}-0`,
        vector: Array.from({length: width}, (_, j) => (j === i ? 1 : 0)),
        text: `chunk ${i}`,
        chapter: 'Test',
        order: i
    }))
    await recreateTable(rows)
    return databasePath
}

afterEach(async () => {
    resetConfiguration()
    await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})))
})

describe('embedder stamp', () => {
    test('ingest stamps the database and an open accepts its own stamp', async () => {
        const databasePath = await database(currentEmbedder().dims)
        expect(JSON.parse(await readFile(join(databasePath, 'embedder.json'), 'utf8'))).toEqual(currentEmbedder())
        expect((await databaseInfo()).rows).toBe(2)
    })

    test('a database from another embedder is refused by name', async () => {
        const databasePath = await database(currentEmbedder().dims)
        await writeFile(
            join(databasePath, 'embedder.json'),
            JSON.stringify({...currentEmbedder(), model: 'onnx-community/Qwen3-Embedding-0.6B-ONNX'})
        )
        expect(databaseInfo()).rejects.toThrow(EmbedderMismatchError)
        expect(databaseInfo()).rejects.toThrow('Qwen3-Embedding-0.6B-ONNX')
    })

    test('a database without a stamp is refused', async () => {
        const databasePath = await database(currentEmbedder().dims)
        await rm(join(databasePath, 'embedder.json'))
        expect(databaseInfo()).rejects.toThrow('no readable embedder.json')
    })

    test('a stamp that lies about the vector width is caught by the schema', async () => {
        await database(1024)
        expect(databaseInfo()).rejects.toThrow('Differs: dims')
    })
})
