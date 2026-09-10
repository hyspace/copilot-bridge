import { CodexAuth, accountFingerprint } from "./codex-auth"
import { fetchMetadata, forwardNative, observed, upstreamHeaders } from "./http"
import { GatewayError, prefixed, version, type Fetcher, type GatewayModel, type JSONRecord,
  type ProviderAdapter, type ProviderSnapshot } from "./types"

// Deliberately not configurable through a request body or discovery response.
const root = "https://chatgpt.com/backend-api/codex/"

export class CodexProvider implements ProviderAdapter {
  readonly id = "codex" as const
  private models: GatewayModel[] = []
  private at = 0
  private state: ProviderSnapshot["state"] = "disconnected"
  private message?: string
  private inFlight?: Promise<GatewayModel[]>
  readonly auth: CodexAuth
  readonly enabled: boolean
  private fetcher: Fetcher
  private epoch = 0
  constructor(auth: CodexAuth, enabled = true, fetcher: Fetcher = fetch) {
    this.auth = auth; this.enabled = enabled; this.fetcher = fetcher
  }
  async discover(clientVersion: string, force = false): Promise<GatewayModel[]> {
    if (!this.enabled) return []
    if (this.inFlight) return this.inFlight
    if (!force && Date.now() - this.at < 60_000) return this.models
    this.inFlight = this.refresh(clientVersion).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
  invalidate(): void { this.epoch++; this.at = 0; this.models = []; this.state = "disconnected" }
  private async refresh(clientVersion: string): Promise<GatewayModel[]> {
    const epoch = this.epoch
    try {
      const creds = await this.auth.credentials()
      const url = new URL("models", root); url.searchParams.set("client_version", version(clientVersion))
      const data = await fetchMetadata(this.fetcher, url, this.headers(creds, version(clientVersion)))
      if (epoch !== this.epoch) return []
      if (!Array.isArray(data.models)) throw new GatewayError(502, "invalid_catalog", "Codex did not return a model catalog.")
      this.models = data.models.slice(0, 1000).filter((m: JSONRecord) => typeof m?.slug === "string"
        && m.visibility === "list").map((entry: JSONRecord) => prefixed("codex", entry))
      this.state = "ready"; this.message = "Official model metadata; native Responses transport."
    } catch (error) {
      if (epoch !== this.epoch) return []
      this.state = error instanceof GatewayError && error.status === 401 ? "disconnected" : "offline"
      this.message = error instanceof GatewayError ? error.message : "Could not load the Codex model catalog."
      if (this.state === "disconnected") this.models = []
    }
    this.at = Date.now()
    return this.models
  }
  private headers(creds: { access: string; accountId?: unknown }, clientVersion = "0.153.4"): Headers {
    return new Headers({
      authorization: `Bearer ${creds.access}`, "chatgpt-account-id": String(creds.accountId),
      originator: "codex_cli_rs", version: clientVersion,
    })
  }
  snapshot(): ProviderSnapshot {
    return {
      id: this.id, enabled: this.enabled, state: this.enabled ? this.state : "disabled",
      message: this.message, stale: this.state === "offline", observedAt: this.at ? new Date(this.at).toISOString() : undefined,
      models: this.models.map(m => ({ id: m.id, name: m.catalog.display_name, contextWindow: m.contextWindow })),
    }
  }
  async forward(request: Request, payload: JSONRecord, model: GatewayModel, compact = false): Promise<Response> {
    if (!this.enabled) throw new GatewayError(503, "codex_disabled", "Codex subscription is disabled.")
    let creds = await this.auth.credentials()
    const originalAccount = accountFingerprint(creds)
    const send = () => forwardNative(this.fetcher, new URL(compact ? "responses/compact" : "responses", root), request,
      { ...payload, model: model.upstreamID },
      upstreamHeaders(request, { access: creds.access, accountID: String(creds.accountId) }, true))
    let response = await send()
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {})
      creds = await this.auth.credentials(true, creds.access)
      if (accountFingerprint(creds) !== originalAccount)
        throw new GatewayError(409, "codex_account_changed", "The Codex account changed during this request. It was not retried on another account.")
      response = await send()
    }
    return observed(response, this.id, model.id)
  }
  async quota(): Promise<JSONRecord> {
    const creds = await this.auth.credentials()
    const raw = await fetchMetadata(this.fetcher, new URL("https://chatgpt.com/backend-api/wham/usage"), this.headers(creds))
    const windows = (limit: JSONRecord | undefined) => [
      ["primary", limit?.primary_window], ["secondary", limit?.secondary_window],
    ].flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return []
      const v = value as JSONRecord
      if (typeof v.used_percent !== "number" || !Number.isFinite(v.used_percent)) return []
      return [{ id: key, usedPercent: Math.min(100, Math.max(0, v.used_percent)),
        durationSeconds: typeof v.limit_window_seconds === "number" ? v.limit_window_seconds : null,
        resetsAt: typeof v.reset_at === "number" ? v.reset_at : null }]
    })
    return {
      provider: this.id, observedAt: new Date().toISOString(), scope: "account",
      accountFingerprint: accountFingerprint(creds),
      plan: typeof raw.plan_type === "string" ? raw.plan_type : undefined,
      windows: windows(raw.rate_limit),
      credits: raw.credits ? {
        unlimited: raw.credits.unlimited === true,
        balance: typeof raw.credits.balance === "number" || typeof raw.credits.balance === "string" ? String(raw.credits.balance) : null,
      } : null,
    }
  }
}
