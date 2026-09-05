import { afterEach, describe, expect, it, vi } from "vitest"
import { operatorAuth } from "../agent/lib/channel-auth"

afterEach(() => vi.unstubAllEnvs())
const request = (authorization?: string) =>
  new Request("http://agent/eve/v1/session", {
    headers: authorization ? { authorization } : {},
  })

describe("inbound operator authentication", () => {
  it("fails closed when unconfigured", async () => {
    vi.stubEnv("AIPMS_AGENT_ACCESS_TOKEN", "")
    expect(await operatorAuth()(request("Bearer anything"))).toBeNull()
  })
  it.each([undefined, "Basic token", "Bearer wrong", "Bearer token extra"])(
    "rejects invalid authorization %s",
    async (header) => {
      vi.stubEnv("AIPMS_AGENT_ACCESS_TOKEN", "token")
      expect(await operatorAuth()(request(header))).toBeNull()
    }
  )
  it("accepts the configured token without reflecting it into session attributes", async () => {
    vi.stubEnv("AIPMS_AGENT_ACCESS_TOKEN", "test-secret")
    const auth = await operatorAuth()(request("Bearer test-secret"))
    expect(auth).toMatchObject({
      principalId: "aipms-agent-operator",
      authenticator: "aipms-operator-token",
    })
    expect(JSON.stringify(auth)).not.toContain("test-secret")
  })
  it("does not accept the outbound backend credential", async () => {
    vi.stubEnv("AIPMS_SERVICE_TOKEN", "backend-token")
    vi.stubEnv("AIPMS_AGENT_ACCESS_TOKEN", "inbound-token")
    expect(await operatorAuth()(request("Bearer backend-token"))).toBeNull()
  })
  it("reads rotated credentials at request time", async () => {
    const auth = operatorAuth()
    vi.stubEnv("AIPMS_AGENT_ACCESS_TOKEN", "old-token")
    expect(await auth(request("Bearer old-token"))).not.toBeNull()
    vi.stubEnv("AIPMS_AGENT_ACCESS_TOKEN", "new-token")
    expect(await auth(request("Bearer old-token"))).toBeNull()
    expect(await auth(request("Bearer new-token"))).not.toBeNull()
  })
})
