import { describe, expect, test } from "bun:test"
import { LocalProvider, assertLocalPayload } from "~/gateway/local"
import { normalizeEndpoint, upstreamHeaders, forwardNative } from "~/gateway/http"
import type { Fetcher, JSONRecord } from "~/gateway/types"

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { "content-type": "application/json" } })
const model = { id: "org/visual-model", loaded: true, context_length: 180736,
  native_context_length: 262144, max_context_length: 262144, quant: "Q4" }
const props = {
  model_path: model.id, default_generation_settings: { n_ctx: 180736 },
  modalities: { vision: true }, chat_template_caps: { supports_tool_calls: true, supports_parallel_tool_calls: true },
}
const fixture = (data: JSONRecord = { data: [model] }, properties: JSONRecord = props) => {
  let fail = false
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url: String(url), init })
    if (fail) throw new Error("unavailable")
    return String(url).endsWith("/models") ? json(data) : String(url).endsWith("/props") ? json(properties)
      : new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n',
        { headers: { "content-type": "text/event-stream" } })
  }
  return { fetcher, calls, offline: () => { fail = true } }
}

describe("loaded local model discovery", () => {
  test("keeps prefix paths and normalizes full Responses URLs", () => {
    expect(normalizeEndpoint("http://127.0.0.1:8892/v1/responses").href).toBe("http://127.0.0.1:8892/v1/")
    expect(normalizeEndpoint("https://example.test/proxy/v1/").href).toBe("https://example.test/proxy/v1/")
    expect(normalizeEndpoint("http://example.test").pathname).toBe("/v1/")
    for (const url of ["ftp://example.test", "http://u:p@example.test/v1", "http://example.test/v1?key=x", "http://example.test/v1#x"])
      expect(() => normalizeEndpoint(url)).toThrow()
  })
  test("does not publish unloaded, speech or window-unknown models", async () => {
    const f = fixture({ data: [model, { id: "other", loaded: false }, { id: "asr", loaded: true, task: "automatic-speech-recognition" },
      { id: "no-window", loaded: true, native_context_length: 999999 }] })
    const p = new LocalProvider({ url: "http://local.test/v1" }, f.fetcher)
    const found = await p.discover("0.153.4")
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: "local/org/visual-model", contextWindow: 180736 })
    expect(found[0].catalog).toMatchObject({
      context_window: 180736, max_context_window: 180736, auto_compact_token_limit: 144588,
      input_modalities: ["text", "image"], supports_parallel_tool_calls: true,
    })
    expect(p.snapshot().message).toContain("no reported runtime")
  })
  test("props context belongs only to the matching resident model", async () => {
    const f = fixture({ data: [{ id: "different", loaded: true }, { id: model.id, loaded: true }] })
    const p = new LocalProvider({ url: "http://local.test/v1" }, f.fetcher)
    expect((await p.discover("v")) .map(m => m.upstreamID)).toEqual([model.id])
  })
  test("coalesces discovery, changes fingerprints on runtime changes", async () => {
    const data = { data: [{ ...model }] }
    const f = fixture(data)
    const p = new LocalProvider({ url: "http://local.test/v1" }, f.fetcher)
    const [a, b] = await Promise.all([p.discover("v"), p.discover("v")])
    expect(a).toEqual(b); expect(f.calls).toHaveLength(2)
    const fingerprint = a[0].fingerprint
    data.data[0].context_length = 32768
    const refreshed = await p.discover("v", true)
    expect(refreshed[0].fingerprint).not.toBe(fingerprint)
    expect(refreshed[0].catalog.auto_compact_token_limit).toBe(26214)
  })
  test("failed refresh preserves last-known state but forwarding fails closed", async () => {
    const f = fixture(), p = new LocalProvider({ url: "http://local.test/v1" }, f.fetcher)
    const [m] = await p.discover("v")
    f.offline(); await p.discover("v", true)
    expect(p.snapshot()).toMatchObject({ state: "offline", stale: true })
    expect(p.snapshot().models).toHaveLength(1)
    await expect(p.forward(new Request("http://bridge/v1/responses"), { model: m.id, input: "x" }, m))
      .rejects.toThrow("No cloud fallback")
  })
  test("HTML 200 is not a model discovery success", async () => {
    const p = new LocalProvider({ url: "http://local.test/v1" }, async () => new Response("<html>app</html>"))
    expect(await p.discover("v")).toEqual([])
    expect(p.snapshot().state).toBe("offline")
  })
  test("uses only the local key and keeps stream bytes unchanged", async () => {
    const f = fixture(), p = new LocalProvider({ url: "http://local.test/v1", apiKey: "local-key" }, f.fetcher)
    const [m] = await p.discover("v")
    const r = await p.forward(new Request("http://bridge/v1/responses", {
      headers: { authorization: "Bearer official-token", "chatgpt-account-id": "wrong-account", cookie: "private" },
    }), { model: m.id, stream: true, input: "x", unknown_extension: { keep: true } }, m)
    const call = f.calls.at(-1)!
    const headers = new Headers(call.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer local-key")
    expect(headers.has("chatgpt-account-id")).toBe(false)
    expect(headers.has("cookie")).toBe(false)
    expect(JSON.parse(String(call.init?.body))).toMatchObject({ model: model.id, unknown_extension: { keep: true } })
    expect(await r.text()).toContain('"input_tokens":1')
  })
  test("never silently removes required hosted tools or unreadable history", async () => {
    const p = new LocalProvider({ url: "http://local.test/v1" }, fixture().fetcher)
    const [m] = await p.discover("v")
    expect(() => assertLocalPayload({ tools: [{ type: "web_search" }] }, m)).toThrow("not silently removed")
    expect(() => assertLocalPayload({ input: [{ type: "reasoning", encrypted_content: "opaque" }] }, m)).toThrow("opaque")
    expect(() => assertLocalPayload({ input: [{ type: "function_call_output", output: [
      { type: "input_image", file_id: "file-1" },
    ] }] }, m)).toThrow("file_id")
    expect(() => assertLocalPayload({ input: [{ type: "message", content: [{ type: "input_image", image_url: "data:x" }] }] },
      { ...m, declared: { ...m.declared!, vision: false } })).toThrow("not discarded")
  })
  test("a disabled endpoint does no network work", async () => {
    const f = fixture(), p = new LocalProvider({ enabled: false, url: "http://local.test/v1" }, f.fetcher)
    expect(await p.discover("v")).toEqual([])
    expect(p.snapshot().state).toBe("disabled"); expect(f.calls).toEqual([])
  })
})

test("official authentication is source-owned, not inherited from Codex App", () => {
  const h = upstreamHeaders(new Request("http://bridge", { headers: {
    authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account",
    cookie: "do-not-forward", "x-secret": "do-not-forward",
  } }), { access: "own-token", accountID: "own-account" }, true)
  expect(h.get("authorization")).toBe("Bearer own-token")
  expect(h.get("chatgpt-account-id")).toBe("own-account")
  expect(h.has("cookie")).toBe(false); expect(h.has("x-secret")).toBe(false)
})

test("native transport refuses redirects rather than exposing a Location to the client", async () => {
  await expect(forwardNative(async () => new Response(null, { status: 307, headers: { location: "https://other.test" } }),
    new URL("https://provider.test/responses"), new Request("http://bridge"), {}, new Headers()))
    .rejects.toThrow("not followed")
})
