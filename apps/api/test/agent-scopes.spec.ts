import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  agentMayInvoke,
  assertAgentCapability,
  DEFAULT_AGENT_SCOPES,
  resolveAgentScopes,
} from '../src/trpc/agent-capabilities'

/**
 * §7.2 capability model — agents are governed by explicit scopes with
 * default-deny; money movement, bank verification, identity and policy
 * authoring are unreachable for the agent principal.
 */

describe('Agent capability model', () => {
  describe('resolveAgentScopes', () => {
    it('defaults to the operator workflow grant set', () => {
      expect(resolveAgentScopes({} as NodeJS.ProcessEnv)).toEqual(
        DEFAULT_AGENT_SCOPES,
      )
    })

    it('an explicit env value replaces defaults entirely', () => {
      const scopes = resolveAgentScopes({
        AIPMS_AGENT_SCOPES: 'catalog.read, audit.read',
      } as NodeJS.ProcessEnv)
      expect(scopes).toEqual(['catalog.read', 'audit.read'])
    })

    it('an empty explicit value grants nothing', () => {
      expect(
        resolveAgentScopes({ AIPMS_AGENT_SCOPES: '' } as NodeJS.ProcessEnv),
      ).toEqual([])
    })
  })

  describe('default-deny surface', () => {
    it('denies procedures that carry no capability', () => {
      const all = DEFAULT_AGENT_SCOPES
      for (const path of [
        'paymentRun.create',
        'paymentRun.approve',
        'paymentRun.execute',
        'paymentRun.reconcile',
        'paymentRun.voidRun',
        'vendor.verifyBankAccount',
        'vendor.delete' as string, // unknown paths too
        'policy.create',
        'budget.create',
        'users.list',
        'sso.registerProvider',
        'sso.generateScimToken',
        'approval.decide',
        'purchaseOrder.sign',
        'nonsense.router.procedure',
      ]) {
        expect(agentMayInvoke(path, all), path).toBe(false)
      }
    })

    it('grants the operator workflow', () => {
      const all = DEFAULT_AGENT_SCOPES
      for (const path of [
        'intake.list',
        'intake.ingest',
        'intake.classify',
        'intake.registerInvoice',
        'invoice.compute',
        'requisition.create',
        'requisition.submit',
        'purchaseOrder.issue',
        'purchaseOrder.confirm',
        'events.poll',
        'audit.list',
        'users.me',
      ]) {
        expect(agentMayInvoke(path, all), path).toBe(true)
      }
    })

    it('a narrowed grant set loses access immediately', () => {
      expect(agentMayInvoke('purchaseOrder.issue', ['catalog.read'])).toBe(
        false,
      )
      expect(agentMayInvoke('purchaseOrder.issue', ['po.issue'])).toBe(true)
    })
  })

  describe('assertAgentCapability refusals are readable (§7.4)', () => {
    it('names the missing scope', () => {
      try {
        assertAgentCapability('purchaseOrder.issue', ['catalog.read'])
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(TRPCError)
        expect((e as TRPCError).code).toBe('FORBIDDEN')
        expect((e as TRPCError).message).toContain('"po.issue"')
      }
    })

    it('explains human-reserved surfaces', () => {
      try {
        assertAgentCapability('purchaseOrder.sign', DEFAULT_AGENT_SCOPES)
        expect.unreachable()
      } catch (e) {
        expect((e as TRPCError).message).toContain('reserved for humans')
      }
    })
  })

  describe('map integrity', () => {
    it('every capability referenced by a procedure is a plain token', () => {
      for (const [path, scope] of Object.entries(AGENT_CAPABILITIES)) {
        expect(path, path).toMatch(/^[a-zA-Z]+\.[a-zA-Z]+$/)
        expect(scope, path).toMatch(/^[a-z.]+$/)
      }
    })

    it('defaults only grant scopes that some procedure accepts', () => {
      const grantable = new Set(Object.values(AGENT_CAPABILITIES))
      for (const scope of DEFAULT_AGENT_SCOPES) {
        expect(grantable.has(scope), scope).toBe(true)
      }
    })
  })
})
