import { describe, expect, test } from "bun:test"
import { normalizeResponsesSseStream } from "~/bridges/codex/normalize-stream"

const encoder = new TextEncoder()
const item = (phase: "added" | "done", id: string) => ({
  type: `response.output_item.${phase}`,
  output_index: 0,
  item: { type: "message", id },
})
const parse = (text: string) => text.split("\n")
  .filter((line) => line.startsWith("data:"))
  .map((line) => JSON.parse(line.slice(5)))

async function normalize(text: string, chunkSize = 1) {
  const bytes = encoder.encode(text)
  return new Response(normalizeResponsesSseStream(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  }))).text()
}

describe("Responses SSE wire compatibility", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    test.each(["", " "])(
      `normalizes optional data space (%j) with ${JSON.stringify(newline)} and byte-split chunks`,
      async (space) => {
        const wire = [item("added", "first"), item("done", "different")].map((event) =>
          `data:${space}${JSON.stringify(event)}${newline}${newline}`,
        ).join("")
        const output = parse(await normalize(wire))
        expect(output.map((event) => event.item.id)).toEqual(["first", "first"])
      },
    )

    test(`emits ${JSON.stringify(newline)} events before upstream EOF`, async () => {
      let source!: ReadableStreamDefaultController<Uint8Array>
      const input = new ReadableStream<Uint8Array>({ start(c) { source = c } })
      const reader = normalizeResponsesSseStream(input).getReader()
      try {
        source.enqueue(encoder.encode(`data: {"type":"response.created"}${newline}${newline}`))
        // Do not close upstream until the complete event has been observed.
        const result = await reader.read()
        expect(result.done).toBe(false)
        expect(new TextDecoder().decode(result.value)).toContain("response.created")
        source.close()
        expect((await reader.read()).done).toBe(true)
      } finally {
        await reader.cancel().catch(() => {})
      }
    }, 1000)
  }

  test("joins multiline data before normalization, preserving other SSE fields", async () => {
    const first = `data: ${JSON.stringify(item("added", "first"))}\n\n`
    const second = [
      ": comment", "id: 123", "retry: 1000", "event: response.output_item.done",
      'data: {"type":"response.output_item.done",',
      'data:"output_index":0,"item":{"type":"message","id":"different"}}', "", "",
    ].join("\n")
    const output = await normalize(first + second)
    expect(output).toContain(": comment\nid: 123\nretry: 1000\n")
    expect(parse(output)[1].item.id).toBe("first")
  })

  test("preserves Unicode, citation annotations and native search source metadata", async () => {
    const text = "中文🙂\uE200cite\uE202turn1view0\uE201"
    const annotations = [{
      type: "url_citation", url: "https://example.com", title: "来源",
      start_index: 0, end_index: 2,
    }]
    const events = [
      { type: "response.output_text.delta", delta: text },
      { type: "response.output_text.annotation.added", annotation: annotations[0] },
      { type: "response.output_item.done", item: {
        type: "web_search_call", id: "search",
        action: { type: "search", query: "test", sources: [{ url: "https://example.com" }] },
      } },
      { type: "response.completed", response: {
        output: [{ type: "message", content: [{ type: "output_text", text, annotations }] }],
      } },
    ]
    const wire = events.map((event) => `data:${JSON.stringify(event)}\r\n\r\n`).join("")
    expect(parse(await normalize(wire))).toEqual(events)
  })

  test("does not fabricate completion when EOF lacks response.completed", async () => {
    const output = await normalize('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
    expect(output).not.toContain("response.completed")
    expect(parse(output)).toHaveLength(1)
  })

  test("propagates upstream read failures rather than reporting clean EOF", async () => {
    const input = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("upstream disconnected")) },
    })
    await expect(new Response(normalizeResponsesSseStream(input)).text())
      .rejects.toThrow("upstream disconnected")
  })

  test("propagates downstream cancellation to upstream", async () => {
    let cancelled!: (value: unknown) => void
    const cancellation = new Promise((resolve) => { cancelled = resolve })
    const input = new ReadableStream<Uint8Array>({
      cancel(value) { cancelled(value) },
    })
    await normalizeResponsesSseStream(input).cancel("client stopped")
    expect(await cancellation).toBe("client stopped")
  }, 1000)

  test("flushes an incomplete final UTF-8 sequence instead of silently losing bytes", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x3a, 0x20, 0xe4, 0xbd]))
        controller.close()
      },
    })
    expect(await new Response(normalizeResponsesSseStream(input)).text()).toBe(": \uFFFD")
  })
})
