import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { auth } from '@workspace/auth'

/**
 * Dev-only maker/checker identities. §16.4 requires the payment-run approver
 * to differ from the maker; a single browser can't demo that with one
 * account. When AUTH_SEED_DEMO=1 (non-production), boot seeds two demo users
 * with known passwords so the web identity switcher can alternate. Seeding is
 * idempotent — an existing user is left untouched.
 */
const DEMO_USERS = [
  { name: 'Demo Maker', email: 'maker@demo.aipms', password: 'demo-maker-123' },
  {
    name: 'Demo Checker',
    email: 'checker@demo.aipms',
    password: 'demo-checker-123',
  },
] as const

@Injectable()
export class DemoIdentityService implements OnModuleInit {
  private readonly logger = new Logger(DemoIdentityService.name)

  async onModuleInit() {
    if (process.env.NODE_ENV === 'production') return
    if (process.env.AUTH_SEED_DEMO !== '1') {
      this.logger.log(
        'demo identities disabled (set AUTH_SEED_DEMO=1 to enable)',
      )
      return
    }
    for (const user of DEMO_USERS) {
      try {
        const result = await auth.api.signUpEmail({
          body: {
            name: user.name,
            email: user.email,
            password: user.password,
          },
        })
        if ('error' in result) {
          this.logger.log(
            `demo user ${user.email} already present (idempotent)`,
          )
        } else {
          this.logger.log(`seeded demo user ${user.email}`)
        }
      } catch {
        this.logger.log(`demo user ${user.email} already present (idempotent)`)
      }
    }
  }
}
