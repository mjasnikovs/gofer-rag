import {afterEach, describe, expect, test} from 'bun:test'
import {
    gatherCandidates,
    isRefusal,
    mergeCandidates,
    query,
    rankCandidates,
    retrieveDetailed,
    warmup,
    type CutPolicy,
    type QueryDependencies
} from '../src/core/query'
import {config, configure, resetConfiguration} from '../src/config'
import {expandQuery, generateAnswer} from '../src/ai/llm'
import type {StoredChunk} from '../src/types'

const chunk = (id: string, chapter: string, text = `${chapter} documentation`): StoredChunk => ({
    id,
    vector: [1, 0],
    text,
    chapter,
    order: Number(id)
})

// A pool where Tree is named but both its chunks score below the five tutorials,
// so the fill loop never reaches them and the title pin has to rescue one.
const pinnable: StoredChunk[] = [
    ...Array.from({length: 5}, (_, index) => chunk(String(index), `Tutorial ${index}`)),
    chunk('6', 'Tree', 'Tree introduction'),
    chunk('7', 'Tree', 'The font_color property controls text color.')
]
const pinnableScores = [10, 9, 8, 7, 6, 0, 1]

const cut = (overrides: Partial<CutPolicy> = {}): CutPolicy => ({
    keep: config.rerankKeep,
    maxPassages: Number.POSITIVE_INFINITY,
    maxGap: Number.POSITIVE_INFINITY,
    pinReserve: Number.POSITIVE_INFINITY,
    answerFloor: config.answerFloor,
    ...overrides
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
    // The nothing-found gate. A pool whose best passage is under the floor holds
    // no answer, so the consumer is told the documentation has nothing on this
    // rather than being handed the least-bad page. Measured at -0.5 in
    // scripts/ab-floor.ts; see config.answerFloor.
    test('drops the whole set when the best passage is below the answer floor', () => {
        const candidates = [chunk('1', 'MultiMeshInstance2D'), chunk('2', 'TileSet')]
        const ranked = rankCandidates('gofer node.set_cells atlas source format', candidates, [-1.75, -2.4], [])

        expect(ranked).toEqual([])
    })

    test('keeps a set whose best passage clears the floor, companions included', () => {
        const candidates = [chunk('1', 'Canvas layers'), chunk('2', 'Parallax2D')]
        const ranked = rankCandidates('keep the UI in place while the camera moves', candidates, [-0.02, -3.1], [])

        expect(ranked.map(candidate => candidate.chapter)).toEqual(['Canvas layers', 'Parallax2D'])
    })

    test('the floor outranks the title pin, so a named chapter cannot rescue a dead pool', () => {
        const ranked = rankCandidates(
            'What is font_color on Tree?',
            pinnable,
            pinnableScores.map(() => -2),
            ['Tree']
        )

        expect(ranked).toEqual([])
    })

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

    test('marks a pinned chapter so a caller can tell a rescue from a score hit', () => {
        const ranked = rankCandidates('What is font_color on Tree?', pinnable, pinnableScores, ['Tree'])

        expect(ranked.at(-1)?.pinned).toBe(true)
        expect(ranked.filter(candidate => candidate.pinned)).toHaveLength(1)
        expect(ranked.slice(0, -1).every(candidate => candidate.pinned === undefined)).toBe(true)
    })

    // The finding that made maxPassages exist rather than keep: a pin fires when
    // a named chapter falls out of the kept set, so squeezing keep produces MORE
    // pins. keep 1 here returns 2 passages, not 1.
    test('keep alone does not bound the returned count, because it feeds the pin', () => {
        const ranked = rankCandidates('What is font_color on Tree?', pinnable, pinnableScores, ['Tree'], cut({keep: 1}))

        expect(ranked).toHaveLength(2)
        expect(ranked.at(-1)?.pinned).toBe(true)
    })

    test('maxPassages is a hard ceiling that counts pins', () => {
        const ranked = rankCandidates(
            'What is font_color on Tree?',
            pinnable,
            pinnableScores,
            ['Tree'],
            cut({maxPassages: 3})
        )

        expect(ranked).toHaveLength(3)
    })

    // The regression this whole change exists to prevent: a consumer capping to
    // three must not lose the rescued chapter the way slice(0, 3) would.
    test('a pin survives the ceiling that a naive slice would have cut', () => {
        const ranked = rankCandidates(
            'What is font_color on Tree?',
            pinnable,
            pinnableScores,
            ['Tree'],
            cut({maxPassages: 3})
        )

        expect(ranked.filter(candidate => candidate.pinned)).toHaveLength(1)
        expect(ranked.at(-1)?.text).toContain('font_color')
    })

    test('a ceiling of one keeps the best chunk and no pin', () => {
        const ranked = rankCandidates(
            'What is font_color on Tree?',
            pinnable,
            pinnableScores,
            ['Tree'],
            cut({maxPassages: 1})
        )

        expect(ranked).toHaveLength(1)
        expect(ranked[0]?.score).toBe(10)
        expect(ranked[0]?.pinned).toBeUndefined()
    })

    test('pinReserve zero drops the rescue a ceiling would otherwise keep', () => {
        const ranked = rankCandidates(
            'What is font_color on Tree?',
            pinnable,
            pinnableScores,
            ['Tree'],
            cut({maxPassages: 3, pinReserve: 0})
        )

        expect(ranked).toHaveLength(3)
        expect(ranked.some(candidate => candidate.pinned)).toBe(false)
    })

    test('maxGap drops chunks too far below the best one', () => {
        const candidates = Array.from({length: 4}, (_, index) => chunk(String(index), `Chapter ${index}`))
        const ranked = rankCandidates('question', candidates, [5, 4.5, 1, 0], [], cut({maxGap: 1}))

        expect(ranked.map(candidate => candidate.score)).toEqual([5, 4.5])
    })

    // Structural, and the reason the refusal gate is immune to any cut in this
    // family: rank 1 is always within every ceiling and every gap.
    test('no cut can empty a set that the threshold let through', () => {
        const candidates = Array.from({length: 4}, (_, index) => chunk(String(index), `Chapter ${index}`))
        const scores = [2, 1, 0, -1]
        for (const policy of [{maxPassages: 1}, {maxPassages: 2}, {keep: 1}, {maxGap: 0}, {maxGap: 0.5}]) {
            expect(rankCandidates('question', candidates, scores, [], cut(policy)).length).toBeGreaterThan(0)
        }
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

// The same pipeline with the real llm.ts functions wired in, so the host's
// injected connection is the only thing standing in for a model.
describe('host-supplied completions', () => {
    afterEach(() => resetConfiguration())

    const hosted = (overrides: DependencyOverrides = {}): QueryDependencies =>
        dependencies({
            expandQuery,
            generateAnswer,
            vectorSearch: () => Promise.resolve([chunk('1', 'Tween')]),
            rerank: () => Promise.resolve([3]),
            ...overrides
        })

    test('expands and answers through the injected connection', async () => {
        const asked: string[] = []
        configure({
            complete: request => {
                asked.push(request.system)
                return Promise.resolve(
                    request.system.includes('Godot 4 engine expert') ?
                        'Tween, tween_property, Animation'
                    :   'Use a Tween. [Tween]'
                )
            }
        })

        const result = await query('how do I animate a value', hosted())

        expect(asked).toHaveLength(2)
        expect(result).toEqual({
            found: true,
            answer: 'Use a Tween. [Tween]',
            sources: [{chapter: 'Tween', order: 1, score: 3}]
        })
    })

    test('still refuses when the injected connection answers with the refusal', async () => {
        configure({complete: () => Promise.resolve(config.notFoundMessage)})

        expect(await query('question', hosted())).toEqual({found: false, message: config.notFoundMessage})
    })

    test('retrieves unexpanded when the injected connection fails the expansion', async () => {
        let rerankQuestion = ''
        configure({complete: () => Promise.reject(new Error('host connection failed'))})

        const result = await retrieveDetailed(
            'how do I animate a value',
            hosted({
                rerank: question => {
                    rerankQuestion = question
                    return Promise.resolve([3])
                }
            })
        )

        expect(result.expansion).toBe('')
        expect(rerankQuestion).toBe('how do I animate a value')
        expect(result.kept[0]?.chapter).toBe('Tween')
    })
})
