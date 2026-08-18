import { Injectable } from '@nestjs/common'
import { db } from '@workspace/db'

/**
 * §7.1 agent run lifecycle. Tracks every agent execution end-to-end;
 * the runId is threaded through audit records so that "what did agent X
 * do during run Y?" is a first-class query.
 */
@Injectable()
export class AgentRunService {
  /** Start a new run, returning the record for tagging. */
  async start(agentId: string, skills: string[], taskId?: string) {
    return db.agentRun.create({
      data: { agentId, skills, taskId },
    })
  }

  /** Mark a run as succeeded with optional metadata. */
  async succeed(runId: string, meta?: Record<string, unknown>) {
    return db.agentRun.update({
      where: { id: runId },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        ...(meta ? { meta: meta as any } : {}),
      },
    })
  }

  /** Mark a run as failed. */
  async fail(runId: string, meta?: Record<string, unknown>) {
    return db.agentRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        ...(meta ? { meta: meta as any } : {}),
      },
    })
  }

  /** List recent runs, optionally filtered by agent or status. */
  async list(opts: { agentId?: string; status?: string; limit?: number }) {
    return db.agentRun.findMany({
      where: {
        ...(opts.agentId ? { agentId: opts.agentId } : {}),
        ...(opts.status ? { status: opts.status as never } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: opts.limit ?? 50,
    })
  }
}
