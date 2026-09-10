import { createHash } from "node:crypto"
import { normalizeResponsesSseStream } from "~/bridges/codex/normalize-stream"
import { rebuiltResponseHeaders } from "~/lib/response-headers"
import { boundedJSON } from "./http"
import { GatewayError, type JSONRecord } from "./types"

interface ToolIdentity { name: string; namespace?: string; alias: string }

/**
 * A lossless name/namespace adapter, not a tool executor. Keep schemas,
 * arguments, call IDs, opaque fields and permission descriptions intact.
 */
export function prepareLocalTools(payload: JSONRecord): {
  payload: JSONRecord; restore(response: Response): Promise<Response>
} {
  if (!Array.isArray(payload.tools)) return { payload, restore: async r => r }
  const identities = new Map<string, ToolIdentity>()
  const original = new Map<string, ToolIdentity>()
  const key = (name: string, namespace = "") => `${namespace}\0${name}`
  let changed = false
  const flat: JSONRecord[] = []
  const add = (tool: JSONRecord, namespace?: string) => {
    if (!tool || typeof tool !== "object" || typeof tool.type !== "string")
      throw new GatewayError(400, "invalid_tools", "Tool definitions must be objects.")
    if (tool.type === "namespace") {
      if (namespace || typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools))
        throw new GatewayError(422, "unsupported_namespace", "The local adapter requires a single named namespace level.")
      changed = true
      for (const nested of tool.tools) add(nested, tool.name)
      return
    }
    if (tool.type !== "function" && !(tool.type === "custom" && tool.name === "apply_patch")) {
      flat.push(tool); return // The capability gate rejects unsupported types.
    }
    if (typeof tool.name !== "string" || !tool.name)
      throw new GatewayError(400, "invalid_tools", "Tool names must not be empty.")
    const name = tool.name
    const needsAlias = Boolean(namespace) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)
    // Unsloth recognizes this exact custom tool; never rename it to an
    // unrecognized custom type or silently coerce its patch grammar.
    const alias = tool.type === "custom" ? name : needsAlias
      ? `${[namespace, name].filter(Boolean).join("__").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}_${createHash("sha256").update(key(name, namespace)).digest("hex").slice(0, 10)}`
      : name
    if (identities.has(alias) || original.has(key(name, namespace)))
      throw new GatewayError(400, "ambiguous_tools", "Duplicate or conflicting tool identities cannot be forwarded safely.")
    const identity = { name, namespace, alias }
    identities.set(alias, identity); original.set(key(name, namespace), identity)
    changed ||= alias !== name || Boolean(namespace)
    flat.push({ ...tool, name: alias })
  }
  for (const tool of payload.tools) add(tool)
  if (!changed) return { payload, restore: async r => r }
  const encode = (item: JSONRecord) => {
    if (!item || !["function_call", "custom_tool_call", "function", "custom"].includes(item.type)
      || typeof item.name !== "string") return item
    const identity = original.get(key(item.name, item.namespace))
      ?? [...original.values()].find(i => i.namespace && `${i.namespace}.${i.name}` === item.name)
    if (!identity) return item
    const { namespace: _namespace, ...rest } = item
    return { ...rest, name: identity.alias }
  }
  const translated = {
    ...payload, tools: flat,
    ...(Array.isArray(payload.input) ? { input: payload.input.map((i: JSONRecord) => encode(i)) } : {}),
    ...(payload.tool_choice && typeof payload.tool_choice === "object" ? { tool_choice: encode(payload.tool_choice) } : {}),
  }
  const decodeItem = (item: any) => {
    if (!item || !["function_call", "custom_tool_call"].includes(item.type)) return
    const identity = identities.get(item.name)
    if (!identity) return
    item.name = identity.name
    if (identity.namespace) item.namespace = identity.namespace
    else delete item.namespace
  }
  const decode = (data: string) => {
    let object: any
    try { object = JSON.parse(data) } catch { return data }
    if (!object || typeof object !== "object" || Array.isArray(object)) return data
    if (["response.output_item.added", "response.output_item.done"].includes(object.type)) decodeItem(object.item)
    const output = object.response?.output ?? object.output
    if (Array.isArray(output)) for (const item of output) decodeItem(item)
    return JSON.stringify(object)
  }
  return {
    payload: translated,
    async restore(response) {
      if (!response.ok || !response.body) return response
      if (response.headers.get("content-type")?.includes("text/event-stream"))
        return new Response(normalizeResponsesSseStream(response.body, decode), {
          status: response.status, headers: rebuiltResponseHeaders(response.headers),
        })
      const body = JSON.stringify(await boundedJSON(response, 8 * 1024 * 1024))
      return new Response(decode(body), { status: response.status, headers: rebuiltResponseHeaders(response.headers) })
    },
  }
}
