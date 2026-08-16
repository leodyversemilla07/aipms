/* ── AIPMS Agent Runtime Configuration ──────────────────────────────────────
   eve framework config for the procurement agent.

   - agentName: Unique identifier for this agent instance
   - skills: Which skill bundles the agent loads (loaded lazily)
   - tokenProvider: How bearer tokens are generated (short-lived, per-run)
   - eventChannels: Domain events the agent subscribes to
   - sandbox: Optional sandbox handle for side effects
─────────────────────────────────────────────────────────────────────────────── */

export type AgentName = "sourcing" | "ops" | "audit" | "orchestrator";

export interface AgentConfig {
  agentName: AgentName;
  /** Human-readable label for UI / logs */
  label: string;
  /** Which skill bundles to load (lazy‑loaded via eve's module system) */
  skills: ReadonlyArray<keyof typeof import("./skills")>;
  /** Token provider: returns a fresh Bearer token for each run */
  tokenProvider: () => Promise<string>;
  /** Domain events the agent subscribes to (wakes the agent on new events) */
  eventChannels: ReadonlyArray<{ channel: string; filter?: string }>;
  /** Optional: sandbox handle for side effects (file I/O, email, etc.) */
  sandbox?: unknown;
}

/* ── Default token provider ────────────────────────────────────────────────
   Generates a short‑lived bearer token using AIPMS_SERVICE_TOKEN.
   The token is scoped by embedding the agentName and a run‑specific nonce.
───────────────────────────────────────────────────────────────────────────── */
export async function defaultTokenProvider(): Promise<string> {
  const nonce = Math.random().toString(36).slice(2, 12);
  const agentTag = `${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
  const payload = `${agentName}-${nonce}-${agentTag}`;
  const token = process.env.AIPMS_SERVICE_TOKEN;
  if (!token) throw new Error("AIPMS_SERVICE_TOKEN not configured");
  // In a real deployment you would sign this (JWT, etc.). For simplicity we
  // just prepend a Bearer prefix; the API middleware checks the exact value.
  return `Bearer ${payload}`;
}

/* ── Default event subscriptions ────────────────────────────────────────────
   Agents subscribe to these channels. When an event appears, the agent's
   run loop wakes and can call tools.
───────────────────────────────────────────────────────────────────────────── */
export const defaultEventChannels = [
  { channel: "invoice.received", filter: "status=new" },
  { channel: "requisition.approved", filter: "" },
  { channel: "po.issued", filter: "" },
];

/* ── Default agent configs ─────────────────────────────────────────────────
   One config per specialist phase. The orchestrator loads all three.
───────────────────────────────────────────────────────────────────────────── */
export const sourcingConfig: AgentConfig = {
  agentName: "sourcing",
  label: "Sourcing Agent",
  skills: ["sourcing"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [{ channel: "invoice.received", filter: "status=new" }],
};

export const opsConfig: AgentConfig = {
  agentName: "ops",
  label: "Ops Agent",
  skills: ["ops"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [{ channel: "requisition.approved" }, { channel: "po.issued" }],
};

export const auditConfig: AgentConfig = {
  agentName: "audit",
  label: "Audit Agent",
  skills: ["audit"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [{ channel: "invoice.received" }],
};

export const orchestratorConfig: AgentConfig = {
  agentName: "orchestrator",
  label: "Orchestrator Agent",
  skills: ["sourcing", "ops", "audit"],
  tokenProvider: defaultTokenProvider,
  eventChannels: defaultEventChannels,
};