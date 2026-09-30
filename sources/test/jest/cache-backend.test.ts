import {afterEach, describe, expect, it} from '@jest/globals'

import * as cacheBackend from '../../src/cache-backend'

const inputEnvKeys = [
    'INPUT_AWS-S3-BUCKET',
    'INPUT_AWS-ACCESS-KEY-ID',
    'INPUT_AWS-SECRET-ACCESS-KEY',
    'INPUT_AWS-SESSION-TOKEN',
    'INPUT_AWS-REGION',
    'INPUT_AWS-S3-CACHE-TRANSPORT',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION'
]

describe('cache backend configuration', () => {
    afterEach(() => {
        for (const key of inputEnvKeys) {
            delete process.env[key]
        }
    })

    it('returns no bucket name when S3 inputs are not configured', () => {
        expect(cacheBackend.getInputS3BucketName()).toBeUndefined()
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

        expect(cacheBackend.getInputS3BucketName()).toBe('explicit-bucket')
        expect(cacheBackend.getInputS3ClientConfig()).toEqual({
            credentials: {
                accessKeyId: 'input-key',
                secretAccessKey: 'input-secret',
                sessionToken: 'input-token'
            },
            region: 'eu-west-1'
        })
    })

    it('falls back to AWS environment variables when inputs are omitted', () => {
        process.env.AWS_ACCESS_KEY_ID = 'env-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'env-secret'
        process.env.AWS_REGION = 'us-east-1'

        expect(cacheBackend.getInputS3ClientConfig()).toEqual({
            credentials: {
                accessKeyId: 'env-key',
                secretAccessKey: 'env-secret',
                sessionToken: undefined
            },
            region: 'us-east-1'
        })
    })

    it('uses the legacy S3 transport unless native is explicitly selected', () => {
        expect(cacheBackend.getInputS3Transport()).toBe('legacy')
        process.env['INPUT_AWS-S3-CACHE-TRANSPORT'] = 'native'
        expect(cacheBackend.getInputS3Transport()).toBe('native')
        process.env['INPUT_AWS-S3-CACHE-TRANSPORT'] = 'unknown'
        expect(() => cacheBackend.getInputS3Transport()).toThrow('legacy or native')
    })

    it('passes the same explicit credentials and region to AWS CLI as the SDK', () => {
        process.env['INPUT_AWS-ACCESS-KEY-ID'] = 'input-key'
        process.env['INPUT_AWS-SECRET-ACCESS-KEY'] = 'input-secret'
        process.env['INPUT_AWS-SESSION-TOKEN'] = 'input-token'
        process.env['INPUT_AWS-REGION'] = 'eu-west-1'
        process.env.AWS_ACCESS_KEY_ID = 'env-key'
        process.env.AWS_SECRET_ACCESS_KEY = 'env-secret'
        const before = {...process.env}
        expect(cacheBackend.getInputS3Environment()).toMatchObject({
            AWS_ACCESS_KEY_ID: 'input-key',
            AWS_SECRET_ACCESS_KEY: 'input-secret',
            AWS_SESSION_TOKEN: 'input-token',
            AWS_REGION: 'eu-west-1',
            AWS_DEFAULT_REGION: 'eu-west-1'
        })
        expect(process.env).toEqual(before)
    })
})
