import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { db } from '@workspace/db'
import {
  MESSAGE_DISPATCH_BATCH_SIZE,
  MESSAGE_DISPATCH_INTERVAL_MS,
  stagedMessageWhere,
} from './message-dispatch-policy'
import { MessagingService } from './messaging.service'

/**
 * Recover post-commit/pre-release crashes. Replicas may select the same row;
 * MessagingService's durable conditional claim grants only one sender.
 * Never selects or reclaims sending/failed rows, regardless of their age.
 */
@Injectable()
export class MessageDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageDispatcherService.name)
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private stopping = false

  constructor(private readonly messaging: MessagingService) {}

  onModuleInit() {
    const configured = process.env.AIPMS_MESSAGING_DISPATCHER_ENABLED
    if (configured !== undefined && !['0', '1'].includes(configured)) {
      throw new Error('AIPMS_MESSAGING_DISPATCHER_ENABLED must be 0 or 1')
    }
    if (
      configured === '0' ||
      (configured === undefined && process.env.NODE_ENV === 'test')
    ) {
      return
    }
    this.stopping = false
    this.timer = setInterval(
      () => void this.poll(),
      MESSAGE_DISPATCH_INTERVAL_MS,
    )
    this.timer.unref?.()
    this.logger.log('staged message dispatcher enabled')
  }

  onModuleDestroy() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Bounded pass; injected client is a database-blocked regression seam. */
  async poll(client: typeof db = db) {
    if (this.polling || this.stopping) return
    this.polling = true
    try {
      const candidates = await client.message.findMany({
        where: stagedMessageWhere(),
        select: { id: true, status: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MESSAGE_DISPATCH_BATCH_SIZE,
      })
      for (const message of candidates) {
        if (this.stopping) break
        try {
          if (message.status === 'queued') {
            await this.messaging.dispatchIfQueued(message.id, client)
          } else if (message.status === 'approved') {
            await this.messaging.releaseApproved(message.id, client)
          }
        } catch (error) {
          // Isolate DB/claim errors; do not reset or replay ambiguous sends.
          this.logger.error(`message dispatch failed for ${message.id}`, error)
        }
      }
    } catch (error) {
      this.logger.error('staged message dispatcher poll failed', error)
    } finally {
      this.polling = false
    }
  }
}
