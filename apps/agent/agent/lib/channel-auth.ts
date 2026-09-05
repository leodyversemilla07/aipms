import { timingSafeEqual } from "node:crypto"
import type { AuthFn } from "eve/channels/auth"

/** Inbound operator access only. Never reuse the outbound backend token. */
export function operatorAuth(): AuthFn<Request> {
  return (request) => {
    // Resolve at request time, not build time. Rotation takes effect at runtime.
    const expected = process.env.AIPMS_AGENT_ACCESS_TOKEN
    if (!expected) return null
    const header = request.headers.get("authorization")
    const match = /^Bearer ([^\s]+)$/i.exec(header ?? "")
    if (!match) return null
    const actualBytes = Buffer.from(match[1] ?? "", "utf8")
    const expectedBytes = Buffer.from(expected, "utf8")
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    )
      return null
    return {
      attributes: {},
      authenticator: "aipms-operator-token",
      principalId: "aipms-agent-operator",
      principalType: "user",
    }
  }
}
