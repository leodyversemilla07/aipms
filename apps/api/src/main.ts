import '@workspace/env/load'
import { NestFactory } from '@nestjs/core'
import { auth } from '@workspace/auth'
import { toNodeHandler } from 'better-auth/node'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // Better Auth HTTP endpoints (/api/auth/sign-up, /api/auth/sign-in, …).
  // Registered before Nest's body parser so the raw request body is intact;
  // the web app proxies /api/auth/* here via a Next rewrite.
  app.use('/api/auth', toNodeHandler(auth) as Parameters<typeof app.use>[1])

  const port = Number(process.env.PORT ?? 3001)
  await app.listen(port)
  console.log(`API listening on http://localhost:${port}/api/trpc`)
}
bootstrap()
