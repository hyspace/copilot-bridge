import * as zlib from "node:zlib"

// Bound both the wire body and every decoded layer, including compression bombs.
// This is a transport/memory guard, not a model context-window limit.
export const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024
const MAX_ENCODING_LAYERS = 4
type Decompress = (
  input: zlib.InputType,
  options: { maxOutputLength: number },
  callback: (error: Error | null, result: Buffer) => void,
) => void
const decompressors: Record<"gzip" | "deflate" | "br" | "zstd", Decompress | undefined> = {
  gzip: zlib.gunzip,
  deflate: zlib.inflate,
  br: zlib.brotliDecompress,
  // Namespace lookup keeps older Node runtimes usable for all other encodings.
  zstd: zlib.zstdDecompress,
}

export class RequestBodyError extends Error {
  readonly status: 400 | 413 | 415

  constructor(
    status: 400 | 413 | 415,
    message: string,
  ) {
    super(message)
    this.name = "RequestBodyError"
    this.status = status
  }
}

const tooLarge = () => new RequestBodyError(413, "Request body exceeds the size limit.")

async function readBoundedBody(request: Request, limit: number): Promise<Buffer> {
  const length = request.headers.get("content-length")
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await request.body?.cancel()
    throw tooLarge()
  }
  if (!request.body) return Buffer.alloc(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

/**
 * Decode HTTP content encodings in reverse application order before JSON parsing.
 * Do not forward the original entity headers: callers serialize the returned JSON
 * and construct a fresh upstream request. Error messages never include body text.
 */
export async function readJsonRequest(
  request: Request,
  limit = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const header = request.headers.get("content-encoding")
  const encodings = header !== null
    ? header.split(",").map((value) => value.trim().toLowerCase())
    : []
  if (
    encodings.length > MAX_ENCODING_LAYERS
    || encodings.some((encoding) =>
      encoding !== "identity"
      && (!Object.hasOwn(decompressors, encoding)
        || typeof decompressors[encoding as keyof typeof decompressors] !== "function"),
    )
  ) {
    await request.body?.cancel()
    throw new RequestBodyError(415, "Unsupported request content encoding.")
  }

  let body = await readBoundedBody(request, limit)
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue
    const decompress = decompressors[encoding as keyof typeof decompressors]!
    try {
      body = await new Promise<Buffer>((resolve, reject) => {
        decompress(body, { maxOutputLength: limit }, (error, result) => {
          if (error) reject(error)
          else resolve(result)
        })
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw tooLarge()
      }
      throw new RequestBodyError(400, "Invalid compressed request body.")
    }
    if (body.byteLength > limit) throw tooLarge()
  }

  try {
    // Reject invalid UTF-8 instead of silently replacing bytes inside user content.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    throw new RequestBodyError(400, "Request body must be valid UTF-8 JSON.")
  }
}
