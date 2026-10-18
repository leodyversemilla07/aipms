/**
 * Compile-only DI bootstrap check (lifecycle hooks excluded): resolves the full
 * AppModule dependency graph without a database or server. Fails closed when any
 * provider cannot be constructed — the class of boot failure that previously
 * surfaced only in CI jobs (E2E webServer, demo bootstrap, production smoke).
 *
 * Requires the api dev toolchain loader: run through `pnpm --filter api di:check`.
 */
try {
  const { Test } = await import('@nestjs/testing')
  const { AppModule } = await import('../src/app.module.ts')

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile()

  try {
    await moduleRef.close()
  } catch {
    // close() is best-effort on a never-initialized module fixture.
  }

  console.log('[di-check] AppModule dependency graph resolves')
} catch (error) {
  console.error(
    '[di-check] AppModule failed to resolve:',
    error?.message ?? error,
  )
  process.exitCode = 1
}
