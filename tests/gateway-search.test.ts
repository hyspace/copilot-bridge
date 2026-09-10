import { describe, expect, test } from "bun:test"
import { localSearchResponse, studioSearch } from "~/gateway/local-search"
import { localHistory } from "~/gateway/local-history"
import { upstreamEvents } from "~/gateway/sse"
import { GatewayError, type JSONRecord, type Fetcher } from "~/gateway/types"

const wire = (events: JSONRecord[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""), {
  headers: { "content-type": "text/event-stream" },
})
const text = (id: string, value = "ok") => ({ id, type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: value, annotations: [] }] })
const completion = (output: JSONRecord[], input = 10, generated = 2) => wire([
  { type: "response.created", response: { id: "upstream", output: [] } },
  ...output.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    ...(item.type === "message" ? [{
      type: "response.output_text.delta", output_index, item_id: item.id, content_index: 0, delta: item.content[0].text,
    }] : []),
    { type: "response.output_item.done", output_index, item },
  ]),
  { type: "response.completed", response: { id: "upstream", object: "response", output, status: "completed",
    usage: { input_tokens: input, output_tokens: generated, input_tokens_details: { cached_tokens: 3 } } } },
])
const payload = (extra = {}): JSONRecord => ({
  model: "local/model", stream: true, tools: [{ type: "function", name: "read" }, { type: "web_search" }],
  input: "synthetic test", ...extra,
})
const request = () => new Request("http://bridge.test/v1/responses")
const collect = async (response: Response) => {
  const events: JSONRecord[] = []
  for await (const event of upstreamEvents(response)) events.push(event)
  return events
}

describe("local hosted search seam", () => {
  test("default Codex tools do not block a non-search task or silently remove search", async () => {
    let called = false, sends = 0
    const response = await localSearchResponse(request(), payload(), async body => {
      sends++
      expect(body.tools).toHaveLength(2)
      expect(body.tools[0].name).toBe("read")
      expect(body.tools[1]).toMatchObject({ type: "function", name: "codex_bridge_hosted_web_search" })
      return completion([text("m1")])
    }, async () => { called = true; throw new Error("not called") })
    const events = await collect(response)
    expect(events.filter(e => e.type === "response.created")).toHaveLength(1)
    expect(events.at(-1)?.response.output).toEqual([text("m1")])
    expect(events.at(-1)?.response.usage.input_tokens).toBe(10)
    expect(called).toBe(false); expect(sends).toBe(1)
  })
  test("executes search only, merges lifecycle and usage, and continues in the same source", async () => {
    const sent: JSONRecord[] = []
    const response = await localSearchResponse(request(), payload(), async body => {
      sent.push(body)
      if (sent.length === 1) return completion([{
        id: "search-function", type: "function_call", name: body.tools[1].name,
        call_id: "search-call", arguments: '{"query":"Bun docs"}', status: "completed",
      }])
      expect(body.input.at(-1)).toEqual({ type: "function_call_output", call_id: "search-call", output: "Actual result https://bun.sh/docs" })
      return completion([text("final", "Here is the source.")], 20, 5)
    }, async query => ({ query, text: "Actual result https://bun.sh/docs",
      sources: [{ type: "url", url: "https://bun.sh/docs" }], usage: { input: 7, output: 3 } }))
    const events = await collect(response), serialized = JSON.stringify(events)
    expect(serialized).not.toContain("codex_bridge_hosted_web_search")
    expect(serialized).not.toContain("search-function")
    expect(sent).toHaveLength(2)
    expect(events.filter(e => e.type === "response.created")).toHaveLength(1)
    expect(events.filter(e => e.type === "response.completed")).toHaveLength(1)
    const final = events.at(-1)!.response
    expect(final.output.map((i: JSONRecord) => i.type)).toEqual(["web_search_call", "message"])
    expect(final.output[0].action.sources[0].url).toBe("https://bun.sh/docs")
    expect(final.usage).toMatchObject({ input_tokens: 37, output_tokens: 10, total_tokens: 47 })
    expect(new Set(events.map(e => e.sequence_number)).size).toBe(events.length)
    expect(events.find(e => e.type === "response.created")!.response.id).toBe(final.id)
  })
  test("mixed client and hosted calls do not run any workstation tool in the gateway", async () => {
    let sends = 0
    const response = await localSearchResponse(request(), payload(), async body => {
      sends++
      return completion([
        { id: "read-id", type: "function_call", name: "read", call_id: "client-call", arguments: "{}" },
        { id: "search-id", type: "function_call", name: body.tools[1].name, call_id: "hosted-call", arguments: '{"query":"example"}' },
      ])
    }, async query => ({ query, text: "UNTRUSTED_SEARCH_RESULT", sources: [] }))
    const events = await collect(response), output = events.at(-1)!.response.output
    expect(sends).toBe(1)
    expect(output[0]).toMatchObject({ type: "function_call", name: "read", call_id: "client-call" })
    expect(output[1].type).toBe("web_search_call")
    expect(output[2].content[0].text).toContain("UNTRUSTED_SEARCH_RESULT")
    expect(events.at(-1)!.response.usage).toBeUndefined()
  })
  test("failed search is an explicit terminal error, never a successful fabricated search", async () => {
    const response = await localSearchResponse(request(), payload(), async body => completion([{
      id: "s1", type: "function_call", name: body.tools[1].name, call_id: "c1", arguments: '{"query":"x"}',
    }]), async () => { throw new GatewayError(503, "local_search_unavailable", "No executed results.") })
    const events = await collect(response)
    expect(events.at(-1)?.type).toBe("response.failed")
    expect(events.at(-1)?.response.error.code).toBe("local_search_unavailable")
    expect(events.at(-1)?.response.output[0].status).toBe("failed")
    expect(events.some(e => e.type === "response.web_search_call.completed")).toBe(false)
  })
  test("non-streaming client receives a proper JSON envelope", async () => {
    const response = await localSearchResponse(request(), payload({ stream: false }), async () => completion([text("m")]),
      async () => { throw new Error("unreachable") })
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.json()).toMatchObject({ status: "completed", output: [text("m")] })
  })
  test("unterminated generation never triggers an inference retry", async () => {
    let sends = 0
    const response = await localSearchResponse(request(), payload(), async () => {
      sends++
      return wire([{ type: "response.created", response: { id: "x", output: [] } }])
    }, async () => { throw new Error("unreachable") })
    const events = await collect(response)
    expect(events.at(-1)?.response.error.code).toBe("missing_terminal")
    expect(sends).toBe(1)
  })
  test("client cancellation reaches an active search operation", async () => {
    let started!: () => void
    const entered = new Promise<void>(r => { started = r })
    let aborted = false
    const response = await localSearchResponse(request(), payload(), async body => completion([{
      id: "s1", type: "function_call", name: body.tools[1].name, call_id: "c1", arguments: '{"query":"x"}',
    }]), async (_q, _d, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")) }, { once: true })
      started()
    }))
    const reader = response.body!.getReader()
    const drain = (async () => { while (!(await reader.read()).done) {} })()
    await entered
    await reader.cancel()
    await drain
    expect(aborted).toBe(true)
  })
})

