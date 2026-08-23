/** Domain event types that agents can subscribe to (§7.3). */
export const DomainEventTypes = {
  // Phase 2 — requisition & PO
  'requisition.submitted': 'requisition.submitted',
  'requisition.approved': 'requisition.approved',
  'requisition.rejected': 'requisition.rejected',
  'po.issued': 'po.issued',
  'po.confirmed': 'po.confirmed',
  'po.cancelled': 'po.cancelled',
  'approval.decided': 'approval.decided',
  // Phase 4 — invoicing
  'intake.received': 'intake.received',
  'invoice.received': 'invoice.received',
  'invoice.matched': 'invoice.matched',
  'invoice.exception': 'invoice.exception',
  // §8.1 — receipts (three-way match leg)
  'receipt.recorded': 'receipt.recorded',
  // Phase 5 — payment
  'paymentRun.approved': 'paymentRun.approved',
  'paymentRun.executed': 'paymentRun.executed',
  // §8.3 — messaging relay
  'message.submitted': 'message.submitted',
  'message.approved': 'message.approved',
  'message.rejected': 'message.rejected',
  'message.sent': 'message.sent',
} as const

export type DomainEventType =
  (typeof DomainEventTypes)[keyof typeof DomainEventTypes]

export interface DomainEventPayload {
  type: DomainEventType
  entityType: string
  entityId: string
  payload: Record<string, unknown>
}
