/** One configured operator identity across token exchange and automation. */
export function configuredAgentId() {
  const id = process.env.AIPMS_AGENT_ID?.trim() || 'agent-operator'
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id))
    throw new Error('AIPMS_AGENT_ID contains invalid characters')
  return id
}
