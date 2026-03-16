import {describe, expect, it} from '@jest/globals'

import {Client} from '@itchyny/s3-cache-action/lib/client.js'

describe('s3 cache compatibility', () => {
    it('uses the legacy flat object key format when no file suffix is provided', () => {
        expect((Client as any).joinKey('workers/1c7172b776bef915734a670dc1875984', undefined)).toBe(
            'workers/1c7172b776bef915734a670dc1875984'
        )
    })

    it('returns raw object keys for restore-key listings when using the legacy format', async () => {
        const client = new Client('bucket-name', {
            send: async () => ({
                Contents: [
                    {
                        Key: 'workers/older-key',
                        LastModified: new Date('2026-03-15T10:00:00.000Z')
                    },
                    {
                        Key: 'workers/newer-key',
                        LastModified: new Date('2026-03-16T10:00:00.000Z')
                    }
                ],
                IsTruncated: false
            })
        } as never)

        await expect((client as any).listObjects('workers/', undefined)).resolves.toEqual([
            'workers/newer-key',
            'workers/older-key'
        ])
    })
})
