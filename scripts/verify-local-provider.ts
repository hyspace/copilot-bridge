/**
 * Explicit, opt-in live verification. Synthetic prompts/images only; no workspace
 * tools are executed. Run against an already-loaded conversational model.
 *
 * bun run scripts/verify-local-provider.ts --base-url http://host:port/v1
 * Reports stay in .artifacts/ (gitignored). Never automatically loads a model.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { deflateSync } from "node:zlib"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import path from "node:path"
import { LocalProvider } from "~/gateway/local"
import { createGateway } from "~/gateway/server"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "base-url": { type: "string" },
    out: { type: "string", default: ".artifacts/local-verification.json" },
    only: { type: "string" },
    timeout: { type: "string", default: "180" },
    gateway: { type: "boolean", default: false },
    namespace: { type: "boolean", default: false },
  },
})
if (!values["base-url"]) throw new Error("--base-url is required; live tests are never implicit.")
const base = new URL(values["base-url"].replace(/\/+$/, "") + "/")
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
  throw new Error("Use an HTTP(S) base URL without credentials, query, or fragment.")
const timeout = Number(values.timeout) * 1000
if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 600_000) throw new Error("Invalid timeout.")
const only = new Set(values.only?.split(",") ?? [])
type ObjectValue = Record<string, any>
type Wire = { status: number; headers: Record<string, unknown>; body: string; firstByteMs: number; ms: number }

// node:http deliberately avoids inherited HTTP_PROXY settings for this explicit
// endpoint, and does not follow redirects to another host.
function wire(url: URL, body?: ObjectValue, abortAfterFirstChunk = false): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let firstByteMs = -1
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: encoded ? "POST" : "GET",
      headers: { accept: "application/json, text/event-stream", ...(encoded ? {
        "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)),
      } : {}) },
    }, res => {
      let text = "", bytes = 0, settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, firstByteMs, ms: Date.now() - start })
      }
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        if (firstByteMs < 0) firstByteMs = Date.now() - start
        bytes += Buffer.byteLength(chunk)
        if (bytes > 8 * 1024 * 1024) { req.destroy(new Error("Response exceeds verification limit")); return }
        text += chunk
        if (abortAfterFirstChunk) { done(); res.destroy(); req.destroy() }
      })
      res.on("end", done)
      res.on("error", err => { if (!settled) { clearTimeout(timer); reject(err) } })
    })
    const timer = setTimeout(() => req.destroy(new Error(`Timed out after ${timeout / 1000}s`)), timeout)
    req.on("error", err => { clearTimeout(timer); reject(err) })
    req.end(encoded)
  })
}
const get = async (suffix: string) => {
  const r = await wire(new URL(suffix, base))
  if (r.status !== 200) throw new Error(`Discovery returned HTTP ${r.status}`)
  return JSON.parse(r.body) as ObjectValue
}
function png(): string {
  const width = 320, height = 200
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 3 + 1) + 1 + x * 3
    rows[i] = x < width / 2 ? 255 : 0
    rows[i + 1] = 0
    rows[i + 2] = x < width / 2 ? 0 : 255
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const v of b) {
      c ^= v
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4), type = Buffer.from(name)
    length.writeUInt32BE(data.length)
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, checksum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return "data:image/png;base64," + Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function decode(r: Wire) {
  check(r.status === 200, `HTTP ${r.status}: ${r.body.slice(0, 500)}`)
  const events: ObjectValue[] = r.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n")
    .flatMap(frame => {
      const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")
      return data && data !== "[DONE]" ? [JSON.parse(data)] : []
    })
  if (!events.length) {
    const json = JSON.parse(r.body)
    return { response: json as ObjectValue, events, text: outputText(json) }
  }
  const final = events.find(e => e.type === "response.completed")?.response
  check(final, "No response.completed event")
  const identities = new Map<number, string>()
  for (const event of events) {
    if (!Number.isInteger(event.output_index)) continue
    const id = event.item?.id ?? event.item_id
    if (typeof id !== "string") continue
    const previous = identities.get(event.output_index)
    check(!previous || previous === id, `Output identity drift at index ${event.output_index}`)
    identities.set(event.output_index, id)
  }
  for (const [index, item] of (final.output ?? []).entries()) {
    const id = identities.get(index)
    check(!id || !item.id || id === item.id, `Final identity differs at index ${index}`)
  }
  check(Number.isSafeInteger(final.usage?.input_tokens) && Number.isSafeInteger(final.usage?.output_tokens),
    "Final token counters missing")
  return { response: final as ObjectValue, events, text: outputText(final) }
}
function outputText(response: ObjectValue): string {
  return (response.output ?? []).flatMap((item: ObjectValue) => item.type === "message"
    ? (item.content ?? []).filter((p: ObjectValue) => p.type === "output_text").map((p: ObjectValue) => p.text) : []).join("")
}
const catalog = await get("models")
const models = catalog.data?.filter((m: ObjectValue) => m.loaded === true && !m.task)
check(models?.length === 1, "Expected exactly one loaded conversational model. No model will be loaded automatically.")
const model = models[0]
const props = await get("props")
check(props.model_path === model.id || props.model_alias === model.id, "Model changed during discovery")
const fingerprint = createHash("sha256").update(JSON.stringify({
  id: model.id, context: model.context_length, quant: model.quant,
  build: props.build_info, modalities: props.modalities, template: props.chat_template_caps,
})).digest("hex")
const report: ObjectValue = {
  at: new Date().toISOString(), fingerprint, model, build: props.build_info,
  declared: { modalities: props.modalities, template: props.chat_template_caps },
  scope: "Synthetic API contracts only; not a live Codex App Computer Use acceptance test.",
  results: [],
  throughGateway: values.gateway, namespacedTools: values.namespace,
}
const gateway = values.gateway ? createGateway({
  controlToken: createHash("sha256").update(String(Math.random())).digest("hex"),
  providers: [new LocalProvider({ url: base.href })],
}) : undefined
const server = gateway ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: gateway.app.fetch }) : undefined
const inferenceBase = server ? new URL(`http://127.0.0.1:${server.port}/v1/`) : base
const inferenceModel = server ? `local/${model.id}` : model.id
const run = async (name: string, fn: () => Promise<unknown>) => {
  if (only.size && !only.has(name)) return
  const start = Date.now()
  console.log(`Testing ${name}…`)
  try {
    const detail = await fn()
    report.results.push({ name, passed: true, ms: Date.now() - start, detail })
    console.log(`PASS ${name}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    report.results.push({ name, passed: false, ms: Date.now() - start, detail })
    console.log(`FAIL ${name}: ${detail}`)
  }
  await mkdir(path.dirname(path.resolve(values.out!)), { recursive: true })
  await writeFile(values.out!, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
}
const call = async (extra: ObjectValue) => {
  let body = extra
  if (values.namespace && Array.isArray(extra.tools)) body = {
    ...extra, tools: [{ type: "namespace", name: "functions", tools: extra.tools }],
    ...(extra.tool_choice && typeof extra.tool_choice === "object"
      ? { tool_choice: { ...extra.tool_choice, namespace: "functions" } } : {}),
  }
  return decode(await wire(new URL("responses", inferenceBase), {
    model: inferenceModel, stream: true, store: false, temperature: 0,
    max_output_tokens: 512, reasoning: { effort: "none" }, ...body,
  }))
}
const image = { type: "input_image", image_url: png(), detail: "high" }
await run("stream", async () => {
  const r = await call({ input: "Reply with BRIDGE_OK and nothing else." })
  check(r.text.includes("BRIDGE_OK"), "Expected marker missing")
  return { text: r.text, events: r.events.length, usage: r.response.usage }
})
await run("tool-roundtrip", async () => {
  const tools = [{ type: "function", name: "echo_probe", description: "Get a test marker.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }]
  const input = [{ role: "user", content: "Call echo_probe with value bridge-check. Then reply only with the marker returned by the tool." }]
  const first = await call({ input, tools, tool_choice: { type: "function", name: "echo_probe" } })
  const fc = first.response.output.find((i: ObjectValue) => i.type === "function_call")
  check(fc?.name === "echo_probe" && fc.call_id, "No valid echo_probe call")
  check(JSON.parse(fc.arguments).value === "bridge-check", "Tool arguments incorrect")
  const result = await call({ input: [...input, ...first.response.output, {
    type: "function_call_output", call_id: fc.call_id, output: "TOOL_OK_731",
  }], tools, tool_choice: "none" })
  check(result.text.includes("TOOL_OK_731"), "Tool result did not survive continuation")
  return { text: result.text, usage: result.response.usage }
})
await run("vision", async () => {
  const r = await call({ input: [{ role: "user", content: [
    { type: "input_text", text: "This synthetic image has two solid halves. What color is the LEFT half? Reply with only its color name." }, image,
  ] }] })
  check(/\bred\b/i.test(r.text), `Expected red; got ${r.text.slice(0, 150)}`)
  return { text: r.text, usage: r.response.usage }
})
await run("tool-result-vision", async () => {
  const tools = [{ type: "function", name: "capture_test_screen", description: "Return a synthetic test screen.",
    parameters: { type: "object", properties: {}, additionalProperties: false } }]
  const input = [{ role: "user", content: "Call capture_test_screen. Then report which side of that image is BLUE. Reply only left or right." }]
  const first = await call({ input, tools, tool_choice: { type: "function", name: "capture_test_screen" } })
  const fc = first.response.output.find((i: ObjectValue) => i.type === "function_call")
  check(fc?.name === "capture_test_screen" && fc.call_id, "No screenshot tool call")
  const r = await call({ input: [...input, ...first.response.output, {
    type: "function_call_output", call_id: fc.call_id, output: [
      { type: "input_text", text: "Synthetic screen, 320 by 200 pixels:" }, image,
    ],
  }], tools, tool_choice: "none" })
  check(/\bright\b/i.test(r.text), `Expected right; got ${r.text.slice(0, 150)}`)
  return { text: r.text, usage: r.response.usage }
})
await run("apply-patch", async () => {
  const tools = [{ type: "custom", name: "apply_patch",
    description: "Submit a patch. For this test only, create probe.txt containing HELLO. Never execute a shell.",
    format: { type: "grammar", syntax: "lark", definition: 'start: "*** Begin Patch\\n" "*** Add File: probe.txt\\n" "+HELLO\\n" "*** End Patch\\n"' } }]
  const r = await call({ input: "Use apply_patch to add probe.txt containing HELLO. This is a protocol test; no tool will be executed.",
    tools, tool_choice: { type: "custom", name: "apply_patch" } })
  const tool = r.response.output.find((i: ObjectValue) => i.type === "custom_tool_call")
  check(tool?.name === "apply_patch" && tool.call_id, "No custom apply_patch call")
  check(typeof tool.input === "string" && tool.input.includes("*** Begin Patch") && tool.input.includes("+HELLO"),
    "Patch payload missing")
  return { type: tool.type, input: tool.input, usage: r.response.usage }
})
await run("cancel", async () => {
  const r = await wire(new URL("responses", inferenceBase), {
    model: inferenceModel, stream: true, store: false, max_output_tokens: 256,
    reasoning: { effort: "none" }, input: "List the integers from 1 to 100.",
  }, true)
  check(r.status === 200 && r.firstByteMs >= 0, "No stream to cancel")
  // This proves disconnect handling at our client, not server GPU cancellation.
  return { firstByteMs: r.firstByteMs, clientDisconnected: true, serverCancellationVerified: false }
})
console.log(`Report: ${values.out}`)
server?.stop(true)
if (report.results.some((r: ObjectValue) => !r.passed)) process.exitCode = 1
