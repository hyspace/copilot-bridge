import { rebuiltResponseHeaders } from "~/lib/response-headers"
import { emitBridgeEvent } from "~/lib/events"
import { observeResponse } from "~/lib/usage-telemetry"
import { GatewayError, type Fetcher, type ProviderID } from "./types"
import { randomUUID } from "node:crypto"

export function normalizeEndpoint(input: string): URL {
  let url: URL
  try { url = new URL(input.trim()) }
  catch { throw new GatewayError(400, "invalid_endpoint", "Use a complete HTTP(S) API address.") }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname
    || url.username || url.password || url.search || url.hash || url.href.length > 2048)
    throw new GatewayError(400, "invalid_endpoint", "API addresses cannot contain credentials, a query, or a fragment.")
  let path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith("/responses")) path = path.slice(0, -"/responses".length)
  if (!path) path = "/v1"
  url.pathname = path + "/"
  return url
}

export async function boundedJSON(response: Response, limit = 4 * 1024 * 1024): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new GatewayError(response.status === 401 || response.status === 403 ? 401 : 502,
      "upstream_discovery_failed", `Upstream metadata request returned HTTP ${response.status}.`)
  }
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
  if (type !== "application/json" && !type?.endsWith("+json")) {
    await response.body?.cancel().catch(() => {})
    throw new GatewayError(502, "invalid_catalog", "Upstream returned a non-JSON metadata response.")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new GatewayError(502, "invalid_catalog", "Upstream metadata was empty.")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) {
        await reader.cancel()
        throw new GatewayError(502, "invalid_catalog", "Upstream metadata exceeds the size limit.")
      }
      chunks.push(value)
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new GatewayError(502, "invalid_catalog", "Upstream metadata is not valid JSON.") }
  } finally { reader.releaseLock() }
}

export async function fetchMetadata(fetcher: Fetcher, url: URL, headers?: RequestInit["headers"]): Promise<any> {
  try {
    return await boundedJSON(await fetcher(url, {
      headers: { accept: "application/json", ...Object.fromEntries(new Headers(headers)) },
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    }))
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(503, "provider_unavailable", "Could not read upstream metadata. Check the address, authentication, and service.")
  }
}

/** Construct outbound headers; never copy caller authentication, cookies, or account identity. */
export function upstreamHeaders(request: Request, auth: { access?: string; accountID?: string }, official = false): Headers {
  const headers = new Headers({
    accept: request.headers.get("accept")?.includes("text/event-stream") ? "text/event-stream" : "application/json",
    "content-type": "application/json",
  })
  if (auth.access) headers.set("authorization", `Bearer ${auth.access}`)
  if (official) {
    if (auth.accountID) headers.set("chatgpt-account-id", auth.accountID)
    headers.set("originator", "codex_cli_rs")
    headers.set("version", "0.153.4")
    for (const name of [
      "openai-beta", "session_id", "conversation_id", "x-codex-turn-metadata",
      "x-codex-parent-thread-id", "x-client-request-id",
    ]) {
      const value = request.headers.get(name)
      if (value && value.length <= 8192) headers.set(name, value)
    }
  }
  return headers
}

export function observed(response: Response, provider: ProviderID, model: string): Response {
  const result = observeResponse(response, {
    id: randomUUID(), timestamp: Date.now() / 1000, model: model.slice(0, 512), provider,
  }, emitBridgeEvent)
  return new Response(result.body, { status: result.status, headers: rebuiltResponseHeaders(result.headers) })
}

/** Native forwarding is not a generation retry loop. Stream bytes stay unchanged. */
export async function forwardNative(fetcher: Fetcher, url: URL, request: Request,
  payload: unknown, headers: Headers): Promise<Response> {
  try {
    const response = await fetcher(url, {
      method: "POST", headers, body: JSON.stringify(payload), redirect: "manual", signal: request.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw new GatewayError(502, "upstream_redirect", "The selected provider redirected the request. It was not followed.")
    }
    return response
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (request.signal.aborted) throw error
    throw new GatewayError(503, "provider_unavailable", "The selected provider could not be reached. No other provider was used.")
  }
}
