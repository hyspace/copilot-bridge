import { describe, expect, test } from "bun:test"

import { normalizeResponsesSseStream } from "~/bridges/codex/normalize-stream"

interface OutputItem {
  id?: unknown
  type?: unknown
  [key: string]: unknown
}

interface StreamEvent {
  type: string
  output_index?: unknown
  item_id?: unknown
  item?: OutputItem
  response?: { output?: Array<OutputItem>; [key: string]: unknown }
  [key: string]: unknown
}

const encoder = new TextEncoder()
const sse = (event: StreamEvent) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const normalizeText = async (text: string, chunkSize = 65536) => {
  const bytes = encoder.encode(text)
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  })
  return new Response(normalizeResponsesSseStream(input)).text()
}

const normalize = async (events: Array<StreamEvent>, chunkSize?: number) =>
  (await normalizeText(events.map(sse).join(""), chunkSize))
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent)

const itemEvent = (
  phase: "added" | "done",
  index: number,
  id: string,
  type = "message",
  extra: Record<string, unknown> = {},
): StreamEvent => ({
  type: `response.output_item.${phase}`,
  output_index: index,
  item: { type, id, ...extra },
})

const delta = (
  index: number,
  id: string,
  text: string,
  type = "response.output_text.delta",
): StreamEvent => ({
  type,
  output_index: index,
  item_id: id,
  content_index: 0,
  delta: text,
})

const itemIds = (events: Array<StreamEvent>) => events.flatMap((event) => [
  ...(event.item?.id ? [event.item.id] : []),
  ...(event.item_id ? [event.item_id] : []),
  ...(event.response?.output?.map((item) => item.id) ?? []),
])

// Ignore ONLY the fields this normalizer is permitted to change.
const withoutItemIds = (events: Array<StreamEvent>) => {
  const copy = structuredClone(events)
  for (const event of copy) {
    delete event.item_id
    if (event.item) delete event.item.id
    for (const item of event.response?.output ?? []) delete item.id
  }
  return copy
}

const driftingMessage = (): Array<StreamEvent> => [
  itemEvent("added", 0, "upstream_first", "message", {
    status: "in_progress",
    content: [],
  }),
  {
    type: "response.content_part.added",
    output_index: 0,
    item_id: "upstream_part",
    part: { type: "output_text", text: "" },
  },
  ...["BR", "IDGE", "_DI", "AGN", "OST", "IC", "_OK"].map((text, i) =>
    delta(0, `upstream_delta_${i}`, text),
  ),
  {
    type: "response.output_text.done",
    output_index: 0,
    item_id: "upstream_text_done",
    text: "BRIDGE_DIAGNOSTIC_OK",
  },
  {
    type: "response.content_part.done",
    output_index: 0,
    item_id: "upstream_part_done",
    part: { type: "output_text", text: "BRIDGE_DIAGNOSTIC_OK" },
  },
  itemEvent("done", 0, "upstream_done", "message", {
    status: "completed",
    content: [{ type: "output_text", text: "BRIDGE_DIAGNOSTIC_OK" }],
  }),
  {
    type: "response.completed",
    response: {
      id: "response_1",
      status: "completed",
      output: [{
        type: "message",
        id: "upstream_snapshot",
        content: [{ type: "output_text", text: "BRIDGE_DIAGNOSTIC_OK" }],
      }],
    },
  },
]

