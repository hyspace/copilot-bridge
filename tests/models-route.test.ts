import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { toCodexModelCatalog } from "~/bridges/codex/models"
import type { BridgeEnv } from "~/lib/config"
import { modelRoutes } from "~/routes/models"

const originalFetch = globalThis.fetch
const capturedUrls: Array<string> = []

afterEach(() => {
  globalThis.fetch = originalFetch
  capturedUrls.length = 0
})

const buildApp = (response: Response) => {
  const app = new Hono<BridgeEnv>()
  app.use("*", async (c, next) => {
    c.set("config", {
      host: "127.0.0.1",
      port: 4142,
      accountType: "individual",
      copilotBaseUrl: "https://upstream.test",
      copilotToken: "test-token",
      vsCodeVersion: "1.0.0",
    })
    await next()
  })
  app.route("/v1/models", modelRoutes)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      capturedUrls.push(input instanceof Request ? input.url : input.toString())
      return response.clone()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  return app
}

const gpt6 = {
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  object: "model",
  model_picker_enabled: true,
  policy: { state: "enabled", terms: "" },
  capabilities: {
    type: "chat",
    family: "gpt-6-astra",
    tokenizer: "o200k_base",
    object: "model_capabilities",
    limits: {
      max_context_window_tokens: 1000000,
      max_prompt_tokens: 872000,
      max_output_tokens: 128000,
    },
    supports: {
      tool_calls: true,
      parallel_tool_calls: true,
      vision: true,
      reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
    },
  },
  supported_endpoints: ["/responses", "ws:/responses"],
}

describe("model catalog routes", () => {
  test("preserves the raw OpenAI-compatible catalog for ordinary requests", async () => {
    const payload = { object: "list", data: [gpt6] }
    const app = buildApp(Response.json(payload, { headers: { "x-upstream": "yes" } }))
    const response = await app.request("/v1/models")

    expect(await response.json()).toEqual(payload)
    expect(response.headers.get("x-upstream")).toBe("yes")
    expect(capturedUrls).toEqual(["https://upstream.test/models"])
  })

  test("translates versioned Codex requests instead of returning data-only JSON", async () => {
    const app = buildApp(Response.json({ object: "list", data: [gpt6] }))
    const response = await app.request("/v1/models?client_version=0.153.3")
    const payload = await response.json() as ReturnType<typeof toCodexModelCatalog>

    expect(response.status).toBe(200)
    expect(payload.models).toBeArray()
    expect(payload.models).toHaveLength(1)
    expect(payload.models[0]).toMatchObject({
      slug: "gpt-6-astra",
      display_name: "GPT-6 Astra",
      visibility: "list",
      supported_in_api: true,
      shell_type: "unified_exec",
      apply_patch_tool_type: "freeform",
      tool_mode: "direct",
      support_verbosity: false,
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [],
      context_window: 1000000,
      auto_compact_token_limit: 784800,
      input_modalities: ["text", "image"],
    })
    expect(payload.models[0].base_instructions).toBeString()
    expect(payload.models[0].base_instructions.length).toBeGreaterThan(0)
    expect(payload.models[0].supported_reasoning_levels.map(
      (level: { effort: string }) => level.effort,
    )).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(capturedUrls).toEqual([
      "https://upstream.test/models?client_version=0.153.3",
    ])
  })

  test("preserves upstream errors and retry headers for Codex requests", async () => {
    const error = { error: { message: "Rate limited" } }
    const app = buildApp(Response.json(error, {
      status: 429,
      headers: { "retry-after": "30" },
    }))
    const response = await app.request("/v1/models?client_version=0.153.3")

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("30")
    expect(await response.json()).toEqual(error)
  })

  test("only advertises enabled, selectable models that the Responses bridge can route", async () => {
    const app = buildApp(Response.json({
      data: [
        gpt6,
        { ...gpt6, id: "disabled", policy: { state: "disabled" } },
        { ...gpt6, id: "internal", model_picker_enabled: false },
        {
          ...gpt6,
          id: "embedding",
          capabilities: { ...gpt6.capabilities, type: "embeddings" },
        },
        {
          ...gpt6,
          id: "no-tools",
          capabilities: { ...gpt6.capabilities, supports: { tool_calls: false } },
        },
        { ...gpt6, id: "unknown-chat-only", supported_endpoints: ["/chat/completions"] },
        {
          ...gpt6,
          id: "claude-opus-4.8",
          name: "Claude Opus 4.8",
          supported_endpoints: ["/chat/completions"],
        },
        { ...gpt6, id: "future-responses-model", name: "Future Responses Model" },
      ],
    }))
    const response = await app.request("/v1/models?client_version=0.153.3")
    const payload = await response.json() as ReturnType<typeof toCodexModelCatalog>

    expect(payload.models.map((model: { slug: string }) => model.slug)).toEqual([
      "gpt-6-astra",
      "claude-opus-4.8",
      "future-responses-model",
    ])
    expect(payload.models[1].apply_patch_tool_type).toBeUndefined()
  })

  test("does not reuse upstream content headers after translating the body", async () => {
    const app = buildApp(Response.json({ data: [gpt6] }, {
      headers: { "content-length": "12345", "etag": "\"copilot-catalog\"" },
    }))
    const response = await app.request("/v1/models?client_version=0.153.3")

    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("etag")).toBeNull()
  })

  test("only offers reasoning levels that the bridge will forward", async () => {
    const app = buildApp(Response.json({
      data: [
        { ...gpt6, id: "gpt-5.4" },
        {
          ...gpt6,
          id: "claude-haiku-4.5",
          supported_endpoints: ["/chat/completions"],
        },
      ],
    }))
    const response = await app.request("/v1/models?other=value&client_version=0.154.0")
    const payload = await response.json() as ReturnType<typeof toCodexModelCatalog>

    expect(payload.models[0].supported_reasoning_levels.map(
      (level: { effort: string }) => level.effort,
    )).toEqual(["low", "medium", "high", "xhigh"])
    expect(payload.models[0].default_reasoning_level).toBe("medium")
    expect(payload.models[1].supported_reasoning_levels).toEqual([])
    expect(payload.models[1].default_reasoning_level).toBeUndefined()
    expect(capturedUrls[0]).toBe(
      "https://upstream.test/models?other=value&client_version=0.154.0",
    )
  })

  test("returns an empty Codex catalog when no models are available", async () => {
    const app = buildApp(Response.json({ data: [] }))
    const response = await app.request("/v1/models?client_version=0.153.3")

    expect(await response.json()).toEqual({ models: [] })
  })
})
