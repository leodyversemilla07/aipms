import { Injectable } from '@nestjs/common'

/**
 * Sequential document numbers (REQ-000001, PO-2026-000001 style). The sequence
 * derives from the highest existing number for the prefix; callers retry the
 * create on a unique-key race, which the idempotency layer makes safe.
 */
@Injectable()
export class DocumentNumberService {
  async next(
    prefix: string,
    latest: () => Promise<string | null>,
  ): Promise<string> {
    const last = await latest()
    const seq = last ? Number.parseInt(last.slice(prefix.length), 10) + 1 : 1
    return `${prefix}${String(seq).padStart(6, '0')}`
  }
}
