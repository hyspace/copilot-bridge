import { createHash, timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { readJsonRequest, RequestBodyError } from "~/lib/request-body"
import { GatewayError, providerIDs, version, type GatewayModel, type JSONRecord,
  type ProviderAdapter, type ProviderID } from "./types"
import type { CodexAuth } from "./codex-auth"
import type { SecretStore } from "./credentials"

interface Options {
  providers: ProviderAdapter[]
  controlToken: string
  instance?: string
  auth?: CodexAuth
  onAuthChange?: () => void
  secrets?: SecretStore
  localEndpoint?: string
  onLocalKeyChange?: (value?: string) => void
}

export function createGateway(options: Options) {
  const app = new Hono()
  const providers = new Map(options.providers.map(p => [p.id, p]))
  let models = new Map<string, GatewayModel>()
  let refreshing: Promise<void> | undefined
  let refreshAgain = false
  const sessions = new Map<string, { provider: ProviderID; at: number }>()
  let lastRefresh = 0
  const refresh = async (clientVersion = "0.153.4", force = false) => {
    if (refreshing) {
      if (force) refreshAgain = true
      return refreshing
    }
    if (!force && Date.now() - lastRefresh < 30_000) return
    refreshing = (async () => {
      do {
        refreshAgain = false
        const lists = await Promise.all(options.providers.map(p => p.discover(clientVersion, force).catch(() => [])))
        models = new Map(lists.flat().map(m => [m.id, m]))
        lastRefresh = Date.now()
        force = true
      } while (refreshAgain)
    })().finally(() => { refreshing = undefined })
    return refreshing
  }
  const authorized = (request: Request): boolean => {
    const input = request.headers.get("x-codex-bridge-token") ?? ""
    return !request.headers.has("origin") && options.controlToken.length >= 32
      && Buffer.byteLength(input) === Buffer.byteLength(options.controlToken)
      && timingSafeEqual(Buffer.from(input), Buffer.from(options.controlToken))
  }
  app.onError((error, c) => {
    if (error instanceof GatewayError || error instanceof RequestBodyError) {
      return c.json({ error: { type: "bridge_error", code: error instanceof GatewayError ? error.code : "invalid_request",
        message: error.message } }, error.status as 400)
    }
    // Never serialize exception messages containing upstream data or credential details.
    return c.json({ error: { type: "bridge_error", code: "internal_error", message: "The request could not be completed safely." } }, 502)
  })
  app.get("/healthz", c => c.json({ ok: true, ...(options.instance ? { instance: options.instance } : {}) }))
  app.get("/", c => c.json({ name: "Codex Bridge", status: "ok" }))
  app.use("/v1/*", async (c, next) => {
    // LAN clients remain keyless, but arbitrary browser pages must not spend
    // the user's subscriptions through a loopback cross-origin request.
    if (c.req.header("origin")) return c.json({ error: { message: "Browser-origin requests are not allowed." } }, 403)
    await next()
  })
  app.use("/bridge/*", async (c, next) => {
    if (!authorized(c.req.raw)) return c.json({ error: { message: "Private control access required." } }, 403)
    if (c.req.method !== "GET" && !c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: { message: "JSON control request required." } }, 415)
    await next()
  })
  app.get("/bridge/status", c => c.json({
    providers: options.providers.map(p => p.snapshot()), codexLogin: options.auth?.snapshot(),
    refreshing: Boolean(refreshing),
  }))
  app.post("/bridge/refresh", c => { void refresh("0.153.4", true); return c.json({ accepted: true }, 202) })
  app.post("/bridge/local/key", async c => {
    if (!options.secrets) throw new GatewayError(503, "credential_store_unavailable", "Keychain storage is unavailable.")
    const body = await readJsonRequest(c.req.raw, 65536) as JSONRecord
    if (typeof body.value !== "string" || body.value.length > 32768 || /[\r\n]/.test(body.value))
      throw new GatewayError(400, "invalid_key", "Invalid local API key.")
    if (body.value && !options.localEndpoint)
      throw new GatewayError(409, "local_not_configured", "Configure and enable the local endpoint, then restart this service before saving its key.")
    if (body.value) await options.secrets.write("local", { version: 1, endpoint: options.localEndpoint, value: body.value })
    else await options.secrets.remove("local")
    options.onLocalKeyChange?.(body.value || undefined)
    void refresh("0.153.4", true)
    return c.json({ accepted: true, keyConfigured: Boolean(body.value) })
  })
  app.get("/bridge/quota/:provider", async c => {
    const provider = providers.get(c.req.param("provider") as ProviderID)
    if (!provider?.quota) throw new GatewayError(404, "no_quota", "This source does not have an account quota.")
    return c.json(await provider.quota())
  })
  app.post("/bridge/auth/codex/:action", async c => {
    if (!options.auth) throw new GatewayError(503, "auth_unavailable", "Codex sign-in is unavailable.")
    const action = c.req.param("action")
    if (action === "start") {
      const body = await readJsonRequest(c.req.raw, 16384) as JSONRecord
      options.auth.start(body.method === "device" ? "device" : "browser")
    } else if (action === "cancel") options.auth.cancel()
    else if (action === "logout") await options.auth.logout()
    else if (action === "respond") {
      const body = await readJsonRequest(c.req.raw, 16384) as JSONRecord
      if (typeof body.value !== "string") throw new GatewayError(400, "invalid_callback", "Missing authorization callback.")
      options.auth.respond(body.value)
    } else throw new GatewayError(404, "unknown_action", "Unknown sign-in action.")
    options.onAuthChange?.()
    return c.json({ accepted: true })
  })
  app.get("/v1/models", async c => {
    await refresh(version(c.req.query("client_version")), true)
    const entries = [...models.values()]
    const tag = `"${createHash("sha256").update(JSON.stringify(entries.map(m => m.catalog))).digest("hex")}"`
    c.header("etag", tag); c.header("cache-control", "no-cache")
    if (c.req.query("client_version") !== undefined) return c.json({ models: entries.map(m => m.catalog) })
    return c.json({ object: "list", data: entries.map(m => ({
      id: m.id, object: "model", owned_by: m.provider, context_length: m.contextWindow,
    })) })
  })
  const route = async (request: Request, compact: boolean): Promise<Response> => {
    const parsed = await readJsonRequest(request)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new GatewayError(400, "invalid_request", "A JSON object is required.")
    const body = parsed as JSONRecord
    if (typeof body.model !== "string" || !body.model || body.model.length > 512
      || (body.tools !== undefined && !Array.isArray(body.tools)))
      throw new GatewayError(400, "invalid_request", "A valid model and tools array are required.")
    await refresh(version(request.headers.get("version")))
    let model = models.get(body.model)
    const identity = request.headers.get("thread-id") ?? request.headers.get("session_id")
    const parent = request.headers.get("x-codex-parent-thread-id")
    const session = identity && identity.length <= 256 ? identity : undefined
    const binding = sessions.get(session ?? "") ?? sessions.get(parent ?? "")
    if (!model) {
      if (providerIDs.some(id => body.model.startsWith(id + "/")))
        throw new GatewayError(404, "model_unavailable", "This source model is no longer available. Refresh the model list.")
      // An unbound background request is NOT permission to spend Copilot credits
      // when multiple sources exist. Bare legacy names work only in a genuinely
      // Copilot-only catalog; otherwise the task must establish its source.
      const onlyCopilot = [...models.values()].every(entry => entry.provider === "copilot")
      const provider = binding?.provider ?? (onlyCopilot ? "copilot" : undefined)
      if (provider) model = models.get(`${provider}/${body.model}`)
    }
    if (!model) throw new GatewayError(404, "model_unavailable", "No unambiguous route exists for this model. Choose a source-qualified model.")
    const provider = providers.get(model.provider)
    if (!provider?.enabled) throw new GatewayError(503, "provider_disabled", "The selected source is disabled.")
    if (session && !compact) {
      sessions.set(session, { provider: model.provider, at: Date.now() })
      for (const [id, value] of sessions) if (Date.now() - value.at > 12 * 3600_000) sessions.delete(id)
      while (sessions.size > 10000) sessions.delete(sessions.keys().next().value!)
    }
    return provider.forward(request, body, model, compact)
  }
  app.post("/v1/responses", c => route(c.req.raw, false))
  app.post("/v1/responses/compact", c => route(c.req.raw, true))
  // Old quota consumers remain supported; new UI uses private source-scoped reads.
  app.get("/usage", async c => {
    const quota = providers.get("copilot")?.quota
    if (!quota) throw new GatewayError(404, "no_quota", "Copilot quota is unavailable.")
    return c.json(await providers.get("copilot")!.quota!())
  })
  return { app, refresh }
}
