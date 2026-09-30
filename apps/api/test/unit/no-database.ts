import { vi } from 'vitest'

/** Fail closed if an isolated unit test accidentally reaches the real client. */
vi.mock('@workspace/db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `Unit tests cannot access db.${String(property)}; inject a fake client or use the guarded integration suite`,
        )
      },
    },
  ),
  // Unit fixtures inject clients; no real Prisma runtime or connection is needed.
  Prisma: {},
}))
