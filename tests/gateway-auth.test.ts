import { describe, expect, test } from "bun:test"
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai"
import { CodexAuth } from "~/gateway/codex-auth"
import { CodexProvider } from "~/gateway/codex"
import type { SecretStore } from "~/gateway/credentials"
import { createGateway } from "~/gateway/server"
import { prefixed, type ProviderAdapter, type ProviderID, type JSONRecord } from "~/gateway/types"

const credentials = (expires = Date.now() + 3600000): OAuthCredential => ({
  type: "oauth", access: "private-access", refresh: "private-refresh", expires, accountId: "test-account",
})
class MemorySecrets implements SecretStore {
  value: unknown
  writes = 0
  failWrite = false
  constructor(value?: unknown) { this.value = value }
  async read() { return this.value }
  async write(_key: string, value: unknown) {
    if (this.failWrite) throw new Error("test write failure")
    this.writes++; this.value = structuredClone(value)
  }
  async remove() { this.value = undefined }
}
const oauth = (overrides: Partial<OAuthAuth> = {}): OAuthAuth => ({
  name: "test", login: async () => credentials(),
  refresh: async () => credentials(), toAuth: async c => ({ apiKey: c.access }), ...overrides,
})

describe("independent Codex OAuth orchestration", () => {
  test("coalesces expired-token refresh and persists before returning", async () => {
    const store = new MemorySecrets(credentials(1))
    let refreshed = 0
    const auth = new CodexAuth(store, oauth({ refresh: async () => {
      refreshed++; await Bun.sleep(5); return credentials()
    } }))
    const values = await Promise.all([auth.credentials(), auth.credentials(), auth.credentials()])
    expect(refreshed).toBe(1); expect(store.writes).toBe(1)
    expect(values.every(v => v.access === "private-access")).toBe(true)
    expect(JSON.stringify(auth.snapshot())).not.toContain("private-")
  })
  test("refresh failure retains the prior credentials and returns no token", async () => {
    const old = credentials(1), store = new MemorySecrets(old)
    const auth = new CodexAuth(store, oauth({ refresh: async () => { throw new Error("private-secret-in-error") } }))
    await expect(auth.credentials()).rejects.toThrow("could not be refreshed")
    expect(store.value).toEqual(old); expect(store.writes).toBe(0)
    expect(JSON.stringify(auth.snapshot())).not.toContain("private-secret")
  })
  test("failed persistence cannot yield a newly rotated token", async () => {
    const store = new MemorySecrets(credentials(1)); store.failWrite = true
    const auth = new CodexAuth(store, oauth())
    await expect(auth.credentials()).rejects.toThrow("could not be refreshed")
  })
  test("logout waits for an in-flight refresh then removes the credential", async () => {
    const store = new MemorySecrets(credentials(1))
    const auth = new CodexAuth(store, oauth({ refresh: async () => { await Bun.sleep(5); return credentials() } }))
    const refresh = auth.credentials()
    await auth.logout(); await refresh
    expect(store.value).toBeUndefined()
    await expect(auth.credentials()).rejects.toThrow("Connect a Codex")
  })
  test("cancelled login cannot overwrite or resurrect an account", async () => {
    const store = new MemorySecrets()
    let resolve!: (value: OAuthCredential) => void
    const auth = new CodexAuth(store, oauth({ login: () => new Promise(r => { resolve = r }) }))
    auth.start(); auth.cancel(); resolve(credentials())
    await Bun.sleep(5)
    expect(store.value).toBeUndefined(); expect(store.writes).toBe(0)
  })
  test("a new login notifies the catalog without putting credentials in state", async () => {
    const store = new MemorySecrets()
    const auth = new CodexAuth(store, oauth())
    let changed = 0; auth.onChange = () => { changed++ }
    auth.start(); await Bun.sleep(5)
    expect(auth.snapshot().state).toBe("connected"); expect(changed).toBe(1)
    expect(JSON.stringify(auth.snapshot())).not.toContain("private-")
  })
})

