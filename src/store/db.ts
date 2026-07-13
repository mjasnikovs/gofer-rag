// LanceDB access. rag-update rebuilds the table from scratch; serve reads from it.
// The open table is cached so we don't reconnect on every query.

import * as lancedb from '@lancedb/lancedb'
import {config} from '../config'
import type {StoredChunk} from '../types'

let cachedTable: lancedb.Table | null = null

async function connect(): Promise<lancedb.Connection> {
    return lancedb.connect(config.dbPath)
}

// Drop any existing table and recreate it from the given rows (fresh ingest).
export async function recreateTable(rows: StoredChunk[]): Promise<void> {
    const db = await connect()
    const names = await db.tableNames()
    if (names.includes(config.table)) await db.dropTable(config.table)
    await db.createTable(config.table, rows)
    cachedTable = null
}

async function getTable(): Promise<lancedb.Table> {
    if (!cachedTable) {
        const db = await connect()
        cachedTable = await db.openTable(config.table)
    }
    return cachedTable
}

export async function loadTable(): Promise<void> {
    await getTable()
}

export async function vectorSearch(vector: number[], k: number): Promise<StoredChunk[]> {
    const table = await getTable()
    const results = await table.search(vector).limit(k).toArray()
    return results as StoredChunk[]
}
