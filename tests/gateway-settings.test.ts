import { expect, test } from "bun:test"
import { gatewaySettings, readLocalKey } from "~/gateway/settings"
import { normalizeEndpoint } from "~/gateway/http"
import type { SecretStore } from "~/gateway/credentials"
import { createGateway } from "~/gateway/server"
import { LocalProvider } from "~/gateway/local"

test("native settings accept only typed, non-secret fields and safe endpoints", () => {
  expect(gatewaySettings({})).toMatchObject({ localEnabled: false, codexEnabled: true, copilotEnabled: true })
  for (const value of [null, [], 1, { codexEnabled: "false" }, { localEnabled: 1 }, { localAPIKey: "secret" },
    { rateLimitSeconds: -1 }, { localEnabled: true }, { localURL: "http://user:pass@example.test" }]) {
    expect(() => gatewaySettings(value)).toThrow()
  }
})
test("stored local keys are bound to the normalized API endpoint, never a new host", async () => {
  const endpoint = normalizeEndpoint("http://local.test:8892/v1/responses")
  let value: unknown = { version: 1, endpoint: endpoint.href, value: "test-secret" }
  const store: SecretStore = { read: async () => value, write: async () => {}, remove: async () => {} }
  expect(await readLocalKey(store, endpoint)).toBe("test-secret")
  expect(await readLocalKey(store, normalizeEndpoint("http://other.test/v1"))).toBeUndefined()
  value = "old-unscoped-secret"
  expect(await readLocalKey(store, endpoint)).toBeUndefined()
})
test("the private key control endpoint stores endpoint identity but never returns the key", async () => {
  let saved: unknown
  const token = "test-control-token-at-least-32-characters"
  const store: SecretStore = { read: async () => saved, write: async (_k, v) => { saved = v }, remove: async () => { saved = undefined } }
  const { app } = createGateway({ providers: [], secrets: store, controlToken: token, localEndpoint: "http://local.test/v1/" })
  const response = await app.request("/bridge/local/key", { method: "POST",
    headers: { "content-type": "application/json", "x-codex-bridge-token": token },
    body: JSON.stringify({ value: "test-secret" }) })
  expect(saved).toEqual({ version: 1, endpoint: "http://local.test/v1/", value: "test-secret" })
  expect(await response.text()).not.toContain("test-secret")
})
test("missing required local key blocks only local discovery, without anonymous network work", async () => {
  let calls = 0
  const local = new LocalProvider({ url: "http://local.test/v1", requiresKey: true }, async () => { calls++; return Response.json({ data: [] }) })
  expect(await local.discover("v")).toEqual([])
  expect(calls).toBe(0)
  expect(local.snapshot().message).toContain("key is unavailable")
})
