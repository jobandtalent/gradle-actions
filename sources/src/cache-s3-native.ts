import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {HeadObjectCommand, ListObjectsV2Command, S3Client} from '@aws-sdk/client-s3'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import which from 'which'

const NAMESPACE = 'native-zstd-v1/'
export function legacyStateKey(key: string): string {
    return `NATIVE_S3_RESTORED_LEGACY_${createHash('sha256').update(key).digest('hex')}`
}

type Command = {program: string; args: string[]}

/** Native transport for the same paths and logical keys used by the S3 basic provider. */
export class NativeS3Cache {
    constructor(
        private readonly bucket: string,
        private readonly client: S3Client,
        private readonly environment: NodeJS.ProcessEnv,
        private readonly projectPrefix: string
    ) {}

    async restore(paths: string[], key: string, restoreKeys: string[]): Promise<string | undefined> {
        core.saveState(legacyStateKey(key), false)
        const nativeKey = await this.findEntry(key, restoreKeys, true)
        const objectKey = nativeKey || (await this.findEntry(key, restoreKeys, false))
        if (!objectKey) {
            core.info('Native S3 cache: no matching entry found.')
            return undefined
        }

        const layout = archiveLayout(paths)
        const work = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gradle-s3-'))
        const start = performance.now()
        try {
            const tools = await prepareTools(work, !!nativeKey)
            const staging = path.join(work, 'restore')
            await fs.mkdir(staging)
            const bytes = await runPipeline(
                [
                    {program: tools.aws, args: ['s3', 'cp', this.uri(objectKey), '-', '--only-show-errors']},
                    nativeKey
                        ? {program: tools.zstd, args: ['-d', '-q']}
                        : {program: await which('gzip'), args: ['-dc']},
                    {program: tools.tar, args: ['-xf', '-', '-C', staging]}
                ],
                this.environment,
                undefined,
                0
            )

            // Do not replace local state until every process, including the transfer, succeeded.
            const archiveRoot = nativeKey ? staging : await findLegacyRoot(staging, layout.entries)
            const restored = []
            for (const entry of layout.entries) {
                const source = path.join(archiveRoot, entry)
                try {
                    await fs.lstat(source)
                    restored.push({source, destination: path.join(layout.root, entry)})
                } catch (error) {
                    if (!isMissing(error)) throw error
                }
            }
            if (restored.length === 0) throw new Error('Native S3 archive contains none of the requested paths.')
            for (const entry of restored) {
                await fs.mkdir(path.dirname(entry.destination), {recursive: true})
                await fs.rm(entry.destination, {recursive: true, force: true})
                try {
                    await fs.rename(entry.source, entry.destination)
                } catch (error) {
                    // Staging may be on a different filesystem from GRADLE_USER_HOME.
                    if (!hasCode(error, 'EXDEV')) throw error
                    await fs.cp(entry.source, entry.destination, {
                        recursive: true,
                        verbatimSymlinks: true,
                        preserveTimestamps: true
                    })
                }
            }
            const restoredKey = nativeKey ? this.logicalKey(objectKey) : objectKey
            core.saveState(legacyStateKey(key), !nativeKey)
            core.info(`Native S3 cache restored ${objectKey}: ${bytes} compressed bytes in ${elapsed(start)}s.`)
            return restoredKey
        } finally {
            await fs.rm(work, {recursive: true, force: true})
        }
    }

