import { normalizeResponsesSseStream } from "~/bridges/codex/normalize-stream"
import { boundedJSON } from "./http"
import { GatewayError, type JSONRecord } from "./types"

/** Bounded framing only; it does not apply Copilot's output-ID corrections. */
export async function* upstreamEvents(response: Response): AsyncGenerator<JSONRecord> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const value = await boundedJSON(response, 8 * 1024 * 1024)
    if (!value || typeof value !== "object" || !Array.isArray(value.output))
      throw new GatewayError(502, "invalid_response", "The local API returned an invalid Responses envelope.")
    yield { type: "response.created", response: { ...value, status: "in_progress", output: [] } }
    for (const [output_index, item] of value.output.entries()) {
      yield { type: "response.output_item.added", output_index, item }
      if (item.type === "message") for (const [content_index, part] of (item.content ?? []).entries()) {
        if (part.type === "output_text") {
          yield { type: "response.content_part.added", output_index, content_index, item_id: item.id,
            part: { ...part, text: "" } }
          yield { type: "response.output_text.delta", output_index, content_index, item_id: item.id, delta: part.text }
          yield { type: "response.output_text.done", output_index, content_index, item_id: item.id, text: part.text }
          yield { type: "response.content_part.done", output_index, content_index, item_id: item.id, part }
        }
      }
      yield { type: "response.output_item.done", output_index, item }
    }
    yield { type: `response.${value.status ?? "completed"}`, response: value }
    return
  }
  if (!response.body) throw new GatewayError(502, "invalid_response", "The local response stream was empty.")
  const reader = normalizeResponsesSseStream(response.body, data => data).getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = "", ended = false
  try {
    while (true) {
      const next = await reader.read()
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (frame.length > 8 * 1024 * 1024) throw new GatewayError(502, "event_too_large", "An upstream stream event exceeds the size limit.")
        const data = frame.split("\n").filter(line => line === "data" || line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n")
        if (!data || data === "[DONE]") continue
        let object: JSONRecord
        try { object = JSON.parse(data) }
        catch { throw new GatewayError(502, "invalid_event", "The upstream emitted malformed stream JSON.") }
        if (!object || typeof object !== "object" || Array.isArray(object))
          throw new GatewayError(502, "invalid_event", "The upstream emitted an invalid stream event.")
        if (!object.type) object.type = frame.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim()
        yield object
      }
      if (buffer.length > 8 * 1024 * 1024) throw new GatewayError(502, "event_too_large", "An upstream stream event exceeds the size limit.")
      if (next.done) { ended = true; break }
    }
    if (buffer.trim()) throw new GatewayError(502, "incomplete_event", "The upstream stream ended inside an event.")
  } finally {
    if (!ended) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Pull-driven output with cancellation reaching all inner inference requests. */
export function eventStream(iterator: AsyncGenerator<JSONRecord>, abort: () => void): ReadableStream<Uint8Array> {
  let stopped = false
  const encoder = new TextEncoder()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (stopped) return
        if (done) { stopped = true; abort(); controller.close() }
        else controller.enqueue(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`))
      } catch (error) {
        if (!stopped) { stopped = true; abort(); controller.error(error) }
      }
    },
    cancel() {
      stopped = true; abort()
      void iterator.return(undefined).catch(() => {})
    },
  })
}
