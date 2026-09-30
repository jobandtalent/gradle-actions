import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as s3Cache from '@itchyny/s3-cache-action'
import {S3Client, type S3ClientConfig} from '@aws-sdk/client-s3'
import {NativeS3Cache, legacyStateKey} from './cache-s3-native'

const SEGMENT_DOWNLOAD_TIMEOUT_VAR = 'SEGMENT_DOWNLOAD_TIMEOUT_MINS'
const SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT = 10 * 60 * 1000

type CacheRestoreOptions = {segmentTimeoutInMs?: number}

export type CacheSaveResult = number | boolean

type S3CacheBackend = {
    bucketName: string
    client: S3Client
}

type RestoreCache = (
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    options?: CacheRestoreOptions
) => Promise<string | undefined>

type SaveCache = (paths: string[], key: string) => Promise<number>

const restoreGitHubCache: RestoreCache = cache.restoreCache
const saveGitHubCache: SaveCache = cache.saveCache

export async function restoreCache(
    cachePath: string[],
    cacheKey: string,
    cacheRestoreKeys: string[] = []
): Promise<string | undefined> {
    const s3Backend = getInputS3CacheBackend()
    if (!s3Backend) {
        const cacheRestoreOptions = process.env[SEGMENT_DOWNLOAD_TIMEOUT_VAR]
            ? undefined
            : {segmentTimeoutInMs: SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT}
        return await restoreGitHubCache(cachePath, cacheKey, cacheRestoreKeys, cacheRestoreOptions)
    }

    if (getInputS3Transport() === 'native') {
        return await nativeCache(s3Backend).restore(cachePath, cacheKey, cacheRestoreKeys)
    }

    const restoredKey = await s3Cache.restoreCache(
        cachePath.slice(),
        cacheKey,
        cacheRestoreKeys,
        s3Backend.bucketName,
        s3Backend.client
    )
    return restoredKey || undefined
}

export async function saveCache(cachePath: string[], cacheKey: string): Promise<CacheSaveResult> {
    const s3Backend = getInputS3CacheBackend()
    if (!s3Backend) {
        return await saveGitHubCache(cachePath, cacheKey)
    }

    if (getInputS3Transport() === 'native') {
        return await nativeCache(s3Backend).save(cachePath, cacheKey)
    }

    return await s3Cache.saveCache(cachePath.slice(), cacheKey, s3Backend.bucketName, s3Backend.client)
}

export function getInputS3BucketName(): string | undefined {
    const bucketName = core.getInput('aws-s3-bucket')
    return bucketName || undefined
}

export function getInputS3Region(): string | undefined {
    return core.getInput('aws-region') || process.env['AWS_REGION'] || undefined
}

export function getInputS3Transport(): 'legacy' | 'native' {
    const transport = core.getInput('aws-s3-cache-transport') || 'legacy'
    if (transport !== 'legacy' && transport !== 'native') {
        throw new Error('aws-s3-cache-transport must be legacy or native.')
    }
    return transport
}

export function needsNativeS3Migration(key: string): boolean {
    return (
        !!getInputS3BucketName() && getInputS3Transport() === 'native' && core.getState(legacyStateKey(key)) === 'true'
    )
}

export function getInputS3Environment(): NodeJS.ProcessEnv {
    const environment = {...process.env}
    const config = getInputS3ClientConfig()
    const region = getInputS3Region()
    if (region) {
        environment.AWS_REGION = region
        environment.AWS_DEFAULT_REGION = region
    }
    if (typeof config.credentials === 'object') {
        environment.AWS_ACCESS_KEY_ID = config.credentials.accessKeyId
        environment.AWS_SECRET_ACCESS_KEY = config.credentials.secretAccessKey
        environment.AWS_SESSION_TOKEN = config.credentials.sessionToken
    }
    return environment
}

export function getInputS3ClientConfig(): S3ClientConfig {
    const accessKeyId = core.getInput('aws-access-key-id') || process.env['AWS_ACCESS_KEY_ID']
    const secretAccessKey = core.getInput('aws-secret-access-key') || process.env['AWS_SECRET_ACCESS_KEY']
    const sessionToken = core.getInput('aws-session-token') || process.env['AWS_SESSION_TOKEN']

    const config: S3ClientConfig = {region: getInputS3Region()}
    if (accessKeyId && secretAccessKey) {
        config.credentials = {
            accessKeyId,
            secretAccessKey,
            sessionToken: sessionToken || undefined
        }
    }
    return config
}

export function describeCacheBackend(): string {
    const bucketName = getInputS3BucketName()
    if (!bucketName) {
        return 'GitHub Actions cache backend'
    }

    return `S3 cache backend (transport=${getInputS3Transport()}, bucket=${bucketName}, region=${getInputS3Region() ?? 'unspecified region'})`
}

export function logCacheOperation(
    action: 'restore' | 'save',
    cachePath: string[],
    cacheKey: string,
    cacheRestoreKeys: string[] = []
): void {
    core.info(
        `${action === 'restore' ? 'Restoring' : 'Saving'} cache using ${describeCacheBackend()}. key=${cacheKey}; paths=${cachePath.join(', ')}`
    )
    if (cacheRestoreKeys.length > 0) {
        core.info(`Restore keys for ${cacheKey}: ${cacheRestoreKeys.join(', ')}`)
    }
}

export function handleCacheFailure(error: unknown, message: string): void {
    if (error instanceof cache.ValidationError) {
        throw error
    }
    if (error instanceof cache.ReserveCacheError) {
        core.info(`${message}: ${error}`)
    } else {
        core.warning(`${message}: ${error}`)
        if (error instanceof Error && error.stack) {
            core.debug(error.stack)
        }
    }
}

function getInputS3CacheBackend(): S3CacheBackend | undefined {
    const bucketName = getInputS3BucketName()
    if (!bucketName) {
        return undefined
    }

    return {bucketName, client: new S3Client(getInputS3ClientConfig())}
}

function nativeCache(backend: S3CacheBackend): NativeS3Cache {
    return new NativeS3Cache(
        backend.bucketName,
        backend.client,
        getInputS3Environment(),
        process.env.GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX || ''
    )
}