describe("Codex Responses SSE output identities", () => {
  test("unifies 13 upstream IDs without duplicating or dropping content/events", async () => {
    const input = driftingMessage()
    expect(new Set(itemIds(input)).size).toBe(13)
    const output = await normalize(input)
    expect(new Set(itemIds(output))).toEqual(new Set(["upstream_first"]))
    expect(withoutItemIds(output)).toEqual(withoutItemIds(input))
    expect(output.filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta).join("")).toBe("BRIDGE_DIAGNOSTIC_OK")
  })

  test("leaves already-stable output identities unchanged", async () => {
    const stable = await normalize(driftingMessage())
    const input = stable.map(sse).join("")
    expect(await normalizeText(input)).toBe(input)
  })

  test("preserves response metadata normalization", async () => {
    const output = await normalize([
      { type: "response.created", response: { id: "resp_first", model: "m", created_at: 123, output: [] } },
      itemEvent("added", 0, "item_first"),
      { type: "response.completed", response: {
        id: "resp_changed",
        model: "changed",
        created_at: 456,
        status: "completed",
        output: [{ type: "message", id: "item_changed" }],
        usage: { output_tokens: 1 },
      } },
    ])
    expect(output[2].response).toEqual({
      id: "resp_first", model: "m", created_at: 123, status: "completed",
      output: [{ type: "message", id: "item_first" }],
      usage: { output_tokens: 1 },
    })
  })

  test("isolates interleaved items and preserves tool IDs, encrypted content and unknown fields", async () => {
    const types = ["reasoning", "message", "function_call", "web_search_call", "message"]
    const input: Array<StreamEvent> = [
      ...types.map((type, i) => itemEvent("added", i, `first_${i}`, type)),
      delta(2, "args_changed", '{"text":"same"}', "response.function_call_arguments.delta"),
      delta(0, "reasoning_changed", "summary", "response.reasoning_summary_text.delta"),
      delta(4, "text_changed_4", "same"),
      delta(1, "text_changed_1", "same"),
      { type: "response.web_search_call.in_progress", output_index: 3, item_id: "search_changed" },
      ...types.map((type, i) => itemEvent("done", i, `done_${i}`, type, {
        call_id: `call_${i}`,
        arguments: '{"id":"nested_id"}',
        encrypted_content: "opaque_encrypted_content",
        future_field: { id: "leave_nested_id", item_id: "leave_nested_item_id" },
      })),
      { type: "response.completed", response: {
        id: "response_1",
        output: types.map((type, i) => ({
          type, id: `final_${i}`, call_id: `call_${i}`,
          encrypted_content: "opaque_encrypted_content",
        })),
      } },
    ]
    const output = await normalize(input)
    expect(withoutItemIds(output)).toEqual(withoutItemIds(input))
    for (const event of output) {
      if (event.item) expect(event.item.id).toBe(`first_${event.output_index}`)
      if (event.item_id) expect(event.item_id).toBe(`first_${event.output_index}`)
    }
    expect(output.at(-1)?.response?.output?.map((item) => item.id))
      .toEqual(types.map((_, i) => `first_${i}`))
    // Equal text belongs to two separate items; never deduplicate by content.
    expect(output.filter((event) => event.delta === "same")).toHaveLength(2)
  })

  test("freezes the first delta ID when added is missing or arrives late", async () => {
    const input = [
      delta(0, "first_delta", "hello"),
      itemEvent("added", 0, "late_added"),
      itemEvent("done", 0, "done"),
    ]
    expect(itemIds(await normalize(input))).toEqual(["first_delta", "first_delta", "first_delta"])
  })

  test("can establish an identity from done when both added and deltas are missing", async () => {
    expect(itemIds(await normalize([
      itemEvent("done", 0, "first_done"),
      { type: "response.completed", response: { output: [{ type: "message", id: "snapshot" }] } },
    ]))).toEqual(["first_done", "first_done"])
  })

  test.each(["response.completed", "response.incomplete", "response.failed", "response.in_progress"])(
    "normalizes output in %s without changing other snapshot fields",
    async (type) => {
      const input: Array<StreamEvent> = [
        itemEvent("added", 0, "first", "reasoning"),
        { type, response: {
          status: type.slice("response.".length),
          output: [{ type: "reasoning", id: "changed", encrypted_content: "opaque" }],
          error: { code: "preserve_error", id: "not_an_output_id" },
        } },
      ]
      const output = await normalize(input)
      expect(itemIds(output)).toEqual(["first", "first"])
      expect(withoutItemIds(output)).toEqual(withoutItemIds(input))
    },
  )

  test.each([undefined, null, -1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1])(
    "does not infer an output index from %s",
    async (index) => {
      const input: Array<StreamEvent> = [
        itemEvent("added", 0, "first"),
        { ...delta(0, "unchanged", "text"), output_index: index },
        { ...itemEvent("done", 0, "unchanged"), output_index: index },
      ]
      expect(await normalize(input)).toEqual(JSON.parse(JSON.stringify(input)))
    },
  )

  test.each([undefined, null, "", 42, {}, []])("does not invent or repair invalid IDs (%j)", async (id) => {
    const input: Array<StreamEvent> = [
      itemEvent("added", 0, "first"),
      { ...delta(0, "unused", "text"), item_id: id },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id } },
      { type: "response.completed", response: { output: [{ type: "message", id }] } },
    ]
    expect(await normalize(input)).toEqual(JSON.parse(JSON.stringify(input)))
  })

  test("does not let an invalid initial ID prevent later identification", async () => {
    expect(itemIds(await normalize([
      { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
      delta(0, "first_valid", "text"),
      itemEvent("done", 0, "changed"),
    ]))).toEqual(["first_valid", "first_valid"])
  })

  test("stops rewriting a conflicting index, including subsequent untyped deltas", async () => {
    const input: Array<StreamEvent> = [
      itemEvent("added", 0, "message_first", "message"),
      itemEvent("done", 0, "conflicting_reasoning", "reasoning"),
      delta(0, "ambiguous_delta", "text"),
      itemEvent("done", 0, "ambiguous_message", "message"),
      { type: "response.completed", response: { output: [{ type: "message", id: "ambiguous_final" }] } },
    ]
    expect(await normalize(input)).toEqual(input)
  })

  test("treats a snapshot type mismatch as a conflict rather than matching by position alone", async () => {
    const input: Array<StreamEvent> = [
      itemEvent("added", 0, "reasoning_first", "reasoning"),
      { type: "response.completed", response: { output: [{ type: "message", id: "keep_final" }] } },
    ]
    expect(await normalize(input)).toEqual(input)
  })

  test("preserves unknown event fields without recursively rewriting IDs", async () => {
    const input: Array<StreamEvent> = [
      itemEvent("added", 0, "first"),
      { type: "provider.custom", output_index: 0, item_id: "custom_id", item: { id: "custom_item" } },
      { type: "response.future_event", extra: { id: "nested", item_id: "nested_ref" } },
      { type: "response.output_text.delta", item_id: "no_index", delta: "text" },
    ]
    expect(await normalize(input)).toEqual(input)
  })

  test("passes malformed data and non-object JSON through unchanged", async () => {
    const input = [
      ": heartbeat\n\n",
      ...["{broken", "null", "[]", "42", '"string"', "[DONE]"].map((data) => `data: ${data}\n\n`),
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":null}\n\n',
    ].join("")
    expect(await normalizeText(input)).toBe(input)
  })

  test("preserves malformed item/snapshot shapes without poisoning later valid IDs", async () => {
    const rawEvents = [
      { type: "response.output_item.added", output_index: 0, item: [] },
      { type: "response.output_item.added", output_index: 0, item: { id: "bad_type", type: 42 } },
      itemEvent("added", 0, "first_valid"),
      { type: "response.completed", response: { output: "not-an-array" } },
      { type: "response.completed", response: { output: [null, 42, []] } },
    ]
    expect(await normalizeText(rawEvents.map((event) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ).join(""))).toBe(rawEvents.map((event) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ).join(""))
  })

  test.each([1, 7, 128, 65536])("handles UTF-8 and SSE split across %i-byte chunks", async (chunkSize) => {
    const input = [itemEvent("added", 0, "first"), delta(0, "changed", "中文🙂"), itemEvent("done", 0, "done")]
    const output = await normalize(input, chunkSize)
    expect(itemIds(output)).toEqual(["first", "first", "first"])
    expect(withoutItemIds(output)).toEqual(withoutItemIds(input))
  })

  test("normalizes a trailing event without a final separator", async () => {
    const input = sse(itemEvent("added", 0, "first")) + sse(itemEvent("done", 0, "changed")).trimEnd()
    expect(await normalizeText(input)).toBe(
      sse(itemEvent("added", 0, "first")) + sse(itemEvent("done", 0, "first")).trimEnd(),
    )
  })

  test("emits complete events before upstream closes and isolates concurrent streams", async () => {
    const first = new TransformStream<Uint8Array, Uint8Array>()
    const second = new TransformStream<Uint8Array, Uint8Array>()
    const firstWriter = first.writable.getWriter()
    const secondWriter = second.writable.getWriter()
    const firstReader = normalizeResponsesSseStream(first.readable).getReader()
    const secondReader = normalizeResponsesSseStream(second.readable).getReader()
    try {
      await Promise.all([
        firstWriter.write(encoder.encode(sse(itemEvent("added", 0, "first_stream")))),
        secondWriter.write(encoder.encode(sse(itemEvent("added", 0, "second_stream")))),
      ])
      // These reads must resolve while both upstreams remain open.
      const starts = await Promise.all([firstReader.read(), secondReader.read()])
      expect(new TextDecoder().decode(starts[0].value)).toContain("first_stream")
      expect(new TextDecoder().decode(starts[1].value)).toContain("second_stream")
      await Promise.all([
        firstWriter.write(encoder.encode(sse(delta(0, "changed", "one")))),
        secondWriter.write(encoder.encode(sse(delta(0, "changed", "two")))),
      ])
      const deltas = await Promise.all([firstReader.read(), secondReader.read()])
      expect(new TextDecoder().decode(deltas[0].value)).toContain('"item_id":"first_stream"')
      expect(new TextDecoder().decode(deltas[1].value)).toContain('"item_id":"second_stream"')
    } finally {
      await Promise.all([firstWriter.close(), secondWriter.close()])
    }
    expect((await firstReader.read()).done).toBe(true)
    expect((await secondReader.read()).done).toBe(true)
  })
})
