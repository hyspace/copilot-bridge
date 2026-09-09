import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync, zstdCompressSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { createServer } from "~/server"
import { rebuiltResponseHeaders } from "~/lib/response-headers"

const originalFetch = globalThis.fetch
const originalConfigPath = process.env.CODEX_CONFIG_PATH
let tempDir: string
let calls: Array<{ url: string; init?: RequestInit }>

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "bridge-http-test-"))
  process.env.CODEX_CONFIG_PATH = path.join(tempDir, "config.toml")
  await writeFile(process.env.CODEX_CONFIG_PATH, "")
  calls = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({ id: "response", output: [] })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalConfigPath === undefined) delete process.env.CODEX_CONFIG_PATH
  else process.env.CODEX_CONFIG_PATH = originalConfigPath
  await rm(tempDir, { recursive: true, force: true })
})

const app = () => createServer({
  host: "127.0.0.1", port: 0, accountType: "individual",
  copilotBaseUrl: "https://upstream.test", copilotToken: "fake-copilot-token",
  vsCodeVersion: "test",
})

describe("Responses HTTP protocol compatibility", () => {
  test.each([["gzip", gzipSync], ["zstd", zstdCompressSync]] as const)(
    "accepts %s from an authenticated client without forwarding client credentials or encoding",
    async (encoding, compress) => {
      const input = JSON.stringify({ model: "gpt-6-astra", input: "中文🙂", stream: false })
      const response = await app().request("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json", "content-encoding": encoding,
          authorization: "Bearer PRIVATE_OPENAI_TOKEN",
          "chatgpt-account-id": "private-account",
        },
        body: compress(Buffer.from(input)),
      })
      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      const headers = new Headers(calls[0].init?.headers)
      expect(headers.get("content-encoding")).toBeNull()
      expect(headers.get("content-length")).toBeNull()
      expect(headers.get("chatgpt-account-id")).toBeNull()
      expect(headers.get("authorization")).toBe("Bearer fake-copilot-token")
      expect(JSON.parse(calls[0].init?.body as string).input).toBe("中文🙂")
    },
  )

  test.each([
    ["garbage", "gzip", 400],
    ["{}", "unsupported", 415],
    ["{bad-json", undefined, 400],
    ["null", undefined, 400],
    ["[]", undefined, 400],
  ] as const)("returns a structured client error for %s (%s)", async (body, encoding, status) => {
    const response = await app().request("/v1/responses", {
      method: "POST",
      headers: encoding ? { "content-encoding": encoding } : {},
      body,
    })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } })
    expect(calls).toHaveLength(0)
  })

  test("clears stale entity and hop-by-hop headers after SSE ID normalization", async () => {
    const wire = [
      { type: "response.created", response: { id: "short" } },
      { type: "response.completed", response: { id: "much-longer-response-id", output: [] } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    globalThis.fetch = (async () => new Response(wire, {
      headers: {
        "content-type": "text/event-stream",
        "content-length": String(Buffer.byteLength(wire)),
        "content-encoding": "gzip", // fetch already decoded the bytes
        "transfer-encoding": "chunked",
        "connection": "keep-alive, x-private-hop",
        "x-private-hop": "remove",
        "etag": '"old"',
        "content-digest": "old-digest",
        "x-request-id": "preserve",
        "retry-after": "3",
      },
    })) as unknown as typeof fetch
    const response = await app().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hello", stream: true }),
    })
    const body = await response.text()
    expect(body).not.toContain("much-longer-response-id")
    for (const header of [
      "content-length", "content-encoding", "transfer-encoding", "connection",
      "x-private-hop", "etag", "content-digest",
    ]) expect(response.headers.get(header)).toBeNull()
    expect(response.headers.get("x-request-id")).toBe("preserve")
    expect(response.headers.get("retry-after")).toBe("3")
  })

  test("header rebuilding never mutates the upstream headers", () => {
    const upstream = new Headers({ "content-length": "20", "x-request-id": "request" })
    const result = rebuiltResponseHeaders(upstream)
    expect(result.get("content-length")).toBeNull()
    expect(upstream.get("content-length")).toBe("20")
    expect(result.get("x-request-id")).toBe("request")
  })
})