const studioOptions = (fetcher: Fetcher) => ({
  query: "synthetic search", definition: { type: "web_search" }, signal: new AbortController().signal,
  endpoint: new URL("http://studio.test/v1/"), model: "resident", fetcher,
  observe: (r: Response) => r,
})
test("native search requires paired execution events, not model-generated URLs or markup", async () => {
  await expect(studioSearch(studioOptions(async () => wire([
    { choices: [{ delta: { content: "https://example.com a made-up result" } }] },
  ])))).rejects.toThrow("did not report an executed")
  const options = studioOptions(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      enable_tools: true, enabled_tools: ["web_search"], mcp_enabled: false, bypass_permissions: false, permission_mode: "auto",
    })
    expect(new Headers(init?.headers).get("X-Unsloth-Events")).toBe("1")
    return wire([
      { type: "tool_start", tool_name: "web_search", tool_call_id: "1", arguments: { query: "synthetic search" } },
      { type: "tool_end", tool_name: "web_search", tool_call_id: "1", result: "Example - https://example.com/docs" },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
    ])
  })
  const result = await studioSearch(options)
  expect(result.sources).toEqual([{ type: "url", url: "https://example.com/docs" }])
  expect(result.usage).toMatchObject({ input: 10, output: 20 })
})
test("cached-only and filtered searches never silently become unrestricted live searches", async () => {
  let fetched = false
  const options = studioOptions(async () => { fetched = true; return wire([]) })
  await expect(studioSearch({ ...options, definition: { type: "web_search", external_web_access: false } })).rejects.toThrow("cached-only")
  await expect(studioSearch({ ...options, definition: { type: "web_search", filters: { allowed_domains: ["example.com"] } } })).rejects.toThrow("filters")
  expect(fetched).toBe(false)
})
test("native search cannot auto-approve a tool confirmation or accept another tool's output", async () => {
  await expect(studioSearch(studioOptions(async () => wire([
    { type: "tool_start", tool_name: "web_search", tool_call_id: "1", awaiting_confirmation: true },
  ])))).rejects.toThrow("No permission bypass")
  await expect(studioSearch(studioOptions(async () => wire([
    { type: "tool_start", tool_name: "terminal", tool_call_id: "1" },
  ])))).rejects.toThrow("additional tool")
})
test("local history preserves readable metadata and rejects unreadable protocol items", () => {
  const result = localHistory({ input: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Readable summary" }] },
    { type: "web_search_call", action: { type: "search", query: "old", sources: [{ url: "https://example.com" }] } },
  ] })
  expect(JSON.stringify(result)).toContain("Readable summary")
  expect(JSON.stringify(result)).toContain("https://example.com")
  expect(result.input[1].content[0].text).toContain("not newly fetched")
  for (const input of [
    [{ type: "reasoning", encrypted_content: "opaque" }], [{ type: "computer_call" }],
    [{ type: "item_reference", id: "external" }], [null],
  ]) expect(() => localHistory({ input })).toThrow()
  expect(() => localHistory({ previous_response_id: "external" })).toThrow()
})
