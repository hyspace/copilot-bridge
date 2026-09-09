import { afterEach, describe, expect, spyOn, test } from "bun:test"

import {
  fetchCopilot,
  type CopilotProviderContext,
} from "~/providers/copilot/client"

const provider: CopilotProviderContext = {
  baseUrl: "https://upstream.test",
  token: "test-token",
  vsCodeVersion: "1.0.0",
}

const originalFetch = globalThis.fetch
const originalEvents = process.env.COPILOT_BRIDGE_EVENTS_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEvents === undefined) delete process.env.COPILOT_BRIDGE_EVENTS_TOKEN
  else process.env.COPILOT_BRIDGE_EVENTS_TOKEN = originalEvents
})

describe("fetchCopilot retry", () => {
  test("retries one transient upstream 5xx", async () => {
    const requestIds: Array<string> = []
    let calls = 0
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++
      requestIds.push(new Headers(init?.headers).get("x-request-id") ?? "")
      return new Response(calls === 1 ? "Internal Server Error\n" : "{}", {
        status: calls === 1 ? 500 : 200,
      })
    }) as unknown as typeof fetch

    const response = await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
    })

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect(requestIds[0]).toBeTruthy()
    expect(requestIds[1]).toBeTruthy()
    expect(requestIds[0]).not.toBe(requestIds[1])
  })

  test("does not retry upstream 4xx", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("Bad Request\n", { status: 400 })
    }) as unknown as typeof fetch

    const response = await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
    })

    expect(response.status).toBe(400)
    expect(calls).toBe(1)
  })

  test("retries one network failure", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) {
        throw new Error("socket closed")
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const response = await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
    })

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("records server billing for both retry attempts with separate IDs", async () => {
    const records: any[] = []
    process.env.COPILOT_BRIDGE_EVENTS_TOKEN = "test-billing-channel"
    const spy = spyOn(process.stdout, "write").mockImplementation((value: any) => {
      const text = String(value)
      if (text.startsWith("@@CBM:")) records.push(JSON.parse(text.slice(6)))
      return true
    })
    try {
      let calls = 0
      globalThis.fetch = (async () => {
        calls++
        return new Response(JSON.stringify({usage:{
          input_tokens:10,output_tokens:2,copilot_usage:{total_nano_aiu:calls * 100000000},
        }}),{status:calls === 1 ? 503 : 200,headers:{"content-type":"application/json"}})
      }) as unknown as typeof fetch
      const response = await fetchCopilot(provider, "/responses", {
        method:"POST",body:JSON.stringify({model:"test"}),
      })
      await response.text()
      expect(records).toHaveLength(2)
      expect(records.map(r=>r.nanoAiu)).toEqual([100000000,200000000])
      expect(records.map(r=>r.outcome)).toEqual(["http_error","complete"])
      expect(records[0].id).not.toBe(records[1].id)
    } finally { spy.mockRestore() }
  })

  test("aborting a retry body does not start a second request or duplicate accounting", async () => {
    const records: any[] = []
    const controller = new AbortController()
    process.env.COPILOT_BRIDGE_EVENTS_TOKEN = "test-billing-channel"
    const spy = spyOn(process.stdout, "write").mockImplementation((value: any) => {
      if (String(value).startsWith("@@CBM:")) records.push(JSON.parse(String(value).slice(6)))
      return true
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      let calls = 0, cancelled = false
      globalThis.fetch = (async () => {
        calls++
        timer = setTimeout(()=>controller.abort(),20)
        return new Response(new ReadableStream({
          cancel() { cancelled = true },
        }),{status:503,headers:{"content-type":"application/json"}})
      }) as unknown as typeof fetch
      await expect(fetchCopilot(provider,"/responses",{
        method:"POST",body:'{"model":"test"}',signal:controller.signal,
      })).rejects.toThrow()
      expect(calls).toBe(1)
      expect(cancelled).toBeTrue()
      expect(records).toHaveLength(1)
      expect(records[0].nanoAiu).toBeNull()
    } finally { clearTimeout(timer); spy.mockRestore() }
  })
})
