import { createServer } from "~/server"
import type { BridgeConfig } from "~/lib/config"
import { GatewayError, prefixed, type GatewayModel, type JSONRecord,
  type ProviderAdapter, type ProviderSnapshot } from "./types"
import { boundedJSON } from "./http"

/** Delegation, not a rewrite: existing Copilot request/stream/search adapters stay intact. */
export class CopilotProvider implements ProviderAdapter {
  readonly id = "copilot" as const
  private legacy: ReturnType<typeof createServer>
  private models: GatewayModel[] = []
  private state: ProviderSnapshot["state"] = "disconnected"
  private at = 0
  private inFlight?: Promise<GatewayModel[]>
  private config: BridgeConfig
  readonly enabled: boolean
  constructor(config: BridgeConfig, enabled = true) {
    this.config = config; this.enabled = enabled; this.legacy = createServer(config)
  }
  async discover(clientVersion: string, force = false): Promise<GatewayModel[]> {
    if (!this.enabled) return []
    if (this.inFlight) return this.inFlight
    if (!force && Date.now() - this.at < 60_000) return this.models
    this.inFlight = this.refresh(clientVersion).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
  private async refresh(clientVersion: string): Promise<GatewayModel[]> {
    if (!this.config.copilotToken) { this.state = "disconnected"; this.at = Date.now(); return [] }
    try {
      const response = await this.legacy.request(`/v1/models?client_version=${encodeURIComponent(clientVersion)}`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error("Catalog failed")
      const data = await boundedJSON(response) as JSONRecord
      this.models = (data.models ?? []).map((entry: JSONRecord) => prefixed("copilot", entry))
      this.state = "ready"
    } catch { this.state = "offline" }
    this.at = Date.now()
    return this.models
  }
  snapshot(): ProviderSnapshot {
    return {
      id: this.id, enabled: this.enabled, state: this.enabled ? this.state : "disabled", stale: this.state === "offline",
      message: this.state === "disconnected" ? "No usable Copilot connection. Authorize GitHub in Settings."
        : "Uses the existing Copilot compatibility pipeline.",
      observedAt: this.at ? new Date(this.at).toISOString() : undefined,
      models: this.models.map(m => ({ id: m.id, name: m.catalog.display_name, contextWindow: m.contextWindow })),
    }
  }
  async forward(request: Request, payload: JSONRecord, model: GatewayModel, compact = false): Promise<Response> {
    if (!this.enabled || !this.config.copilotToken)
      throw new GatewayError(503, "copilot_unavailable", "Copilot is not connected. No other provider was used.")
    if (compact) throw new GatewayError(422, "unsupported_capability", "The Copilot adapter does not implement remote compaction.")
    return this.legacy.fetch(new Request("http://bridge.internal/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json" },
      body: JSON.stringify({ ...payload, model: model.upstreamID }), signal: request.signal,
    }))
  }
  async quota(): Promise<JSONRecord> {
    if (!this.enabled || !this.config.copilotToken)
      throw new GatewayError(401, "copilot_unavailable", "Copilot is not connected.")
    const response = await this.legacy.request("/usage")
    if (!response.ok) throw new GatewayError(502, "quota_unavailable", "GitHub quota is unavailable.")
    return await response.json() as JSONRecord
  }
}
