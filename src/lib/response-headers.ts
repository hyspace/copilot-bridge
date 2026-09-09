/**
 * Entity metadata from the upstream wire representation is no longer valid after
 * fetch decoding or our SSE normalization. Keep semantic headers (content type,
 * retry-after, request IDs, etc.) but let the HTTP server frame the new body.
 */
export function rebuiltResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source)
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim())
  }
  for (const name of [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
    "content-length", "content-encoding",
    "content-md5", "digest", "content-digest", "repr-digest", "etag",
  ]) {
    headers.delete(name)
  }
  return headers
}
