import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

const githubRestore = jest.fn<(...args: unknown[]) => Promise<string | undefined>>()
const githubSave = jest.fn<(...args: unknown[]) => Promise<number>>()
const legacyRestore = jest.fn<(...args: unknown[]) => Promise<string>>()
const legacySave = jest.fn<(...args: unknown[]) => Promise<boolean>>()
const nativeRestore = jest.fn<(...args: unknown[]) => Promise<string | undefined>>()
const nativeSave = jest.fn<(...args: unknown[]) => Promise<boolean>>()
const nativeConstructor = jest.fn(() => ({restore: nativeRestore, save: nativeSave}))

jest.unstable_mockModule('@actions/cache', () => ({restoreCache: githubRestore, saveCache: githubSave}))
jest.unstable_mockModule('@itchyny/s3-cache-action', () => ({restoreCache: legacyRestore, saveCache: legacySave}))
jest.unstable_mockModule('../../src/cache-s3-native', () => ({NativeS3Cache: nativeConstructor, legacyStateKey: (key: string) => `legacy-${key}`}))
const backend = await import('../../src/cache-backend')

describe('cache backend routing', () => {
    let original: NodeJS.ProcessEnv
    const paths = ['/home/runner/.gradle/caches', '/home/runner/.gradle/wrapper']
    const key = 'workers/gradle-home-v1|Linux-X64|job-commit'
    const restoreKeys = ['workers/gradle-home-v1|Linux-X64|']

    beforeEach(() => {
        original = {...process.env}
        delete process.env['INPUT_AWS-S3-BUCKET']
        delete process.env['INPUT_AWS-S3-CACHE-TRANSPORT']
        jest.clearAllMocks()
    })

    afterEach(() => { process.env = original })

    it('keeps using GitHub cache without a bucket, even if native is selected', async () => {
        process.env['INPUT_AWS-S3-CACHE-TRANSPORT'] = 'native'
        githubRestore.mockResolvedValue(key)
        githubSave.mockResolvedValue(42)
        await expect(backend.restoreCache(paths, key, restoreKeys)).resolves.toBe(key)
        await expect(backend.saveCache(paths, key)).resolves.toBe(42)
        expect(githubRestore).toHaveBeenCalledWith(paths, key, restoreKeys, expect.any(Object))
        expect(githubSave).toHaveBeenCalledWith(paths, key)
        expect(nativeConstructor).not.toHaveBeenCalled()
        expect(legacyRestore).not.toHaveBeenCalled()
    })

    it('keeps existing S3 behaviour when the transport input is omitted', async () => {
        process.env['INPUT_AWS-S3-BUCKET'] = 'bucket'
        legacyRestore.mockResolvedValue(key)
        legacySave.mockResolvedValue(true)
        await expect(backend.restoreCache(paths, key, restoreKeys)).resolves.toBe(key)
        await expect(backend.saveCache(paths, key)).resolves.toBe(true)
        expect(legacyRestore).toHaveBeenCalledWith(paths, key, restoreKeys, 'bucket', expect.any(Object))
        expect(legacySave).toHaveBeenCalledWith(paths, key, 'bucket', expect.any(Object))
        expect(nativeConstructor).not.toHaveBeenCalled()
    })

    it('routes full paths and unchanged logical keys through native when opted in', async () => {
        process.env['INPUT_AWS-S3-BUCKET'] = 'bucket'
        process.env['INPUT_AWS-S3-CACHE-TRANSPORT'] = 'native'
        process.env.GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX = 'workers/'
        nativeRestore.mockResolvedValue(key)
        nativeSave.mockResolvedValue(true)
        await expect(backend.restoreCache(paths, key, restoreKeys)).resolves.toBe(key)
        await expect(backend.saveCache(paths, key)).resolves.toBe(true)
        expect(nativeRestore).toHaveBeenCalledWith(paths, key, restoreKeys)
        expect(nativeSave).toHaveBeenCalledWith(paths, key)
        expect(nativeConstructor).toHaveBeenCalledWith('bucket', expect.any(Object), expect.any(Object), 'workers/')
        expect(legacyRestore).not.toHaveBeenCalled()
        expect(legacySave).not.toHaveBeenCalled()
        expect(githubRestore).not.toHaveBeenCalled()
    })
})