    async save(paths: string[], key: string): Promise<boolean> {
        const objectKey = this.objectKey(key)
        if (await this.exists(objectKey)) {
            core.info(`Native S3 cache entry ${objectKey} already exists; skipping save.`)
            return true
        }
        const layout = archiveLayout(paths)
        const entries = []
        for (const entry of layout.entries) {
            try {
                await fs.lstat(path.join(layout.root, entry))
                entries.push(entry)
            } catch (error) {
                if (!isMissing(error)) throw error
            }
        }
        if (entries.length === 0) {
            core.warning('Native S3 cache: no existing paths to save.')
            return false
        }

        const work = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gradle-s3-'))
        const start = performance.now()
        try {
            const tools = await prepareTools(work)
            const bytes = await runPipeline(
                [
                    {program: tools.tar, args: ['-cf', '-', '-C', layout.root, '--null', '-T', '-']},
                    {program: tools.zstd, args: ['-T0', '-3', '-q']},
                    {program: tools.aws, args: ['s3', 'cp', '-', this.uri(objectKey), '--only-show-errors']}
                ],
                this.environment,
                Buffer.from(`${entries.join('\0')}\0`),
                1
            )
            core.info(`Native S3 cache saved ${objectKey}: ${bytes} compressed bytes in ${elapsed(start)}s.`)
            return true
        } finally {
            await fs.rm(work, {recursive: true, force: true})
        }
    }

    private async findEntry(key: string, restoreKeys: string[], native: boolean): Promise<string | undefined> {
        const storageKey = (logical: string): string => (native ? this.objectKey(logical) : logical)
        const exact = storageKey(key)
        if (await this.exists(exact)) return exact
        for (const restoreKey of restoreKeys) {
            const prefix = storageKey(restoreKey)
            let continuation: string | undefined
            let newest: {key: string; modified: number} | undefined
            do {
                const response = await this.client.send(
                    new ListObjectsV2Command({Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuation})
                )
                for (const object of response.Contents || []) {
                    if (!object.Key?.startsWith(prefix)) continue
                    const modified = object.LastModified?.getTime() || 0
                    if (!newest || modified > newest.modified) newest = {key: object.Key, modified}
                }
                continuation = response.IsTruncated ? response.NextContinuationToken : undefined
                if (response.IsTruncated && !continuation) throw new Error('S3 listing is missing its next page token.')
            } while (continuation)
            if (newest) return newest.key
        }
        return undefined
    }

    private async exists(key: string): Promise<boolean> {
        try {
            await this.client.send(new HeadObjectCommand({Bucket: this.bucket, Key: key}))
            return true
        } catch (error) {
            if (error instanceof Error && ('$metadata' in error || 'name' in error)) {
                const s3Error = error as Error & {$metadata?: {httpStatusCode?: number}}
                if (s3Error.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error.name)) {
                    return false
                }
            }
            throw error
        }
    }

    private objectKey(key: string): string {
        if (!key.startsWith(this.projectPrefix)) throw new Error('Cache key does not start with the project prefix.')
        return `${this.projectPrefix}${NAMESPACE}${key.slice(this.projectPrefix.length)}`
    }

    private logicalKey(key: string): string {
        return `${this.projectPrefix}${key.slice(this.projectPrefix.length + NAMESPACE.length)}`
    }

    private uri(key: string): string {
        return `s3://${this.bucket}/${key}`
    }
}

function archiveLayout(paths: string[]): {root: string; entries: string[]} {
    if (!paths.length) throw new Error('No cache paths provided.')
    const resolved = [...new Set(paths.map(entry => path.resolve(entry)))]
    if (resolved.some(entry => entry === path.parse(entry).root)) throw new Error('Cannot cache a filesystem root.')
    let root = path.dirname(resolved[0])
    while (resolved.some(entry => !within(root, entry))) root = path.dirname(root)
    const entries = resolved
        .filter(entry => !resolved.some(parent => parent !== entry && within(parent, entry)))
        .map(entry => path.relative(root, entry))
    return {root, entries}
}

