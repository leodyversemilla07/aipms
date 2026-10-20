import "@workspace/env/load"

import { PrismaPg } from "@prisma/adapter-pg"
import { type Prisma, PrismaClient } from "./generated/prisma/client"
import { databaseProvider } from "./provider"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the root of the repo and fill it in, or set DATABASE_URL in the environment."
  )
}

export interface PrismaLogRecord {
  level: Prisma.LogLevel
  message: string
  target: string
  durationMs?: number
}

export type PrismaLogSink = (record: PrismaLogRecord) => void

const consoleSink: PrismaLogSink = ({ level, message, target, durationMs }) => {
  const suffix = durationMs === undefined ? "" : ` (+${durationMs}ms)`
  const line = `[prisma:${level}] ${message}${suffix} [${target}]`

  if (level === "error") {
    console.error(line)
  } else if (level === "warn") {
    console.warn(line)
  } else {
    console.log(line)
  }
}

let sink: PrismaLogSink = consoleSink

export function setPrismaLogSink(next: PrismaLogSink | null): void {
  sink = next ?? consoleSink
}

const logQueries = process.env.PRISMA_LOG_QUERIES === "true"

const logDefinitions: Prisma.LogDefinition[] = [
  { level: "warn", emit: "event" },
  { level: "error", emit: "event" },
  ...(logQueries
    ? ([
        { level: "query", emit: "event" },
        { level: "info", emit: "event" },
      ] satisfies Prisma.LogDefinition[])
    : []),
]

/**
 * The driver adapter for the configured engine.
 *
 * The SQLite adapter is a development-only dependency, so it is loaded on
 * demand: a production image (PostgreSQL) never has to ship it, and the
 * dynamic import never resolves there.
 */
const createAdapter = async (url: string) => {
  if (databaseProvider(url) === "sqlite") {
    const { PrismaLibSql } = await import("@prisma/adapter-libsql")
    return new PrismaLibSql({ url })
  }
  return new PrismaPg({ connectionString: url })
}

const createPrismaClient = async () => {
  const client = new PrismaClient({
    adapter: await createAdapter(connectionString),
    log: logDefinitions,
  })

  client.$on("error", ({ message, target }) => {
    sink({ level: "error", message, target })
  })
  client.$on("warn", ({ message, target }) => {
    sink({ level: "warn", message, target })
  })
  client.$on("info", ({ message, target }) => {
    sink({ level: "info", message, target })
  })
  client.$on("query", ({ query, duration, target }) => {
    sink({ level: "query", message: query, target, durationMs: duration })
  })

  return client
}

const globalForPrisma = globalThis as unknown as {
  prisma: Awaited<ReturnType<typeof createPrismaClient>> | undefined
}

export const db = globalForPrisma.prisma ?? (await createPrismaClient())

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db
}

export type Db = typeof db
