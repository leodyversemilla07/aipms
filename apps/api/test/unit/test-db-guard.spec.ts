import { afterEach, describe, expect, it, vi } from 'vitest'
import guardApiTestDatabase from '../test-db.guard'

const url = 'postgresql://aipms:aipms@localhost:5432/aipms_test'

describe('API globalSetup database guard', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reads process URLs rather than the Vitest project context', () => {
    vi.stubEnv('DATABASE_URL', url)
    vi.stubEnv('AIPMS_TEST_DATABASE_URL', url)
    expect(() =>
      Reflect.apply(guardApiTestDatabase, undefined, [
        { config: { root: '/synthetic-vitest-project' } },
      ]),
    ).not.toThrow()
  })

  it('does not use the project context to supply missing URLs', () => {
    vi.stubEnv('DATABASE_URL', url)
    vi.stubEnv('AIPMS_TEST_DATABASE_URL', '')
    expect(() =>
      Reflect.apply(guardApiTestDatabase, undefined, [
        { DATABASE_URL: url, AIPMS_TEST_DATABASE_URL: url },
      ]),
    ).toThrow(/identical/)
  })

  it('still refuses explicitly selected development databases', () => {
    const development = url.replace('aipms_test', 'aipms')
    vi.stubEnv('DATABASE_URL', development)
    vi.stubEnv('AIPMS_TEST_DATABASE_URL', development)
    expect(() => guardApiTestDatabase()).toThrow(/name ends in _test/)
  })
})
