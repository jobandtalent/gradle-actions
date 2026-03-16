import * as crypto from 'crypto'
import * as github from '@actions/github'

import {CacheConfig, getJobMatrix} from './configuration'

const CACHE_PROTOCOL_VERSION = 'v1'

const CACHE_KEY_PREFIX_VAR = 'GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX'
const CACHE_KEY_OS_VAR = 'GRADLE_BUILD_ACTION_CACHE_KEY_ENVIRONMENT'
const CACHE_KEY_JOB_VAR = 'GRADLE_BUILD_ACTION_CACHE_KEY_JOB'
const CACHE_KEY_JOB_INSTANCE_VAR = 'GRADLE_BUILD_ACTION_CACHE_KEY_JOB_INSTANCE'
const CACHE_KEY_JOB_EXECUTION_VAR = 'GRADLE_BUILD_ACTION_CACHE_KEY_JOB_EXECUTION'

/**
 * Represents a key used to restore a cache entry.
 * The cache first tries an exact match, then the supplied restore-key prefixes.
 */
export class CacheKey {
    constructor(
        public readonly key: string,
        public readonly restoreKeys: string[]
    ) {}
}

/**
 * Generate the cache key format used by the fork before the upstream cache-service refactor.
 * Keeping this format for S3 preserves access to existing fork-owned cache entries.
 */
export function generateCacheKey(cacheName: string, config: Pick<CacheConfig, 'isCacheStrictMatch'>): CacheKey {
    const cacheKeyBase = getCacheKeyBase(cacheName, CACHE_PROTOCOL_VERSION)
    const cacheKeyForEnvironment = `${cacheKeyBase}|${getCacheKeyEnvironment()}`
    const cacheKeyForJob = `${cacheKeyForEnvironment}|${getCacheKeyJob()}`
    const cacheKeyForJobContext = `${cacheKeyForJob}[${getCacheKeyJobInstance()}]`
    const cacheKey = `${cacheKeyForJobContext}-${getCacheKeyExecution()}`

    if (config.isCacheStrictMatch()) {
        return new CacheKey(cacheKey, [cacheKeyForJobContext])
    }

    return new CacheKey(cacheKey, [cacheKeyForJobContext, cacheKeyForJob, cacheKeyForEnvironment])
}

export function getCacheKeyBase(cacheName: string, cacheProtocolVersion: string): string {
    const prefix = process.env[CACHE_KEY_PREFIX_VAR] || ''
    return `${prefix}gradle-${cacheName}-${cacheProtocolVersion}`
}

export function hashStrings(values: string[]): string {
    const hash = crypto.createHash('md5')
    for (const value of values) {
        hash.update(value)
    }
    return hash.digest('hex')
}

function getCacheKeyEnvironment(): string {
    const runnerOs = process.env['RUNNER_OS'] || ''
    const runnerArch = process.env['RUNNER_ARCH'] || ''
    return process.env[CACHE_KEY_OS_VAR] || `${runnerOs}-${runnerArch}`
}

function getCacheKeyJob(): string {
    return process.env[CACHE_KEY_JOB_VAR] || github.context.job
}

function getCacheKeyJobInstance(): string {
    const override = process.env[CACHE_KEY_JOB_INSTANCE_VAR]
    if (override) {
        return override
    }

    return hashStrings([github.context.workflow, getJobMatrix()])
}

function getCacheKeyExecution(): string {
    return process.env[CACHE_KEY_JOB_EXECUTION_VAR] || github.context.sha
}
