import type { INestApplication } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { listenApi } from '../../src/listen-api'

describe('API listener binding', () => {
  it.each([{}, { API_BIND_HOST: '' }])(
    'preserves the default dual-stack listener for %j',
    async (environment) => {
      const listen = vi.fn().mockResolvedValue(undefined)
      await listenApi(
        { listen } as unknown as Pick<INestApplication, 'listen'>,
        environment,
      )
      expect(listen).toHaveBeenCalledExactlyOnceWith(3001)
    },
  )

  it('uses the explicit loopback host and port for the isolated local demo', async () => {
    const listen = vi.fn().mockResolvedValue(undefined)
    const result = await listenApi(
      { listen } as unknown as Pick<INestApplication, 'listen'>,
      {
        PORT: '3002',
        API_BIND_HOST: '127.0.0.1',
      },
    )
    expect(listen).toHaveBeenCalledExactlyOnceWith(3002, '127.0.0.1')
    expect(result).toEqual({ port: 3002, host: '127.0.0.1' })
  })
})
