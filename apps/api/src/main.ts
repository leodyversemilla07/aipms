import '@workspace/env/load'
import { NestFactory } from '@nestjs/core'
import { auth } from '@workspace/auth'
import { toNodeHandler } from 'better-auth/node'
import type { RequestHandler } from 'express'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // SCIM is bearer-only server-to-server traffic. Strip ambient cookies before
  // Better Auth's browser CSRF middleware sees the request: reverse proxies can
  // forward an empty Cookie header, and an operator browsing the endpoint can
  // carry a session cookie. Neither may influence SCIM bearer authorization.
  const stripScimCookies: RequestHandler = (req, _res, next) => {
    delete req.headers.cookie
    next()
  }
  app.use('/api/auth/scim/v2', stripScimCookies)

  // Better Auth HTTP endpoints (/api/auth/sign-up, /api/auth/sign-in, …).
  // Registered before Nest's body parser so the raw request body is intact;
  // the web app proxies /api/auth/* here via a Next rewrite.
  app.use('/api/auth', toNodeHandler(auth) as Parameters<typeof app.use>[1])

  const port = Number(process.env.PORT ?? 3001)
  await app.listen(port)
  console.log(`API listening on http://localhost:${port}/api/trpc`)
}
bootstrap()
