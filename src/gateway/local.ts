import { createHash } from "node:crypto"
import { fetchMetadata, forwardNative, normalizeEndpoint, observed, upstreamHeaders } from "./http"
import { finitePositive, GatewayError, prefixed, type Fetcher, type GatewayModel,
  type JSONRecord, type ProviderAdapter, type ProviderSnapshot } from "./types"
import { prepareLocalTools } from "./tool-namespaces"
import { localHistory } from "./local-history"
import { localSearchResponse, studioSearch } from "./local-search"

const instructions = "You are a coding assistant inside Codex App. Use the supplied tools to inspect and edit the user's workspace. Respect the supplied instructions, permission boundaries and tool results. Do not claim to have used a tool or inspected an image when you have not. Verify changes before reporting completion."

export class LocalProvider implements ProviderAdapter {
  readonly id = "local" as const
  readonly enabled: boolean
  readonly endpoint?: URL
  private models: GatewayModel[] = []
  private state: ProviderSnapshot["state"] = "disconnected"
  private message?: string
  private at = 0
  private inFlight?: Promise<GatewayModel[]>
  private epoch = 0
  private requiresKey = false
  private searchMessage?: string

  private fetcher: Fetcher
  constructor(input: { enabled?: boolean; url?: string; apiKey?: string; requiresKey?: boolean }, fetcher: Fetcher = fetch) {
    this.fetcher = fetcher
    this.enabled = input.enabled !== false && Boolean(input.url?.trim())
    this.apiKey = input.apiKey
    this.requiresKey = input.requiresKey === true
    if (this.enabled) this.endpoint = normalizeEndpoint(input.url!)
  }
  private apiKey?: string
  setApiKey(value?: string): void {
    this.apiKey = value
    this.epoch++; this.models = []
    this.at = 0; this.state = "disconnected"
  }
  requireApiKey(required: boolean): void {
    this.requiresKey = required
  }
  async discover(_version: string, force = false): Promise<GatewayModel[]> {
    if (!this.enabled) return []
    if (this.inFlight) return this.inFlight
    if (!force && Date.now() - this.at < 30_000) return this.models
    this.inFlight = this.refresh().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }
  private async refresh(): Promise<GatewayModel[]> {
    const epoch = this.epoch
    if (this.requiresKey && !this.apiKey) {
      this.state = "disconnected"; this.message = "The local API key is unavailable or belongs to a different endpoint."
      this.at = Date.now(); this.models = []
      return []
    }
    try {
      const auth = this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined
      const data = await fetchMetadata(this.fetcher, new URL("models", this.endpoint), auth)
      if (!Array.isArray(data.data)) throw new GatewayError(502, "invalid_catalog", "The local API did not return a model list.")
      let props: JSONRecord = {}
      try { props = await fetchMetadata(this.fetcher, new URL("props", this.endpoint), auth) }
      catch { /* Optional. Do not probe a different host or guess an internal port. */ }
      const entries: GatewayModel[] = []
      let missingContext = 0
      for (const entry of data.data.slice(0, 512)) {
        if (!entry || entry.loaded !== true || typeof entry.id !== "string" || !entry.id || entry.id.length > 480) continue
        // A loaded ASR/image/etc. model must never become a Codex chat model.
        if (entry.task && !["text-generation", "chat", "conversational"].includes(entry.task)) continue
        const matches = props.model_path === entry.id || props.model_alias === entry.id
        const ctx = finitePositive(entry.context_length)
          ?? (matches ? finitePositive(props.default_generation_settings?.n_ctx) : undefined)
        if (!ctx) { missingContext++; continue }
        const caps = matches ? props.chat_template_caps ?? {} : {}
        const declared = {
          vision: matches && typeof props.modalities?.vision === "boolean" ? props.modalities.vision : null,
          tools: typeof caps.supports_tool_calls === "boolean" ? caps.supports_tool_calls : null,
          parallelTools: typeof caps.supports_parallel_tool_calls === "boolean" ? caps.supports_parallel_tool_calls : null,
          reasoning: typeof caps.supports_reasoning_effort === "boolean" ? caps.supports_reasoning_effort : null,
          search: "adapter-required" as const,
        }
        if (declared.tools === false) continue
        const fingerprint = createHash("sha256").update(JSON.stringify({
          id: entry.id, context: ctx, quant: entry.quant ?? null,
          build: props.build_info ?? null, declared,
        })).digest("hex")
        const model = prefixed("local", {
          slug: entry.id, display_name: entry.display_name ?? entry.id.split("/").at(-1),
          description: "Loaded in Unsloth Studio. Capabilities are server-declared. Native search uses a guarded adapter; Computer Use requires verification.",
          default_reasoning_level: "none",
          // A boolean does not tell us which effort strings the endpoint accepts.
          supported_reasoning_levels: [{ effort: "none", description: "No explicit reasoning effort" }],
          shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 2000,
          support_verbosity: false, default_reasoning_summary: "none", supports_reasoning_summary_parameter: false,
          supports_parallel_tool_calls: declared.parallelTools === true,
          apply_patch_tool_type: "freeform", tool_mode: "direct",
          truncation_policy: { mode: "tokens", limit: Math.min(10000, Math.floor(ctx / 8)) },
          experimental_supported_tools: [], input_modalities: declared.vision === true ? ["text", "image"] : ["text"],
          context_window: ctx, max_context_window: ctx, auto_compact_token_limit: Math.floor(ctx * 0.8),
          comp_hash: `local:${fingerprint}`, include_apps_usage_instructions: false,
          supports_search_tool: false, base_instructions: instructions,
        })
        model.fingerprint = fingerprint; model.declared = declared
        entries.push(model)
      }
      if (epoch !== this.epoch) return []
      if (this.models[0]?.fingerprint !== entries[0]?.fingerprint) this.searchMessage = undefined
      this.models = entries
      this.state = entries.length ? "ready" : missingContext ? "limited" : "disconnected"
      this.message = missingContext ? "Some loaded models have no reported runtime context window."
        : entries.length ? "Server-declared capabilities. No automatic model loading."
        : "No loaded conversational model with a known context window."
      this.at = Date.now()
    } catch (error) {
      if (epoch !== this.epoch) return []
      this.state = "offline"
      this.message = error instanceof GatewayError ? error.message : "Local discovery failed."
      // Keep last-known rows for status/history; requests fail closed while offline.
      this.at = Date.now()
    }
    return this.models
  }
  snapshot(): ProviderSnapshot {
    return {
      id: this.id, enabled: this.enabled, state: this.enabled ? this.state : "disabled",
      message: [this.message, this.searchMessage].filter(Boolean).join(" "),
      stale: this.state === "offline", observedAt: this.at ? new Date(this.at).toISOString() : undefined,
      models: this.models.map(m => ({
        id: m.id, name: m.catalog.display_name, contextWindow: m.contextWindow,
        fingerprint: m.fingerprint, declared: m.declared,
      })),
    }
  }
  async forward(request: Request, payload: JSONRecord, model: GatewayModel, compact = false): Promise<Response> {
    // Re-check residency immediately before sending a named model. The upstream
    // can auto-load named models; a stale picker must not intentionally trigger it.
    await this.discover("0.153.4", true)
    if (!this.enabled || this.state === "offline")
      throw new GatewayError(503, "local_unavailable", "Local service is unavailable. No cloud fallback was used.")
    const resident = this.models.find(m => m.id === model.id)
    if (!resident || resident.fingerprint !== model.fingerprint)
      throw new GatewayError(409, "local_model_changed", "The loaded model or runtime settings changed. Refresh the Codex model list before retrying.")
    if (compact) throw new GatewayError(422, "unsupported_capability", "This local endpoint does not implement remote compaction.")
    const tools = prepareLocalTools(localHistory(payload))
    assertLocalPayload(tools.payload, model, true)
    const response = await localSearchResponse(request, tools.payload, async (body, signal) => {
      const forwarded = new Request(request.url, { headers: request.headers, signal })
      return observed(await forwardNative(this.fetcher, new URL("responses", this.endpoint), forwarded,
        { ...body, model: model.upstreamID }, upstreamHeaders(request, { access: this.apiKey })), "local", model.id)
    }, async (query, definition, signal) => {
      try {
        const result = await studioSearch({ query, definition, signal, endpoint: this.endpoint!, model: model.upstreamID,
          apiKey: this.apiKey, fetcher: this.fetcher, observe: r => observed(r, "local", model.id) })
        this.searchMessage = "Native search returned executed tool results for this runtime."
        return result
      } catch (error) {
        this.searchMessage = "Native search is limited: no verified result for the requested mode. No cloud fallback."
        throw error
      }
    })
    return tools.restore(response)
  }
}

