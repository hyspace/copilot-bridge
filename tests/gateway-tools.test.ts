import { expect, test } from "bun:test"
import { prepareLocalTools } from "~/gateway/tool-namespaces"

test("flattens namespaces without losing schemas, call IDs or replay identity", async () => {
  const original = { tools: [{ type: "namespace", name: "functions", tools: [{
    type: "function", name: "inspect", description: "Approval required",
    parameters: { type: "object", properties: { id: { type: "string" } } },
  }] }], input: [{ type: "function_call", namespace: "functions", name: "inspect", call_id: "call-1", arguments: '{"id":"inspect"}' }],
    tool_choice: { type: "function", namespace: "functions", name: "inspect" } }
  const adapter = prepareLocalTools(original)
  const alias = adapter.payload.tools[0].name
  expect(alias).not.toBe("inspect")
  expect(adapter.payload.tools[0].description).toBe("Approval required")
  expect(adapter.payload.tools[0].parameters).toEqual(original.tools[0].tools[0].parameters)
  expect(adapter.payload.input[0]).toEqual({ type: "function_call", name: alias, call_id: "call-1", arguments: '{"id":"inspect"}' })
  expect(adapter.payload.tool_choice.name).toBe(alias)
  const response = Response.json({ output: [{ type: "function_call", name: alias, call_id: "call-2", arguments: '{"name":"unchanged"}' }] })
  expect(await (await adapter.restore(response)).json()).toEqual({ output: [{
    type: "function_call", namespace: "functions", name: "inspect", call_id: "call-2", arguments: '{"name":"unchanged"}',
  }] })
  expect(original.input[0].namespace).toBe("functions")
})
test("keeps stable aliases across requests and separates same names in different namespaces", () => {
  const body = { tools: ["one", "two"].map(name => ({ type: "namespace", name, tools: [{ type: "function", name: "read", parameters: {} }] })) }
  const a = prepareLocalTools(body), b = prepareLocalTools(body)
  expect(a.payload).toEqual(b.payload)
  expect(a.payload.tools[0].name).not.toBe(a.payload.tools[1].name)
})
test("reuses SSE framing without applying Copilot ID corrections", async () => {
  const adapter = prepareLocalTools({ tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "probe" }] }] })
  const alias = adapter.payload.tools[0].name
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "first", name: alias, call_id: "call" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "different", name: alias, call_id: "call", future: 1 } },
  ]
  const wire = events.map(event => "data: " + JSON.stringify(event) + "\r\n\r\n").join("")
  const output = await (await adapter.restore(new Response(wire, { headers: { "content-type": "text/event-stream" } }))).text()
  expect(output).toContain('"id":"first"'); expect(output).toContain('"id":"different"')
  expect(output).toContain('"namespace":"functions"'); expect(output).toContain('"future":1')
  expect(output).not.toContain(alias)
})
test("namespaced apply_patch retains the upstream's required custom identity", () => {
  const adapter = prepareLocalTools({ tools: [{ type: "namespace", name: "functions", tools: [{
    type: "custom", name: "apply_patch", format: { syntax: "lark", definition: "original grammar" },
  }] }] })
  expect(adapter.payload.tools[0]).toMatchObject({ type: "custom", name: "apply_patch", format: { definition: "original grammar" } })
})
