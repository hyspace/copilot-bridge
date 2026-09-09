interface ResponseMetadata {
  created_at?: number
  id?: string
  model?: string
  output?: unknown
}

interface ResponsesStreamEvent {
  response?: ResponseMetadata
  type?: string
  [key: string]: unknown
}

interface StableResponseMetadata {
  created_at: number
  id: string
  initialized: boolean
  model: string
}

interface StableOutputItem {
  id: string
  type?: string
  conflicted: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const isOutputIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const normalizeOutputId = (
  id: unknown,
  type: string | undefined,
  index: number,
  outputItems: Map<number, StableOutputItem>,
): unknown => {
  const stable = outputItems.get(index)
  if (stable) {
    if (type && stable.type && type !== stable.type) {
      // Once an index is ambiguous, even later untyped deltas must pass through.
      stable.conflicted = true
    }
    if (stable.conflicted) return id
    if (type) stable.type = type
  }

  if (!isNonEmptyString(id)) return id
  if (stable) return stable.id

  // Keep a real upstream ID for subsequent conversation input, never a local ID.
  outputItems.set(index, { id, type, conflicted: false })
  return id
}

const normalizeOutputItem = (
  item: unknown,
  index: number,
  outputItems: Map<number, StableOutputItem>,
) => {
  if (!isRecord(item) || !isNonEmptyString(item.type)) return
  const id = normalizeOutputId(item.id, item.type, index, outputItems)
  if (id !== item.id) item.id = id
}

const normalizeEventPayload = (
  rawData: string,
  stableResponse: StableResponseMetadata,
  outputItems: Map<number, StableOutputItem>,
): string => {
  let event: ResponsesStreamEvent
  try {
    event = JSON.parse(rawData) as ResponsesStreamEvent
  } catch {
    return rawData
  }

  if (!isRecord(event)) return rawData

  const isResponseEvent =
    typeof event.type === "string" && event.type.startsWith("response.")
  if (isResponseEvent && isOutputIndex(event.output_index)) {
    if (
      event.type === "response.output_item.added"
      || event.type === "response.output_item.done"
    ) {
      normalizeOutputItem(event.item, event.output_index, outputItems)
    }
    if ("item_id" in event) {
      event.item_id = normalizeOutputId(
        event.item_id,
        undefined,
        event.output_index,
        outputItems,
      )
    }
  }

  if (isRecord(event.response)) {
    const incoming = event.response
    if (isResponseEvent && Array.isArray(incoming.output)) {
      incoming.output.forEach((item, index) =>
        normalizeOutputItem(item, index, outputItems),
      )
    }
    if (!stableResponse.initialized) {
      if (isNonEmptyString(incoming.id)) stableResponse.id = incoming.id
      if (typeof incoming.created_at === "number")
        stableResponse.created_at = incoming.created_at
      if (isNonEmptyString(incoming.model)) stableResponse.model = incoming.model
      stableResponse.initialized = true
    }

    event.response = {
      ...incoming,
      ...(stableResponse.id ? { id: stableResponse.id } : {}),
      ...(stableResponse.created_at
        ? { created_at: stableResponse.created_at }
        : {}),
      ...(stableResponse.model ? { model: stableResponse.model } : {}),
    }
  }

  return JSON.stringify(event)
}

const transformSseChunk = (
  chunk: string,
  stableResponse: StableResponseMetadata,
  outputItems: Map<number, StableOutputItem>,
): string => {
  const lines = chunk.split("\n")
  const dataIndices: number[] = []
  const data: string[] = []
  for (const [index, line] of lines.entries()) {
    if (line !== "data" && !line.startsWith("data:")) continue
    dataIndices.push(index)
    // SSE permits either data:value or data: value; strip at most one space.
    data.push(line.slice(5).replace(/^ /, ""))
  }
  if (!dataIndices.length) return chunk
  const rawData = data.join("\n")
  if (!rawData || rawData === "[DONE]") return chunk
  const normalized = normalizeEventPayload(rawData, stableResponse, outputItems)
  if (normalized === rawData) return chunk

  const dataIndexSet = new Set(dataIndices)
  return lines.flatMap((line, index) => {
    if (index === dataIndices[0]) return [`data: ${normalized}`]
    return dataIndexSet.has(index) ? [] : [line]
  }).join("\n")
}

export const normalizeResponsesSseStream = (
  upstreamBody: ReadableStream<Uint8Array>,
) => {
  const stableResponse: StableResponseMetadata = {
    created_at: 0,
    id: "",
    initialized: false,
    model: "",
  }
  // Per stream, O(output items), not O(tokens); no cross-request ID aliases.
  const outputItems = new Map<number, StableOutputItem>()

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pendingLine = ""
  let lines: string[] = []
  let skipLF = false

  const append = (
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (!text) return
    if (skipLF) {
      if (text.startsWith("\n")) text = text.slice(1)
      skipLF = false
    }
    const breaks = /[\r\n]/g
    let start = 0
    for (let match = breaks.exec(text); match; match = breaks.exec(text)) {
      const line = pendingLine + text.slice(start, match.index)
      pendingLine = ""
      if (line) {
        lines.push(line)
      } else {
        const event = transformSseChunk(lines.join("\n"), stableResponse, outputItems)
        controller.enqueue(encoder.encode(lines.length ? `${event}\n\n` : "\n"))
        lines = []
      }
      start = match.index + 1
      if (match[0] === "\r") {
        if (text[start] === "\n") {
          start++
          breaks.lastIndex = start
        } else if (start === text.length) {
          skipLF = true
        }
      }
    }
    pendingLine += text.slice(start)
  }

  // pipeThrough propagates upstream read errors, cancellation and backpressure.
  // A one-chunk queue allows a complete event to arrive before the first read.
  return upstreamBody.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(value, controller) {
      append(decoder.decode(value, { stream: true }), controller)
    },
    flush(controller) {
      append(decoder.decode(), controller)
      if (pendingLine || lines.length) {
        const trailing = [...lines, pendingLine].join("\n")
        controller.enqueue(encoder.encode(
          transformSseChunk(trailing, stableResponse, outputItems),
        ))
      }
      outputItems.clear()
      // Never synthesize response.completed for a truncated or failed stream.
    },
  }, undefined, { highWaterMark: 1 }))
}
