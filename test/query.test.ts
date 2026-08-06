import {describe, expect, test} from 'bun:test'
import {
    gatherCandidates,
    isRefusal,
    mergeCandidates,
    query,
    rankCandidates,
    retrieveDetailed,
    warmup,
    type QueryDependencies
} from '../src/core/query'
import {config} from '../src/config'
import type {StoredChunk} from '../src/types'

const chunk = (id: string, chapter: string, text = `${chapter} documentation`): StoredChunk => ({
    id,
    vector: [1, 0],
    text,
    chapter,
    order: Number(id)
})

type DependencyOverrides = Partial<QueryDependencies>

const dependencies = (overrides: DependencyOverrides = {}): QueryDependencies => ({
    embedQuery: () => Promise.resolve([1, 0]),
    loadEmbedder: () => Promise.resolve(),
    rerank: (_question, passages) => Promise.resolve(passages.map(() => 1)),
    loadReranker: () => Promise.resolve(),
    generateAnswer: () => Promise.resolve('Grounded answer [Node]'),
    expandQuery: () => Promise.resolve(''),
    loadTable: () => Promise.resolve(),
    vectorSearch: () => Promise.resolve([]),
    ftsSearch: () => Promise.resolve([]),
    titleSearch: () => Promise.resolve([]),
    matchedTitles: () => Promise.resolve([]),
    ...overrides
})

describe('mergeCandidates', () => {
    test('deduplicates candidates by id while preserving source order', () => {
        const first = chunk('1', 'Node')
        const duplicate = {...first, chapter: 'Duplicate'}
        const second = chunk('2', 'Control')

        expect(mergeCandidates([first], [duplicate, second])).toEqual([duplicate, second])
    })
})

describe('rankCandidates', () => {
    test('sorts by score, applies the threshold, and enforces the keep limit', () => {
        const candidates = Array.from({length: 8}, (_, index) => chunk(String(index), `Chapter ${index}`))
        const scores = [8, 7, 6, 5, 4, 3, config.rerankThreshold - 1, config.rerankThreshold - 2]
        const ranked = rankCandidates('question', candidates, scores, [])

        expect(ranked).toHaveLength(config.rerankKeep)
        expect(ranked.map(candidate => candidate.score)).toEqual([8, 7, 6, 5, 4])
    })

    test('pins a named chapter and prefers its matching member passage', () => {
        const candidates = [
            ...Array.from({length: 5}, (_, index) => chunk(String(index), `Tutorial ${index}`)),
            chunk('6', 'Tree', 'Tree introduction'),
            chunk('7', 'Tree', 'The font_color property controls text color.')
        ]
        const ranked = rankCandidates('What is font_color on Tree?', candidates, [10, 9, 8, 7, 6, 0, 1], ['Tree'])

        expect(ranked).toHaveLength(config.rerankKeep + 1)
        expect(ranked.at(-1)?.text).toContain('font_color')
    })

    test('does not pin a named chapter below the relevance threshold', () => {
        const ranked = rankCandidates('What is Tree?', [chunk('1', 'Tree')], [config.rerankThreshold - 1], ['Tree'])

        expect(ranked).toEqual([])
    })
})

describe('isRefusal', () => {
    test('accepts harmless punctuation around the canonical refusal', () => {
        expect(isRefusal(`"${config.notFoundMessage}" Extra text`)).toBeTrue()
    })

    test('does not mistake a normal answer for a refusal', () => {
        expect(isRefusal('Use a CharacterBody2D node.')).toBeFalse()
    })
})

