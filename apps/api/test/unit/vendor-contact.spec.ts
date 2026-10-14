import './no-database'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import type { AuditService } from '../../src/shared/audit/audit.service'
import type { IdempotencyService } from '../../src/shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../../src/trpc/context.types'
import { VendorRouter } from '../../src/vendor/vendor.router'
import {
  normalizeContactEmail,
  type VendorContactChannels,
  VendorService,
} from '../../src/vendor/vendor.service'

describe('vendor contact channels (§8.3 / §16)', () => {
  describe('normalizeContactEmail', () => {
    it('lowercases and trims valid email addresses', () => {
      expect(normalizeContactEmail('  Billing@Acme.Example  ')).toBe(
        'billing@acme.example',
      )
      expect(normalizeContactEmail('AP+TEST@SUB.DOMAIN.PH')).toBe(
        'ap+test@sub.domain.ph',
      )
    })

    it('rejects malformed or empty email addresses', () => {
      expect(() => normalizeContactEmail('')).toThrow(BadRequestException)
      expect(() => normalizeContactEmail('   ')).toThrow(BadRequestException)
      expect(() => normalizeContactEmail('notanemail')).toThrow(
        BadRequestException,
      )
      expect(() => normalizeContactEmail('missing@domain')).toThrow(
        BadRequestException,
      )
      expect(() => normalizeContactEmail('@missinguser.com')).toThrow(
        BadRequestException,
      )
    })
  })

  describe('VendorService contact operations', () => {
    const service = new VendorService()

    function mockTx(vendorData: Record<string, unknown>) {
      let current = { ...vendorData }
      return {
        $queryRaw: vi.fn().mockResolvedValue([]),
        vendor: {
          findUnique: vi.fn(async () => ({ ...current })),
          update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            current = { ...current, ...data }
            return { ...current }
          }),
        },
        getCurrent: () => current,
      }
    }

    it('enrolls and verifies a contact email with evidence and audit metadata', async () => {
      const tx = mockTx({
        id: 'vendor-1',
        name: 'Acme Corp',
        status: 'active',
        contactChannels: null,
      })

      const result = await service.verifyContact(
        'vendor-1',
        {
          email: '  Billing@Acme.Corp  ',
          evidence: 'Signed onboarding document 2026-10-14',
        },
        'user-procurement-1',
        tx as unknown as Prisma.TransactionClient,
      )

      const channels =
        result.contactChannels as unknown as VendorContactChannels
      expect(channels.verifiedEmails).toEqual(['billing@acme.corp'])
      expect(channels.entries).toHaveLength(1)
      expect(channels.entries?.[0]).toMatchObject({
        email: 'billing@acme.corp',
        verifiedBy: 'user-procurement-1',
        evidence: 'Signed onboarding document 2026-10-14',
      })
      expect(typeof channels.entries?.[0]?.verifiedAt).toBe('string')
    })

    it('deduplicates repeat verification while updating evidence and verifier', async () => {
      const tx = mockTx({
        id: 'vendor-1',
        name: 'Acme Corp',
        status: 'active',
        contactChannels: {
          verifiedEmails: ['billing@acme.corp'],
          entries: [
            {
              email: 'billing@acme.corp',
              verifiedAt: '2026-01-01T00:00:00.000Z',
              verifiedBy: 'legacy-admin',
              evidence: 'Old onboarding form',
            },
          ],
        },
      })

      const result = await service.verifyContact(
        'vendor-1',
        {
          email: 'billing@acme.corp',
          evidence: 'Updated annual verification agreement',
        },
        'user-finance-2',
        tx as unknown as Prisma.TransactionClient,
      )

      const channels =
        result.contactChannels as unknown as VendorContactChannels
      expect(channels.verifiedEmails).toEqual(['billing@acme.corp'])
      expect(channels.entries).toHaveLength(1)
      expect(channels.entries?.[0]?.verifiedBy).toBe('user-finance-2')
      expect(channels.entries?.[0]?.evidence).toBe(
        'Updated annual verification agreement',
      )
    })

    it('refuses contact verification on blacklisted vendors', async () => {
      const tx = mockTx({
        id: 'vendor-blocked',
        name: 'Bad Vendor Inc',
        status: 'blacklisted',
        contactChannels: null,
      })

      await expect(
        service.verifyContact(
          'vendor-blocked',
          {
            email: 'ap@badvendor.com',
            evidence: 'Valid document',
          },
          'user-1',
          tx as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(ForbiddenException)
    })

    it('refuses short or empty verification evidence', async () => {
      const tx = mockTx({
        id: 'vendor-1',
        name: 'Acme Corp',
        status: 'active',
        contactChannels: null,
      })

      await expect(
        service.verifyContact(
          'vendor-1',
          {
            email: 'ap@acme.corp',
            evidence: 'ok',
          },
          'user-1',
          tx as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it('revokes an enrolled contact and removes it from verifiedEmails', async () => {
      const tx = mockTx({
        id: 'vendor-1',
        name: 'Acme Corp',
        status: 'active',
        contactChannels: {
          verifiedEmails: ['billing@acme.corp', 'ap@acme.corp'],
          entries: [
            {
              email: 'billing@acme.corp',
              verifiedAt: '2026-01-01T00:00:00.000Z',
              verifiedBy: 'admin',
              evidence: 'Contract',
            },
            {
              email: 'ap@acme.corp',
              verifiedAt: '2026-01-01T00:00:00.000Z',
              verifiedBy: 'admin',
              evidence: 'Contract',
            },
          ],
        },
      })

      const result = await service.revokeContact(
        'vendor-1',
        { email: 'billing@acme.corp', reason: 'Email decommissioned' },
        'user-1',
        tx as unknown as Prisma.TransactionClient,
      )

      const channels =
        result.contactChannels as unknown as VendorContactChannels
      expect(channels.verifiedEmails).toEqual(['ap@acme.corp'])
      expect(channels.entries).toHaveLength(1)
      expect(channels.entries?.[0]?.email).toBe('ap@acme.corp')
    })

    it('refuses to revoke an email that is not enrolled', async () => {
      const tx = mockTx({
        id: 'vendor-1',
        name: 'Acme Corp',
        status: 'active',
        contactChannels: { verifiedEmails: ['ap@acme.corp'], entries: [] },
      })

      await expect(
        service.revokeContact(
          'vendor-1',
          { email: 'other@acme.corp' },
          'user-1',
          tx as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(NotFoundException)
    })

    it('invalidates existing contact channels when vendor is blacklisted', async () => {
      const tx = mockTx({
        id: 'vendor-1',
        name: 'Acme Corp',
        status: 'active',
        contactChannels: {
          verifiedEmails: ['billing@acme.corp'],
          entries: [
            {
              email: 'billing@acme.corp',
              verifiedAt: '',
              verifiedBy: '',
              evidence: '',
            },
          ],
        },
      })

      await service.update(
        'vendor-1',
        { status: 'blacklisted', blacklistReason: 'Severe fraud' },
        tx as unknown as Prisma.TransactionClient,
      )

      const current = tx.getCurrent()
      expect(current.status).toBe('blacklisted')
      expect(current.contactChannels).toEqual({
        verifiedEmails: [],
        entries: [],
      })
    })
  })

  describe('VendorRouter role and audit boundaries', () => {
    function fixture(vendorRow: Record<string, unknown>) {
      const tx = {
        vendor: {
          findUnique: vi.fn(async () => ({ ...vendorRow })),
          update: vi.fn(
            async ({ data }: { data: Record<string, unknown> }) => ({
              ...vendorRow,
              ...data,
            }),
          ),
        },
      }
      const vendorService = {
        verifyContact: vi.fn(async (_id, input, actorId) => ({
          ...vendorRow,
          contactChannels: {
            verifiedEmails: [input.email],
            entries: [
              {
                email: input.email,
                evidence: input.evidence,
                verifiedBy: actorId,
                verifiedAt: new Date().toISOString(),
              },
            ],
          },
        })),
        revokeContact: vi.fn(async (_id, _input) => ({
          ...vendorRow,
          contactChannels: { verifiedEmails: [], entries: [] },
        })),
      }
      const idempotency = {
        runAtomic: vi.fn(async (_scope, work) =>
          work(tx as unknown as Prisma.TransactionClient),
        ),
      }
      const audit = {
        record: vi.fn().mockResolvedValue(undefined),
      }

      const router = new VendorRouter(
        vendorService as unknown as VendorService,
        idempotency as unknown as IdempotencyService,
        audit as unknown as AuditService,
      )

      return { router, vendorService, idempotency, audit, tx }
    }

    function context(
      actorKind: 'human' | 'agent',
      role: 'user' | 'procurement' | 'finance' = 'procurement',
    ): AuthedTrpcContext {
      return {
        actorKind,
        session: null,
        user: { id: `user-${role}`, kind: actorKind, role },
      } as AuthedTrpcContext
    }

    it('allows authorized procurement users and writes an audit entry', async () => {
      const { router, audit } = fixture({
        id: 'vendor-1',
        name: 'Acme',
        status: 'active',
      })
      const ctx = context('human', 'procurement')

      await router.verifyContact(
        {
          idempotencyKey: 'key-1',
          vendorId: 'vendor-1',
          email: 'billing@acme.ph',
          evidence: 'Signed onboarding pack',
        },
        ctx,
      )

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'vendor.verifyContact',
          entity: 'Vendor',
          entityId: 'vendor-1',
          actorId: 'user-procurement',
          actorKind: 'human',
        }),
        expect.anything(),
      )
    })

    it('rejects ordinary users without procurement or finance role', async () => {
      const { router } = fixture({
        id: 'vendor-1',
        name: 'Acme',
        status: 'active',
      })
      const ctx = context('human', 'user')

      await expect(
        router.verifyContact(
          {
            idempotencyKey: 'key-2',
            vendorId: 'vendor-1',
            email: 'billing@acme.ph',
            evidence: 'Evidence',
          },
          ctx,
        ),
      ).rejects.toThrow(TRPCError)
    })

    it('rejects agent machine callers outright', async () => {
      const { router } = fixture({
        id: 'vendor-1',
        name: 'Acme',
        status: 'active',
      })
      const ctx = context('agent', 'user')

      await expect(
        router.verifyContact(
          {
            idempotencyKey: 'key-3',
            vendorId: 'vendor-1',
            email: 'billing@acme.ph',
            evidence: 'Evidence',
          },
          ctx,
        ),
      ).rejects.toThrow(TRPCError)
    })
  })
})
