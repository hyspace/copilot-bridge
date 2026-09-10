import { GatewayError, type JSONRecord } from "./types"

/**
 * Unsloth ignores unknown Responses history items. Preserve readable summaries
 * explicitly and reject opaque history, instead of quietly changing the task.
 */
export function localHistory(payload: JSONRecord): JSONRecord {
  if (payload.previous_response_id)
    throw new GatewayError(409, "incompatible_history", "Local requests require explicit history, not previous_response_id.")
  if (!Array.isArray(payload.input)) return payload
  const input = payload.input.map((item: JSONRecord) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new GatewayError(400, "invalid_input", "History items must be objects.")
    if (item.encrypted_content || ["compaction", "context_compaction", "item_reference"].includes(item.type))
      throw new GatewayError(409, "incompatible_history",
        "This input contains opaque history the local endpoint cannot read. Start a new task or use the original provider.")
    if (item.type === "reasoning") {
      const parts = [item.summary, item.content].flatMap(value => Array.isArray(value) ? value : [])
      if (parts.some(part => typeof part?.text !== "string"))
        throw new GatewayError(409, "incompatible_history", "A reasoning item contains non-text history that cannot be replayed locally.")
      return { type: "message", role: "assistant", content: [{ type: "output_text",
        text: parts.length ? "Previous reasoning summary:\n" + parts.map(part => part.text).join("\n")
          : "Previous reasoning item had no replayable text." }] }
    }
    if (item.type === "web_search_call") {
      // A Responses client only replays the action/source metadata, not the
      // provider's hidden search-result body. Say exactly what was retained.
      return { type: "message", role: "assistant", content: [{ type: "output_text",
        text: "Previous web search metadata (not newly fetched results):\n" + JSON.stringify(item) }] }
    }
    if (item.type === undefined && ["system", "developer", "user", "assistant"].includes(item.role)) return item
    if (["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(item.type)) return item
    throw new GatewayError(409, "incompatible_history",
      `Local Responses cannot replay history type "${String(item.type).slice(0, 80)}" without losing information.`)
  })
  return { ...payload, input }
}
