import {afterEach, describe, expect, it} from '@jest/globals'

import * as cacheUtils from '../../src/caching/cache-utils'

const inputEnvKeys = [
    'INPUT_AWS-S3-BUCKET',
    'INPUT_AWS-ACCESS-KEY-ID',
    'INPUT_AWS-SECRET-ACCESS-KEY',
    'INPUT_AWS-SESSION-TOKEN',
    'INPUT_AWS-REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION'
]

describe('cacheUtils-utils', () => {
    afterEach(() => {
        for (const key of inputEnvKeys) {
            delete process.env[key]
        }
    })

    describe('can hash', () => {
        it('a string', async () => {
            const hash = cacheUtils.hashStrings(['foo'])
            expect(hash).toBe('acbd18db4cc2f85cedef654fccc4a4d8')
        })
        it('multiple strings', async () => {
            const hash = cacheUtils.hashStrings(['foo', 'bar', 'baz'])
            expect(hash).toBe('6df23dc03f9b54cc38a0fc1483df6e21')
        })
        it('normalized filenames', async () => {
            const fileNames = ['/foo/bar/baz.zip', '../boo.html']
            const posixHash = cacheUtils.hashFileNames(fileNames)
            const windowsHash = cacheUtils.hashFileNames(fileNames)
            expect(posixHash).toBe(windowsHash)
        })
    })

    describe('s3 configuration', () => {
        it('returns no bucket name when s3 inputs are not configured', () => {
            expect(cacheUtils.getInputS3BucketName()).toBeUndefined()
        })

        it('prefers explicit action inputs over environment variables', () => {
            process.env['INPUT_AWS-S3-BUCKET'] = 'explicit-bucket'
            process.env['INPUT_AWS-ACCESS-KEY-ID'] = 'input-key'
            process.env['INPUT_AWS-SECRET-ACCESS-KEY'] = 'input-secret'
            process.env['INPUT_AWS-SESSION-TOKEN'] = 'input-token'
            process.env['INPUT_AWS-REGION'] = 'eu-west-1'
            process.env.AWS_ACCESS_KEY_ID = 'env-key'
            process.env.AWS_SECRET_ACCESS_KEY = 'env-secret'
            process.env.AWS_SESSION_TOKEN = 'env-token'
            process.env.AWS_REGION = 'us-east-1'

            expect(cacheUtils.getInputS3BucketName()).toBe('explicit-bucket')
            expect(cacheUtils.getInputS3ClientConfig()).toEqual({
                credentials: {
                    accessKeyId: 'input-key',
                    secretAccessKey: 'input-secret',
                    sessionToken: 'input-token'
                },
                region: 'eu-west-1'
            })
        })

        it('falls back to aws environment variables when inputs are omitted', () => {
            process.env.AWS_ACCESS_KEY_ID = 'env-key'
            process.env.AWS_SECRET_ACCESS_KEY = 'env-secret'
            process.env.AWS_REGION = 'us-east-1'

            expect(cacheUtils.getInputS3ClientConfig()).toEqual({
                credentials: {
                    accessKeyId: 'env-key',
                    secretAccessKey: 'env-secret',
                    sessionToken: undefined
                },
                region: 'us-east-1'
            })
        })
    })
})