describe('query orchestration', () => {
    test('warms the embedder, reranker, and database', async () => {
        const loaded: string[] = []
        await warmup(
            dependencies({
                loadEmbedder: () => Promise.resolve(void loaded.push('embedder')),
                loadReranker: () => Promise.resolve(void loaded.push('reranker')),
                loadTable: () => Promise.resolve(void loaded.push('table'))
            })
        )

        expect(loaded.sort()).toEqual(['embedder', 'reranker', 'table'])
    })

    test('expands title-less questions and merges all candidate sources', async () => {
        const searched: string[] = []
        const deps = dependencies({
            expandQuery: () => Promise.resolve('CharacterBody2D, movement, physics'),
            embedQuery: text => Promise.resolve([searched.push(`embed:${text}`), 0]),
            vectorSearch: () => Promise.resolve([chunk('1', 'Vector')]),
            ftsSearch: text => {
                searched.push(`fts:${text}`)
                return Promise.resolve([chunk('1', 'FTS replacement'), chunk('2', 'FTS')])
            },
            titleSearch: text => {
                searched.push(`title:${text}`)
                return Promise.resolve([chunk('3', 'Title')])
            }
        })

        const result = await gatherCandidates('move player', deps)

        expect(result.expansion).toBe('CharacterBody2D, movement, physics')
        expect(result.candidates.map(candidate => candidate.chapter)).toEqual(['FTS replacement', 'FTS', 'Title'])
        expect(searched.every(text => text.includes('CharacterBody2D'))).toBeTrue()
    })

    test('skips expansion when the question names a chapter', async () => {
        let expanded = false
        const result = await gatherCandidates(
            'What is Node?',
            dependencies({
                matchedTitles: () => Promise.resolve(['Node']),
                expandQuery: () => {
                    expanded = true
                    return Promise.resolve('unused')
                },
                vectorSearch: () => Promise.resolve([chunk('1', 'Node')])
            })
        )

        expect(expanded).toBeFalse()
        expect(result.expansion).toBe('')
        expect(result.titles).toEqual(['Node'])
    })

    test('does not rerank an empty candidate pool', async () => {
        let reranked = false
        const result = await retrieveDetailed(
            'question',
            dependencies({
                rerank: () => {
                    reranked = true
                    return Promise.resolve([])
                }
            })
        )

        expect(reranked).toBeFalse()
        expect(result).toEqual({candidates: [], expansion: '', kept: [], scored: []})
    })

    test('reranks against the expanded question', async () => {
        let rerankQuestion = ''
        const result = await retrieveDetailed(
            'move player',
            dependencies({
                expandQuery: () => Promise.resolve('CharacterBody2D, movement'),
                vectorSearch: () => Promise.resolve([chunk('1', 'CharacterBody2D')]),
                rerank: question => {
                    rerankQuestion = question
                    return Promise.resolve([2])
                }
            })
        )

        expect(rerankQuestion).toBe('move player CharacterBody2D, movement')
        expect(result.kept[0]?.chapter).toBe('CharacterBody2D')
    })

    test('returns not found without generating an answer when retrieval fails', async () => {
        let generated = false
        const result = await query(
            'question',
            dependencies({
                generateAnswer: () => {
                    generated = true
                    return Promise.resolve('unused')
                }
            })
        )

        expect(generated).toBeFalse()
        expect(result).toEqual({found: false, message: config.notFoundMessage})
    })

    test('honors the LLM refusal gate', async () => {
        const result = await query(
            'question',
            dependencies({
                vectorSearch: () => Promise.resolve([chunk('1', 'Node')]),
                generateAnswer: () => Promise.resolve(config.notFoundMessage)
            })
        )

        expect(result).toEqual({found: false, message: config.notFoundMessage})
    })

    test('returns a grounded answer and ranked sources', async () => {
        const result = await query(
            'question',
            dependencies({
                vectorSearch: () => Promise.resolve([chunk('1', 'Node')]),
                rerank: () => Promise.resolve([3]),
                generateAnswer: (question, context) =>
                    Promise.resolve(`${question}: ${context.includes('(Node)') ? 'grounded' : 'missing context'}`)
            })
        )

        expect(result).toEqual({
            found: true,
            answer: 'question: grounded',
            sources: [{chapter: 'Node', order: 1, score: 3}]
        })
    })
})