/** Never let Unsloth silently discard required hosted tools or opaque history. */
export function assertLocalPayload(payload: JSONRecord, model: GatewayModel, hostedSearch = false): void {
  if (["provider_id", "provider_type", "encrypted_api_key", "api_key", "base_url"].some(key => payload[key])
    || payload.enable_tools === true || payload.mcp_enabled === true || payload.bypass_permissions === true
    || payload.deep_research_armed === true)
    throw new GatewayError(422, "unsafe_local_extension",
      "Local inference cannot select another Studio provider or run server-side workstation tools.")
  if (payload.tools !== undefined && !Array.isArray(payload.tools))
    throw new GatewayError(400, "invalid_tools", "Tools must be an array.")
  for (const tool of payload.tools ?? []) {
    if (tool?.type === "function") continue
    if (hostedSearch && ["web_search", "web_search_preview"].includes(tool?.type)) continue
    if (tool?.type === "custom" && tool.name === "apply_patch" && tool.format?.syntax === "lark") continue
    throw new GatewayError(422, "unsupported_capability",
      `Local Responses cannot safely forward tool type "${String(tool?.type ?? "unknown").slice(0, 80)}". It was not silently removed.`)
  }
  const inspect = (value: any): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) { value.forEach(inspect); return }
    if (value.type === "input_image" || value.type === "image_url") {
      if (model.declared?.vision !== true)
        throw new GatewayError(422, "vision_unavailable", "This local model has not declared image support. The image was not discarded.")
      if (value.file_id)
        throw new GatewayError(422, "unsupported_attachment", "Local images require image_url data, not an OpenAI file_id.")
    }
    if (value.type === "input_file" || value.type === "compaction" || value.type === "context_compaction"
      || (typeof value.encrypted_content === "string" && value.encrypted_content.length > 0))
      throw new GatewayError(409, "incompatible_history",
        "This input contains a file or opaque history that the local endpoint cannot read. Compact with the previous provider or start a new task.")
    // Only inspect protocol content, not JSON text inside user prompts/tool arguments.
    for (const key of ["content", "output"]) if (Array.isArray(value[key])) {
      for (const part of value[key]) {
        if (!part || !["input_text", "output_text", "text", "input_image", "image_url"].includes(part.type))
          throw new GatewayError(422, "unsupported_attachment", "Local input contains an unsupported content part. It was not silently discarded.")
      }
      inspect(value[key])
    }
  }
  if (Array.isArray(payload.input)) inspect(payload.input)
}
