const SENSITIVE_KEY =
  /(account|iban|routing|swift|bic|beneficiary|card|password|secret|token|credential)/i
const LABELED_PAYMENT_VALUE =
  /\b(iban|bank\s+account|account\s*(?:number|no\.?|#)|routing\s*(?:number|no\.?|#)|swift|bic|card\s*(?:number|no\.?|#))\b\s*[:#-]?\s*[A-Z0-9][A-Z0-9 -]{3,39}/gi
const CARD_NUMBER = /\b(?:\d[ -]*?){13,19}\b/g

export function redactIntakeText(value: string) {
  return value
    .replace(
      LABELED_PAYMENT_VALUE,
      (_match, label: string) => `${label}: [REDACTED]`,
    )
    .replace(CARD_NUMBER, '[REDACTED PAYMENT NUMBER]')
}

/**
 * Prompt-safe projection for agent inspection. It keeps procurement fields but
 * removes payment credentials and attachment bodies before content reaches a
 * model. Binary OCR remains an explicit deployment integration, never an
 * implicit prompt upload.
 */
export function projectIntakeValueForAgent(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactIntakeText(value)
  if (Array.isArray(value)) {
    return value.map((entry) => projectIntakeValueForAgent(entry))
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === 'contentBase64') {
        output[childKey] = '[BINARY CONTENT OMITTED]'
      } else {
        output[childKey] = projectIntakeValueForAgent(childValue, childKey)
      }
    }
    return output
  }
  return value
}
