import { Module } from '@nestjs/common'
import { DemoIdentityService } from './demo-identity.service'

/** Dev-only demo identities for the §16.4 maker/checker switcher. */
@Module({
  providers: [DemoIdentityService],
})
export class AuthModule {}
