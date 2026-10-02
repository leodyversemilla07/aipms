import type { INestApplication } from '@nestjs/common'

/** Preserve Nest/Node's dual-stack default unless a bind host is explicit. */
export async function listenApi(
  app: Pick<INestApplication, 'listen'>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const port = Number(environment.PORT ?? 3001)
  const host = environment.API_BIND_HOST
  if (host) await app.listen(port, host)
  else await app.listen(port)
  return { port, host: host || 'localhost' }
}