function within(parent: string, child: string): boolean {
    const relative = path.relative(parent, child)
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Legacy tar archives contain absolute source paths. Extract them under staging,
 * then locate their common root without assuming the previous runner's home path. */
async function findLegacyRoot(staging: string, entries: string[]): Promise<string> {
    let root = staging
    while (true) {
        for (const entry of entries) {
            try {
                await fs.lstat(path.join(root, entry))
                return root
            } catch (error) {
                if (!isMissing(error)) throw error
            }
        }
        const children = await fs.readdir(root, {withFileTypes: true})
        if (children.length !== 1 || !children[0].isDirectory()) {
            throw new Error('Legacy S3 archive does not contain the requested cache paths.')
        }
        root = path.join(root, children[0].name)
    }
}

async function prepareTools(work: string, needsZstd = true): Promise<{tar: string; zstd: string; aws: string}> {
    const tar = await which('tar')
    let zstd = needsZstd ? await which('zstd', {nothrow: true}) : ''
    if (needsZstd && !zstd) {
        if (process.platform !== 'linux') throw new Error('Install zstd before using the native S3 transport.')
        await exec.exec('sudo', ['apt-get', 'update', '-qq'])
        await exec.exec('sudo', ['apt-get', 'install', '-y', '-qq', 'zstd'])
        zstd = await which('zstd')
    }
    let aws = await which('aws', {nothrow: true})
    if (!aws) {
        if (process.platform !== 'linux' || process.arch !== 'x64') {
            throw new Error('Install AWS CLI before using the native S3 transport.')
        }
        const toolCache = await import('@actions/tool-cache')
        const zip = await toolCache.downloadTool(
            'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip',
            path.join(work, 'aws.zip')
        )
        const unpacked = await toolCache.extractZip(zip, path.join(work, 'aws-installer'))
        await exec.exec(path.join(unpacked, 'aws', 'install'), [
            '--install-dir',
            path.join(work, 'aws-cli'),
            '--bin-dir',
            path.join(work, 'bin')
        ])
        aws = path.join(work, 'bin', 'aws')
    }
    return {tar, zstd: zstd || '', aws}
}

async function runPipeline(
    commands: Command[],
    environment: NodeJS.ProcessEnv,
    input: Buffer | undefined,
    countedOutput: number
): Promise<number> {
    const children = commands.map(command => spawn(command.program, command.args, {env: environment, stdio: 'pipe'}))
    let bytes = 0
    children[countedOutput].stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
    })
    const completion = children.map(
        async (child, index) =>
            new Promise<void>((resolve, reject) => {
                let stderr = ''
                child.stderr.on('data', (chunk: Buffer) => {
                    stderr = (stderr + chunk.toString()).slice(-8192)
                })
                child.once('error', reject)
                child.once('close', (code, signal) => {
                    if (code === 0) resolve()
                    else
                        reject(
                            new Error(
                                `${path.basename(commands[index].program)} failed (${signal || code}): ${stderr.trim()}`
                            )
                        )
                })
            })
    )
    const transfers = children.slice(0, -1).map(async (child, i) => {
        if (input !== undefined && i === children.length - 2) {
            // AWS CLI finalizes the upload at EOF. Hold EOF until archive producers have
            // exited successfully, even if a failing tar emitted a complete-looking stream.
            const gate = new Transform({
                transform(chunk, _encoding, callback): void {
                    callback(null, chunk)
                },
                flush(callback): void {
                    Promise.all(completion.slice(0, -1)).then(
                        () => callback(),
                        error => callback(error instanceof Error ? error : new Error(String(error)))
                    )
                }
            })
            await pipeline(child.stdout, gate, children[i + 1].stdin)
        } else {
            await pipeline(child.stdout, children[i + 1].stdin)
        }
    })
    transfers.push(pipeline(Readable.from(input ? [input] : []), children[0].stdin))
    children[children.length - 1].stdout.resume()
    try {
        await Promise.all([...completion, ...transfers])
        return bytes
    } catch (error) {
        for (const child of children) child.kill()
        await Promise.allSettled([...completion, ...transfers])
        throw error
    }
}

function isMissing(error: unknown): boolean {
    return hasCode(error, 'ENOENT')
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function elapsed(start: number): string {
    return ((performance.now() - start) / 1000).toFixed(2)
}
