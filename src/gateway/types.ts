export const providerIDs = ["codex", "copilot", "local"] as const
export type ProviderID = typeof providerIDs[number]
export type JSONRecord = Record<string, any>
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface GatewayModel {
  provider: ProviderID
  upstreamID: string
  id: string
  catalog: JSONRecord
  contextWindow?: number
  fingerprint?: string
  declared?: {
    vision: boolean | null
    tools: boolean | null
    parallelTools: boolean | null
    reasoning: boolean | null
    search: "native" | "adapter-required" | "unknown"
  }
}

export interface ProviderSnapshot {
  id: ProviderID
  enabled: boolean
  state: "ready" | "disconnected" | "offline" | "limited" | "disabled"
  message?: string
  observedAt?: string
  stale: boolean
  models: Array<{
    id: string; name: string; contextWindow?: number; fingerprint?: string
    declared?: GatewayModel["declared"]
  }>
}

export interface ProviderAdapter {
  readonly id: ProviderID
  readonly enabled: boolean
  discover(clientVersion: string, force?: boolean): Promise<GatewayModel[]>
  snapshot(): ProviderSnapshot
  forward(request: Request, payload: JSONRecord, model: GatewayModel, compact?: boolean): Promise<Response>
  quota?(): Promise<JSONRecord>
}

export class GatewayError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 503
  readonly code: string
  constructor(status: GatewayError["status"], code: string, message: string) {
    super(message); this.status = status; this.code = code
  }
}

export function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function version(value: string | undefined | null): string {
  return value && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][a-zA-Z0-9.-]{1,80})?$/.test(value)
    ? value : "0.153.4"
}

export function prefixed(provider: ProviderID, entry: JSONRecord): GatewayModel {
  if (typeof entry.slug !== "string" || !entry.slug || entry.slug.length > 512)
    throw new GatewayError(502, "invalid_catalog", "The upstream returned an invalid model ID.")
  const id = `${provider}/${entry.slug}`
  const label = provider === "codex" ? "Codex" : provider === "copilot" ? "Copilot" : "Local"
  return {
    provider, upstreamID: entry.slug, id,
    contextWindow: finitePositive(entry.context_window),
    catalog: {
      ...entry, slug: id,
      display_name: `${entry.display_name ?? entry.slug} · ${label}`,
      // Never merge opaque compaction identities across providers.
      ...(entry.comp_hash ? { comp_hash: `${provider}:${entry.comp_hash}` } : {}),
    },
  }
}
