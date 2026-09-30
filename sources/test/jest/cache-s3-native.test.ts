import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {HeadObjectCommand, ListObjectsV2Command, S3Client} from '@aws-sdk/client-s3'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {execFileSync} from 'node:child_process'

const info = jest.fn()
const warning = jest.fn()
const saveState = jest.fn()
jest.unstable_mockModule('@actions/core', () => ({info, warning, saveState}))
const {NativeS3Cache, legacyStateKey} = await import('../../src/cache-s3-native')

describe('native S3 archives', () => {
    let work: string
    let home: string
    let objects: string
    let cache: InstanceType<typeof NativeS3Cache>
    let environment: NodeJS.ProcessEnv
    let originalEnvironment: NodeJS.ProcessEnv
    const key = 'workers/gradle-home-v1|Linux-X64|tests[default]-commit'
    const physical = (logical: string): string => `workers/native-zstd-v1/${logical.slice('workers/'.length)}`
    const objectFile = (objectKey: string): string => path.join(objects, Buffer.from(`s3://bucket/${objectKey}`).toString('base64url'))
    const missing = (): Error => Object.assign(new Error('Not found'), {name: 'NotFound'})
    const send = jest.fn<(command: HeadObjectCommand | ListObjectsV2Command) => Promise<unknown>>()

    beforeEach(async () => {
        jest.clearAllMocks()
        originalEnvironment = {...process.env}
        work = await fs.mkdtemp(path.join(os.tmpdir(), 'native-s3-test-'))
        home = path.join(work, 'gradle home')
        objects = path.join(work, 'objects')
        const bin = path.join(work, 'bin')
        const temp = path.join(work, 'runner-temp')
        await Promise.all([fs.mkdir(objects), fs.mkdir(bin), fs.mkdir(temp)])
        // Only S3 is stubbed: exercise real tar, zstd, child processes, and streaming.
        await fs.writeFile(path.join(bin, 'aws'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 's3' || args[1] !== 'cp') process.exit(2);
fs.appendFileSync(process.env.NATIVE_TEST_CALLS, JSON.stringify(args) + '\\n');
const uri = args[2] === '-' ? args[3] : args[2];
const file = path.join(process.env.NATIVE_TEST_OBJECTS, Buffer.from(uri).toString('base64url'));
if (args[2] === '-') {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
        if (process.env.NATIVE_TEST_FAIL_UPLOAD) process.exit(23);
        fs.writeFileSync(file, Buffer.concat(chunks));
    });
} else {
    const data = fs.readFileSync(file);
    process.stdout.write(data, () => {
        if (process.env.NATIVE_TEST_FAIL_DOWNLOAD) process.exit(23);
    });
}
`, {mode: 0o755})
        process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
        process.env.RUNNER_TEMP = temp
        environment = {...process.env, NATIVE_TEST_OBJECTS: objects, NATIVE_TEST_CALLS: path.join(work, 'calls')}
        send.mockImplementation(async command => {
            if (command instanceof HeadObjectCommand) {
                try { await fs.stat(objectFile(command.input.Key!)); return {} } catch { throw missing() }
            }
            return {Contents: []}
        })
        cache = new NativeS3Cache('bucket', {send} as unknown as S3Client, environment, 'workers/')
    })

    afterEach(async () => {
        process.env = originalEnvironment
        await fs.rm(work, {recursive: true, force: true})
    })

    const populate = async (root: string, text: string): Promise<void> => {
        for (const entry of ['caches/modules-2/library.jar', 'caches/9.0/kotlin-dsl/scripts/script.bin',
            'caches/transforms-3/transform.jar', 'caches/build-cache-1/task', 'wrapper/dists/gradle.zip']) {
            await fs.mkdir(path.dirname(path.join(root, entry)), {recursive: true})
            await fs.writeFile(path.join(root, entry), text)
        }
    }
    const paths = (root: string): string[] => [path.join(root, 'caches'), path.join(root, 'wrapper')]

    it('round-trips full Gradle state into a different home with relative archive paths', async () => {
        await populate(home, 'cached state')
        await fs.symlink('library.jar', path.join(home, 'caches/modules-2/link.jar'))
        await expect(cache.save(paths(home), key)).resolves.toBe(true)
        const destination = path.join(work, 'another home')
        await expect(cache.restore(paths(destination), key, [])).resolves.toBe(key)
        for (const entry of ['caches/modules-2/library.jar', 'caches/9.0/kotlin-dsl/scripts/script.bin',
            'caches/transforms-3/transform.jar', 'caches/build-cache-1/task', 'wrapper/dists/gradle.zip']) {
            expect(await fs.readFile(path.join(destination, entry), 'utf8')).toBe('cached state')
        }
        expect(await fs.readlink(path.join(destination, 'caches/modules-2/link.jar'))).toBe('library.jar')
        expect(await fs.readdir(process.env.RUNNER_TEMP!)).toEqual([])
        expect(info).toHaveBeenCalledWith(expect.stringContaining('compressed bytes'))
    })

    it('round-trips a provisioned distribution file with spaces, a newline and a leading dash', async () => {
        const name = '-gradle distribution\n.zip'
        await fs.mkdir(home)
        await fs.writeFile(path.join(home, name), Buffer.from([0, 255, 1, 2]))
        await cache.save([path.join(home, name)], key)
        const destination = path.join(work, 'new directory', name)
        await cache.restore([destination], key, [])
        expect(await fs.readFile(destination)).toEqual(Buffer.from([0, 255, 1, 2]))
    })

    it('uses the newest entry across all pages of the first matching restore prefix', async () => {
        const older = 'workers/gradle-home-v1|Linux-X64|unit-old'
        const newer = 'workers/gradle-home-v1|Linux-X64|unit-new'
        await populate(home, 'old')
        await cache.save(paths(home), older)
        await populate(home, 'new')
        await cache.save(paths(home), newer)
        send.mockReset()
        send.mockRejectedValueOnce(missing())
            .mockResolvedValueOnce({Contents: [], IsTruncated: false})
            .mockResolvedValueOnce({Contents: [{Key: physical(older), LastModified: new Date('2025-01-01')}], IsTruncated: true, NextContinuationToken: 'page-2'})
            .mockResolvedValueOnce({Contents: [{Key: physical(newer), LastModified: new Date('2025-02-01')}], IsTruncated: false})
        await populate(home, 'local')
        await expect(cache.restore(paths(home), key, ['workers/gradle-home-v1|Linux-X64|ui', 'workers/gradle-home-v1|Linux-X64|']))
            .resolves.toBe(newer)
        expect(await fs.readFile(path.join(home, 'caches/modules-2/library.jar'), 'utf8')).toBe('new')
        expect((send.mock.calls[3][0] as ListObjectsV2Command).input.ContinuationToken).toBe('page-2')
    })

    it('does not install tools on a cache miss', async () => {
        await expect(cache.restore(paths(home), key, ['workers/gradle-home-v1|Linux-X64|'])).resolves.toBeUndefined()
        expect((send.mock.calls[1][0] as ListObjectsV2Command).input.Prefix)
            .toBe('workers/native-zstd-v1/gradle-home-v1|Linux-X64|')
        await expect(fs.stat(environment.NATIVE_TEST_CALLS!)).rejects.toThrow()
    })

    it('restores existing absolute-path gzip archives into a different Gradle home', async () => {
        await populate(home, 'legacy state')
        execFileSync('tar', ['-P', '-czf', objectFile(key), ...paths(home)])
        const destination = path.join(work, 'a', 'different', 'home')
        await expect(cache.restore(paths(destination), key, [])).resolves.toBe(key)
        expect(await fs.readFile(path.join(destination, 'caches/modules-2/library.jar'), 'utf8')).toBe('legacy state')
        expect(saveState).toHaveBeenCalledWith(legacyStateKey(key), true)
        // A writable job can migrate the same logical key without touching the legacy entry.
        await cache.save(paths(destination), key)
        expect((await fs.readFile(objectFile(key))).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
        expect((await fs.readFile(objectFile(physical(key)))).subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    })

    it('skips an existing entry without overwriting its contents', async () => {
        await fs.writeFile(objectFile(physical(key)), 'existing')
        await expect(cache.save(paths(home), key)).resolves.toBe(true)
        expect(await fs.readFile(objectFile(physical(key)), 'utf8')).toBe('existing')
        await expect(fs.stat(environment.NATIVE_TEST_CALLS!)).rejects.toThrow()
    })

    it('does not save when all paths are missing', async () => {
        await expect(cache.save(paths(home), key)).resolves.toBe(false)
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('no existing paths'))
    })

    it('can save only the existing paths when wrapper state is missing', async () => {
        await fs.mkdir(path.join(home, 'caches'), {recursive: true})
        await fs.writeFile(path.join(home, 'caches/file'), 'content')
        await cache.save(paths(home), key)
        const destination = path.join(work, 'restored')
        await cache.restore(paths(destination), key, [])
        expect(await fs.readFile(path.join(destination, 'caches/file'), 'utf8')).toBe('content')
    })

    it('leaves local state intact when zstd extraction fails', async () => {
        await populate(home, 'local')
        await fs.writeFile(objectFile(physical(key)), 'corrupted zstd')
        await expect(cache.restore(paths(home), key, [])).rejects.toThrow()
        expect(await fs.readFile(path.join(home, 'caches/modules-2/library.jar'), 'utf8')).toBe('local')
        expect(await fs.readdir(process.env.RUNNER_TEMP!)).toEqual([])
    })

    it('leaves local state intact even if a failing transfer emitted a complete archive', async () => {
        await populate(home, 'cached')
        await cache.save(paths(home), key)
        await populate(home, 'local')
        environment.NATIVE_TEST_FAIL_DOWNLOAD = 'true'
        await expect(cache.restore(paths(home), key, [])).rejects.toThrow()
        expect(await fs.readFile(path.join(home, 'caches/modules-2/library.jar'), 'utf8')).toBe('local')
        expect(await fs.readdir(process.env.RUNNER_TEMP!)).toEqual([])
    })

    it('reports failed uploads and cleans up local staging', async () => {
        await populate(home, 'cached')
        environment.NATIVE_TEST_FAIL_UPLOAD = 'true'
        await expect(cache.save(paths(home), key)).rejects.toThrow()
        await expect(fs.stat(objectFile(physical(key)))).rejects.toThrow()
        expect(await fs.readdir(process.env.RUNNER_TEMP!)).toEqual([])
    })

    it('does not finalize an upload when tar emits an archive but subsequently fails', async () => {
        await populate(home, 'cached')
        await cache.save(paths(home), key)
        const tarData = execFileSync('zstd', ['-dc', objectFile(physical(key))])
        await fs.writeFile(path.join(work, 'bin/tar'), `#!${process.execPath}
process.stdout.end(Buffer.from('${tarData.toString('base64')}', 'base64'));
setTimeout(() => process.exit(42), 200);
`, {mode: 0o755})
        const failedKey = `${key}-failed`
        await expect(cache.save(paths(home), failedKey)).rejects.toThrow()
        await expect(fs.stat(objectFile(physical(failedKey)))).rejects.toThrow()
        expect(await fs.readdir(process.env.RUNNER_TEMP!)).toEqual([])
    })

    it('reports S3 permission errors rather than treating them as a cache miss', async () => {
        send.mockRejectedValue(Object.assign(new Error('Access denied'), {$metadata: {httpStatusCode: 403}}))
        await expect(cache.restore(paths(home), key, [])).rejects.toThrow('Access denied')
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('rejects caching a filesystem root', async () => {
        await expect(cache.save([path.parse(home).root], key)).rejects.toThrow('filesystem root')
    })
})
