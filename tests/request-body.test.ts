import { describe, expect, test } from "bun:test"
import {
  gzipSync, deflateSync, brotliCompressSync, zstdCompressSync,
} from "node:zlib"

import { readJsonRequest, RequestBodyError } from "~/lib/request-body"

const payload = { model: "test", input: "中文🙂\uE200cite\uE202turn1view0\uE201" }
const json = Buffer.from(JSON.stringify(payload))

const request = (body: Uint8Array | string, encoding?: string, length?: number) =>
  new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(encoding === undefined ? {} : { "content-encoding": encoding }),
      ...(length === undefined ? {} : { "content-length": String(length) }),
    },
    body: body as RequestInit["body"],
  })

describe("bounded HTTP JSON request decoding", () => {
  test.each([
    ["identity", (body: Buffer) => body],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
    ["zstd", zstdCompressSync],
  ] as const)("decodes %s without corrupting Unicode", async (encoding, compress) => {
    expect(await readJsonRequest(request(compress(json), encoding))).toEqual(payload)
  })

  test("accepts uncompressed requests and exact size boundaries", async () => {
    expect(await readJsonRequest(request(json), json.length)).toEqual(payload)
    const largerJson = Buffer.from(JSON.stringify("x".repeat(1000)))
    expect(await readJsonRequest(request(gzipSync(largerJson), "gzip"), largerJson.length))
      .toEqual("x".repeat(1000))
  })

  test("reverses stacked encodings and ignores identity", async () => {
    const body = zstdCompressSync(gzipSync(json))
    expect(await readJsonRequest(request(body, " GZip , identity, ZSTD "))).toEqual(payload)
  })

  test.each(["compress", "", "gzip,", "gzip,wat", "gzip,gzip,gzip,gzip,gzip"])(
    "rejects unsupported/malformed encodings (%s) with 415",
    async (encoding) => {
      await expect(readJsonRequest(request(json, encoding))).rejects.toMatchObject({ status: 415 })
    },
  )

  test.each(["gzip", "deflate", "br", "zstd"])(
    "rejects invalid %s data without echoing its contents",
    async (encoding) => {
      try {
        await readJsonRequest(request("PRIVATE_REQUEST_CONTENT", encoding))
        throw new Error("Expected rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(RequestBodyError)
        expect(error).toMatchObject({ status: 400 })
        expect((error as Error).message).not.toContain("PRIVATE_REQUEST_CONTENT")
      }
    },
  )

  test.each(["", "{broken", '{"secret":"PRIVATE_REQUEST_CONTENT"', "\uFFFD"])(
    "rejects invalid JSON without including parser excerpts",
    async (body) => {
      await expect(readJsonRequest(request(body))).rejects.toMatchObject({
        status: 400, message: "Request body must be valid UTF-8 JSON.",
      })
    },
  )

  test("rejects malformed UTF-8 even inside an otherwise valid JSON string", async () => {
    await expect(readJsonRequest(request(new Uint8Array([34, 0xff, 34]))))
      .rejects.toMatchObject({ status: 400 })
  })

  test("rejects raw bodies over the limit even with a forged small content-length", async () => {
    await expect(readJsonRequest(request(json, undefined, 1), 10))
      .rejects.toMatchObject({ status: 413 })
    await expect(readJsonRequest(request(json, undefined, 1000), 10))
      .rejects.toMatchObject({ status: 413 })
  })

  test("cancels an oversized chunked upload", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.alloc(20)) },
      cancel() { cancelled = true },
    })
    const input = new Request("http://localhost/v1/responses", {
      method: "POST", body, duplex: "half",
    } as RequestInit)
    await expect(readJsonRequest(input, 10)).rejects.toMatchObject({ status: 413 })
    expect(cancelled).toBe(true)
  })

  test.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
    ["zstd", zstdCompressSync],
  ] as const)("bounds decoded %s output, not just compressed bytes", async (encoding, compress) => {
    const body = compress(Buffer.from(JSON.stringify("x".repeat(10000))))
    expect(body.length).toBeLessThan(1000)
    await expect(readJsonRequest(request(body, encoding), 1000))
      .rejects.toMatchObject({ status: 413 })
  })

  test("also bounds intermediate decoding layers", async () => {
    // The first (identity-like stored gzip) layer exceeds the limit after its
    // outer zstd layer is removed, even though the final JSON is tiny.
    const padded = Buffer.concat([gzipSync(json), Buffer.alloc(3000)])
    const body = zstdCompressSync(padded)
    await expect(readJsonRequest(request(body, "gzip,zstd"), 1000))
      .rejects.toMatchObject({ status: 413 })
  })
})
