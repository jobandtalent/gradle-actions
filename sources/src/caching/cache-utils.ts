import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'
import * as s3Cache from '@itchyny/s3-cache-action'

import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'
import {S3Client, type S3ClientConfig} from '@aws-sdk/client-s3'

import {CacheEntryListener} from './cache-reporting'

const SEGMENT_DOWNLOAD_TIMEOUT_VAR = 'SEGMENT_DOWNLOAD_TIMEOUT_MINS'
const SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT = 10 * 60 * 1000 // 10 minutes

type CacheBackendEntry = {
    key: string
    size?: number
}

type S3CacheBackend = {
    bucketName: string
    client: S3Client
}

export function isCacheDebuggingEnabled(): boolean {
    if (core.isDebug()) {
        return true
    }
    return process.env['GRADLE_BUILD_ACTION_CACHE_DEBUG_ENABLED'] ? true : false
}

export function hashFileNames(fileNames: string[]): string {
    return hashStrings(fileNames.map(x => x.replace(new RegExp(`\\${path.sep}`, 'g'), '/')))
}

export function hashStrings(values: string[]): string {
    const hash = crypto.createHash('md5')
    for (const value of values) {
        hash.update(value)
    }
    return hash.digest('hex')
}

export async function restoreCache(
    cachePath: string[],
    cacheKey: string,
    cacheRestoreKeys: string[],
    listener: CacheEntryListener
): Promise<cache.CacheEntry | undefined> {
    listener.markRequested(cacheKey, cacheRestoreKeys)
    try {
        const startTime = Date.now()
        // Only override the read timeout if the SEGMENT_DOWNLOAD_TIMEOUT_MINS env var has NOT been set
        const cacheRestoreOptions = process.env[SEGMENT_DOWNLOAD_TIMEOUT_VAR]
            ? {}
            : {segmentTimeoutInMs: SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT}
        const restoredEntry = await restoreWithSelectedBackend(cachePath, cacheKey, cacheRestoreKeys, cacheRestoreOptions)
        if (restoredEntry !== undefined) {
            const restoreTime = Date.now() - startTime
            listener.markRestored(restoredEntry.key, restoredEntry.size, restoreTime)
            core.info(`Restored cache entry with key ${cacheKey} to ${cachePath.join()} in ${restoreTime}ms`)
        }
        return restoredEntry as cache.CacheEntry | undefined
    } catch (error) {
        listener.markNotRestored((error as Error).message)
        handleCacheFailure(error, `Failed to restore ${cacheKey}`)
        return undefined
    }
}

export async function saveCache(cachePath: string[], cacheKey: string, listener: CacheEntryListener): Promise<void> {
    try {
        const startTime = Date.now()
        const savedEntry = await saveWithSelectedBackend(cachePath, cacheKey)
        if (!savedEntry) {
            listener.markAlreadyExists(cacheKey)
            core.info(`Skipped saving cache entry with key ${cacheKey} because it already exists`)
            return
        }
        const saveTime = Date.now() - startTime
        listener.markSaved(savedEntry.key, savedEntry.size, saveTime)
        core.info(`Saved cache entry with key ${cacheKey} from ${cachePath.join()} in ${saveTime}ms`)
    } catch (error) {
        if (error instanceof cache.ReserveCacheError) {
            listener.markAlreadyExists(cacheKey)
        } else {
            listener.markNotSaved((error as Error).message)
        }
        handleCacheFailure(error, `Failed to save cache entry with path '${cachePath}' and key: ${cacheKey}`)
    }
}

export function cacheDebug(message: string): void {
    if (isCacheDebuggingEnabled()) {
        core.info(message)
    } else {
        core.debug(message)
    }
}

export function handleCacheFailure(error: unknown, message: string): void {
    if (error instanceof cache.ValidationError) {
        // Fail on cache validation errors
        throw error
    }
    if (error instanceof cache.ReserveCacheError) {
        // Reserve cache errors are expected if the artifact has been previously cached
        core.info(`${message}: ${error}`)
    } else {
        // Warn on all other errors
        core.warning(`${message}: ${error}`)
        if (error instanceof Error && error.stack) {
            cacheDebug(error.stack)
        }
    }
}

/**
 * Attempt to delete a file or directory, waiting to allow locks to be released
 */
export async function tryDelete(file: string): Promise<void> {
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (!fs.existsSync(file)) {
            return
        }
        try {
            const stat = fs.lstatSync(file)
            if (stat.isDirectory()) {
                fs.rmSync(file, {recursive: true})
            } else {
                fs.unlinkSync(file)
            }
            return
        } catch (error) {
            if (attempt === maxAttempts) {
                core.warning(`Failed to delete ${file}, which will impact caching. 
It is likely locked by another process. Output of 'jps -ml':
${await getJavaProcesses()}`)
                throw error
            } else {
                cacheDebug(`Attempt to delete ${file} failed. Will try again.`)
                await delay(1000)
            }
        }
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function getJavaProcesses(): Promise<string> {
    const jpsOutput = await exec.getExecOutput('jps', ['-lm'])
    return jpsOutput.stdout
}

async function restoreWithSelectedBackend(
    cachePath: string[],
    cacheKey: string,
    cacheRestoreKeys: string[],
    cacheRestoreOptions: {segmentTimeoutInMs?: number}
): Promise<CacheBackendEntry | undefined> {
    const s3Backend = getInputS3CacheBackend()
    if (!s3Backend) {
        return await cache.restoreCache(cachePath, cacheKey, cacheRestoreKeys, cacheRestoreOptions)
    }

    const restoredKey = await s3Cache.restoreCache(
        cachePath.slice(),
        cacheKey,
        cacheRestoreKeys,
        s3Backend.bucketName,
        s3Backend.client
    )

    return restoredKey ? {key: restoredKey} : undefined
}

async function saveWithSelectedBackend(cachePath: string[], cacheKey: string): Promise<CacheBackendEntry | undefined> {
    const s3Backend = getInputS3CacheBackend()
    if (!s3Backend) {
        return await cache.saveCache(cachePath, cacheKey)
    }

    const saved = await s3Cache.saveCache(cachePath.slice(), cacheKey, s3Backend.bucketName, s3Backend.client)
    return saved ? {key: cacheKey} : undefined
}

function getInputS3CacheBackend(): S3CacheBackend | undefined {
    const bucketName = getInputS3BucketName()
    if (!bucketName) {
        return undefined
    }

    return {
        bucketName,
        client: new S3Client(getInputS3ClientConfig())
    }
}

export function getInputS3BucketName(): string | undefined {
    const bucketName = core.getInput('aws-s3-bucket')
    return bucketName || undefined
}

export function getInputS3ClientConfig(): S3ClientConfig {
    const config: S3ClientConfig = {
        region: core.getInput('aws-region') || process.env['AWS_REGION'] || undefined
    }

    const accessKeyId = core.getInput('aws-access-key-id') || process.env['AWS_ACCESS_KEY_ID']
    const secretAccessKey = core.getInput('aws-secret-access-key') || process.env['AWS_SECRET_ACCESS_KEY']
    const sessionToken = core.getInput('aws-session-token') || process.env['AWS_SESSION_TOKEN']

    if (accessKeyId && secretAccessKey) {
        config.credentials = {
            accessKeyId,
            secretAccessKey,
            sessionToken: sessionToken || undefined
        }
    }

    return config
}
