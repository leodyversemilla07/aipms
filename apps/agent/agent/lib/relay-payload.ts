// Tool payloads cross the tRPC relay untyped; each tool narrows defensively
// in its own toModelOutput.
//
// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC relay boundary
export type RelayPayload = any
