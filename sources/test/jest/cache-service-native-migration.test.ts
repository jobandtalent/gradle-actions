import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {CacheOptions} from '../../src/cache-service'

const key = 'workers/gradle-home-v1|Linux-X64|job-commit'
const save = jest.fn<(...args: unknown[]) => Promise<boolean>>()
const migrate = jest.fn<() => boolean>()
jest.unstable_mockModule('../../src/cache-backend', () => ({
    getInputS3BucketName: () => 'bucket', logCacheOperation: jest.fn(), restoreCache: jest.fn(),
    saveCache: save, needsNativeS3Migration: migrate
}))
const {BasicCacheService} = await import('../../src/cache-service-basic')

describe('native migration in the normal setup-gradle post-action', () => {
    let originalEnvironment: NodeJS.ProcessEnv
    const options: CacheOptions = {
        disabled: false, readOnly: false, writeOnly: false, overwriteExisting: false,
        strictMatch: false, cleanup: 'never', includes: [], excludes: []
    }
    beforeEach(() => {
        originalEnvironment = {...process.env}
        process.env.STATE_BASIC_CACHE_PRIMARY_KEY = key
        process.env.STATE_BASIC_CACHE_RESTORED_KEY = key
        jest.clearAllMocks()
        save.mockResolvedValue(true)
    })
    afterEach(() => { process.env = originalEnvironment })

    it('migrates a legacy exact-key restore to a new native entry', async () => {
        migrate.mockReturnValue(true)
        const report = await new BasicCacheService().save('/home/runner/.gradle', [], options)
        expect(save).toHaveBeenCalledWith(['/home/runner/.gradle/caches', '/home/runner/.gradle/wrapper'], key)
        expect(report.entries[0].savedKey).toBe(key)
    })

    it('does not rewrite a native exact-key restore', async () => {
        migrate.mockReturnValue(false)
        await new BasicCacheService().save('/home/runner/.gradle', [], options)
        expect(save).not.toHaveBeenCalled()
    })

    it('never migrates an entry in a read-only PR job', async () => {
        migrate.mockReturnValue(true)
        const report = await new BasicCacheService().save('/home/runner/.gradle', [], {...options, readOnly: true})
        expect(report.status).toBe('read-only')
        expect(save).not.toHaveBeenCalled()
        expect(migrate).not.toHaveBeenCalled()
    })
})
