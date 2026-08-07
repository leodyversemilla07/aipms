import { db } from "../src/client"

async function main() {
  const users = await db.user.count()
  console.log(`Database ready. ${users} user(s).`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
