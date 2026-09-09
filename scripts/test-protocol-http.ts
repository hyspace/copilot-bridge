// Integration smoke test: two ephemeral loopback servers, no real account/upstream.
// Unlike app.request unit tests, this verifies fetch decompression and HTTP framing.
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { gzipSync, zstdCompressSync } from "node:zlib"

import { startServer } from "../src/server"

const tempDir = await mkdtemp(path.join(os.tmpdir(), "bridge-wire-test-"))
const previousConfig = process.env.CODEX_CONFIG_PATH
process.env.CODEX_CONFIG_PATH = path.join(tempDir, "config.toml")
await writeFile(process.env.CODEX_CONFIG_PATH, "")

const text = "中文🙂\uE200cite\uE202turn1view0\uE201"
const annotation = {
  type: "url_citation", url: "https://example.com", title: "来源",
  start_index: 0, end_index: 2,
}
const wire = [
  { type: "response.created", response: { id: "short" } },
  { type: "response.output_text.delta", delta: text },
  { type: "response.output_text.annotation.added", annotation },
  { type: "response.completed", response: {
    id: "much-longer-response-id", output: [{
      type: "message", content: [{ type: "output_text", text, annotations: [annotation] }],
    }],
  } },
].map((event) => `data:${JSON.stringify(event)}\r\n\r\n`).join("")

let requests = 0
let handlerError: unknown
const upstream = createHttpServer(async (request, response) => {
  try {
    requests++
    assert.equal(request.url, "/responses")
    assert.equal(request.headers.authorization, "Bearer fake-copilot-token")
    assert.equal(request.headers["chatgpt-account-id"], undefined)
    assert.equal(request.headers["content-encoding"], undefined)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).input, "你好")

    // Node/Bun fetch decompresses this while retaining upstream entity headers.
    const body = gzipSync(wire)
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": String(body.length),
      "x-request-id": "fixture-request",
    })
    response.end(body)
  } catch (error) {
    handlerError = error
    response.writeHead(500)
    response.end("Fixture assertion failed")
  }
})

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

let bridge: ReturnType<typeof startServer> | undefined
try {
  const upstreamPort = await listen(upstream)
  bridge = startServer({
    host: "127.0.0.1", port: 0, accountType: "individual",
    copilotBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    copilotToken: "fake-copilot-token", vsCodeVersion: "test",
  })
  if (!bridge.listening) {
    await new Promise<void>((resolve, reject) => {
      bridge!.once("listening", resolve)
      bridge!.once("error", reject)
    })
  }
  const port = (bridge.address() as AddressInfo).port
  for (const encoding of ["identity", "gzip", "zstd"] as const) {
    const json = Buffer.from(JSON.stringify({ model: "gpt-6-astra", input: "你好", stream: true }))
    const body = encoding === "gzip" ? gzipSync(json)
      : encoding === "zstd" ? zstdCompressSync(json) : json
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "content-encoding": encoding,
        authorization: "Bearer fake-openai-token",
        "chatgpt-account-id": "fake-account",
      },
      body, signal: AbortSignal.timeout(10000),
    })
    if (handlerError) throw handlerError
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-encoding"), null)
    assert.equal(response.headers.get("x-request-id"), "fixture-request")
    const output = await response.text()
    assert.ok(!output.includes("much-longer-response-id"))
    const length = response.headers.get("content-length")
    if (length) assert.equal(Number(length), Buffer.byteLength(output))
    const events = output.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
    assert.equal(events[1].delta, text)
    assert.deepEqual(events[2].annotation, annotation)
    assert.equal(events[3].response.id, "short")
    console.log(`PASS HTTP: ${encoding} request → gzip upstream SSE → normalized Unicode/citations`)
  }
  assert.equal(requests, 3)
} finally {
  if (bridge) await close(bridge as Server)
  await close(upstream)
  if (previousConfig === undefined) delete process.env.CODEX_CONFIG_PATH
  else process.env.CODEX_CONFIG_PATH = previousConfig
  await rm(tempDir, { recursive: true, force: true })
}
