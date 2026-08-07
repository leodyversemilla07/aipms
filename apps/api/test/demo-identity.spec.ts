import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { AppModule } from './../src/app.module'

/**
 * @workspace demo identities — §16.4 maker/checker demo users are seeded at
 * boot when AUTH_SEED_DEMO=1 (non-production) and cleaned up here.
 */

const EMAILS = ['maker@demo.aipms', 'checker@demo.aipms']

describe('DemoIdentityService (§16.4 maker/checker seed)', () => {
  let app: INestApplication

  it('seeds the two demo identities on boot', async () => {
    process.env.AUTH_SEED_DEMO = '1'
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleFixture.createNestApplication()
    await app.init()

    const users = await db.user.findMany({
      where: { email: { in: EMAILS } },
    })
    expect(users.map((u) => u.email).sort()).toEqual([...EMAILS].sort())
  })

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: EMAILS } } })
    await db.$disconnect()
    delete process.env.AUTH_SEED_DEMO
    await app?.close()
  })
})
