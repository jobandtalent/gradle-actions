import {afterEach, describe, expect, it} from '@jest/globals'

import {getCacheKeyBase} from '../../src/caching/cache-key'

const CACHE_KEY_PREFIX_VAR = 'GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX'

describe('cache key prefixing', () => {
    afterEach(() => {
        delete process.env[CACHE_KEY_PREFIX_VAR]
    })

    it('applies the prefix to the cache key base', () => {
        process.env[CACHE_KEY_PREFIX_VAR] = 'shared-bucket/'

        expect(getCacheKeyBase('home', 'v1')).toBe('shared-bucket/gradle-home-v1')
    })

    it('keeps the upstream base key format when no prefix is provided', () => {
        expect(getCacheKeyBase('home', 'v1')).toBe('gradle-home-v1')
    })
})
