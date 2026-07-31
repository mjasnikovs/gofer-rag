import {describe, expect, test} from 'bun:test'
import {downloadPrompt, requestDownloadConsent} from '../src/cli-consent'
import type {ModelDownload} from '../src/types'

const models: ModelDownload[] = [
    {
        name: 'organization/model',
        source: 'https://huggingface.co/organization/model',
        destination: '/user/cache/organization/model',
        expectedBytes: 1024 ** 3
    }
]

describe('interactive download consent', () => {
    test('shows model identity, source, destination, and expected size before approval', async () => {
        let shown = ''
        const approved = await requestDownloadConsent(models, prompt => {
            shown = prompt
            return Promise.resolve('yes')
        })
        expect(approved).toBeTrue()
        expect(shown).toContain('organization/model')
        expect(shown).toContain('https://huggingface.co/organization/model')
        expect(shown).toContain('/user/cache/organization/model')
        expect(shown).toContain('1.00 GiB')
    })

    test('defaults to rejection', async () => {
        expect(await requestDownloadConsent(models, () => Promise.resolve(''))).toBeFalse()
        expect(await requestDownloadConsent(models, () => Promise.resolve('no'))).toBeFalse()
        expect(downloadPrompt(models)).toContain('[y/N]')
    })
})