function fakeProvider(id: ProviderID, calls: Array<{ provider: string; model: string }>): ProviderAdapter {
  const m = prefixed(id, { slug: "same-model", display_name: "Same model", context_window: id === "local" ? 32768 : 200000 })
  return {
    id, enabled: true, discover: async () => [m],
    snapshot: () => ({ id, enabled: true, state: "ready", stale: false, models: [] }),
    forward: async (_req, _body, model) => {
      calls.push({ provider: id, model: model.upstreamID })
      return Response.json({ model: model.upstreamID })
    },
  }
}
const token = "private-control-token-with-at-least-32-characters"
test("gateway merges disjoint source model IDs and never routes prefixed misses elsewhere", async () => {
  const calls: Array<{ provider: string; model: string }> = []
  const { app } = createGateway({ controlToken: token,
    providers: ["codex", "copilot", "local"].map(id => fakeProvider(id as ProviderID, calls)) })
  const catalog = await (await app.request("/v1/models?client_version=0.153.4")).json() as JSONRecord
  expect(catalog.models.map((m: JSONRecord) => m.slug)).toEqual(["codex/same-model", "copilot/same-model", "local/same-model"])
  for (const provider of ["codex", "copilot", "local"]) {
    const result = await app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${provider}/same-model`, input: "test" }) })
    expect(result.status).toBe(200)
  }
  expect(calls.map(c => c.provider)).toEqual(["codex", "copilot", "local"])
  const missing = await app.request("/v1/responses", { method: "POST", body: '{"model":"local/missing"}' })
  expect(missing.status).toBe(404); expect(calls).toHaveLength(3)
})
test("source-qualified selection takes precedence over task binding; background names stay in that source", async () => {
  const calls: Array<{ provider: string; model: string }> = []
  const { app } = createGateway({ controlToken: token,
    providers: ["codex", "copilot", "local"].map(id => fakeProvider(id as ProviderID, calls)) })
  const send = (model: string, session = "task") => app.request("/v1/responses", {
    method: "POST", headers: { "session_id": session }, body: JSON.stringify({ model, input: "x" }),
  })
  await send("codex/same-model"); await send("same-model"); await send("local/same-model"); await send("same-model")
  expect(calls.map(c => c.provider)).toEqual(["codex", "codex", "local", "local"])
  expect((await send("same-model", "unbound-task")).status).toBe(404)
  expect(calls).toHaveLength(4)
})
test("bare model IDs remain compatible in a Copilot-only catalog", async () => {
  const calls: Array<{ provider: string; model: string }> = []
  const { app } = createGateway({ controlToken: token, providers: [fakeProvider("copilot", calls)] })
  const response = await app.request("/v1/responses", { method: "POST", body: '{"model":"same-model","input":"test"}' })
  expect(response.status).toBe(200)
  expect(calls).toEqual([{ provider: "copilot", model: "same-model" }])
})
test("a forced refresh during discovery is not lost behind the in-flight catalog", async () => {
  const calls: Array<{ provider: string; model: string }> = []
  const provider = fakeProvider("local", calls)
  let entered!: () => void, release!: () => void, discoveries = 0
  const started = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  provider.discover = async () => {
    const attempt = ++discoveries
    if (attempt === 1) { entered(); await gate }
    return [prefixed("local", { slug: attempt === 1 ? "old" : "new", display_name: "model" })]
  }
  const gateway = createGateway({ controlToken: token, providers: [provider] })
  const first = gateway.refresh()
  await started
  const forced = gateway.refresh("0.153.4", true)
  release(); await first; await forced
  expect(discoveries).toBe(2)
  expect((await gateway.app.request("/v1/responses", { method: "POST", body: '{"model":"local/new"}' })).status).toBe(200)
})
test("browser-origin requests cannot spend a subscription through the gateway", async () => {
  const calls: Array<{ provider: string; model: string }> = []
  const { app } = createGateway({ controlToken: token, providers: [fakeProvider("copilot", calls)] })
  const response = await app.request("/v1/responses", { method: "POST", headers: { origin: "http://website.test" },
    body: '{"model":"copilot/same-model","input":"test"}' })
  expect(response.status).toBe(403); expect(calls).toHaveLength(0)
})
test("control API requires the private token and rejects browser origins", async () => {
  const { app } = createGateway({ controlToken: token, providers: [] })
  expect((await app.request("/bridge/status")).status).toBe(403)
  expect((await app.request("/bridge/status", { headers: { "x-codex-bridge-token": token } })).status).toBe(200)
  expect((await app.request("/bridge/status", { headers: { "x-codex-bridge-token": token, origin: "http://evil.test" } })).status).toBe(403)
  expect((await app.request("/bridge/refresh", { method: "POST", headers: { "x-codex-bridge-token": token } })).status).toBe(415)
})
test("native Codex keeps official metadata and opaque event content", async () => {
  const store = new MemorySecrets(credentials()), auth = new CodexAuth(store, oauth())
  const seen: RequestInit[] = []
  const stream = 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"r1","encrypted_content":"opaque","future":true}}\n\n'
  const provider = new CodexProvider(auth, true, async (url, init) => {
    seen.push(init!)
    return String(url).includes("/models?") ? Response.json({ models: [{
      slug: "native", display_name: "Native", visibility: "list", context_window: 100000,
      base_instructions: "Official instructions", model_messages: { instructions_template: "Official template" },
    }] }) : new Response(stream, { headers: { "content-type": "text/event-stream" } })
  })
  const [m] = await provider.discover("0.153.4")
  expect(m.catalog.base_instructions).toBe("Official instructions")
  expect(m.catalog.model_messages.instructions_template).toBe("Official template")
  const response = await provider.forward(new Request("http://bridge", { headers: { authorization: "Bearer wrong" } }),
    { model: m.id, input: [], future_request_field: { opaque: true } }, m)
  expect(await response.text()).toBe(stream)
  expect(new Headers(seen.at(-1)?.headers).get("authorization")).toBe("Bearer private-access")
  expect(JSON.parse(String(seen.at(-1)?.body))).toMatchObject({ model: "native", future_request_field: { opaque: true } })
})
