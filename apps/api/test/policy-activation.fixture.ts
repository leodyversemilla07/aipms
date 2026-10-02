import { db } from '@workspace/db'

/** Serial integration specs restore only activation flags they inherited.
 * This is disposable-database fixture cleanup, never production rollback. */
export async function capturePolicyActivation() {
  const rows = await db.policy.findMany({ select: { id: true, enabled: true } })
  return async () => {
    for (const enabled of [false, true]) {
      await db.policy.updateMany({
        where: {
          id: {
            in: rows
              .filter((row) => row.enabled === enabled)
              .map((row) => row.id),
          },
        },
        data: { enabled },
      })
    }
  }
}
