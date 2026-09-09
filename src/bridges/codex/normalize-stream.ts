import { mapSSE } from "~/lib/sse-stream"

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

  return lines
    .map((line) => {
      if (!line.startsWith("data: ")) {
        return line
      }

      const rawData = line.slice(6)
      if (!rawData || rawData === "[DONE]") {
        return line
      }

      return `data: ${normalizeEventPayload(rawData, stableResponse, outputItems)}`
    })
    .join("\n")
}

export const normalizeResponsesSseStream = (upstreamBody: ReadableStream<Uint8Array>) => {
  const stableResponse: StableResponseMetadata = { created_at: 0, id: "", initialized: false, model: "" }
  const outputItems = new Map<number, StableOutputItem>()
  return mapSSE(upstreamBody,
    (frame) => transformSseChunk(frame, stableResponse, outputItems),
    () => outputItems.clear())
}
