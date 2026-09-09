import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "~/server"
import { fetchCopilot } from "~/providers/copilot/client"
import { applyCodexConfig } from "~/lib/codex-config"
import { CODEX_DEFAULTS } from "~/lib/defaults"

const originalFetch = globalThis.fetch
const originalEvents = process.env.COPILOT_BRIDGE_EVENTS_TOKEN
const originalAccess = process.env.COPILOT_BRIDGE_ACCESS_KEY
const originalInstance = process.env.COPILOT_BRIDGE_INSTANCE_ID
const provider = { baseUrl: "https://fake.test", token: "fake", vsCodeVersion: "test" }
const config = { host: "127.0.0.1", port: 0, accountType: "individual" as const,
  copilotBaseUrl: "https://fake.test", copilotToken: "fake", vsCodeVersion: "test" }
let undo: (() => void) | undefined

afterEach(() => {
  globalThis.fetch = originalFetch
  undo?.(); undo = undefined
  for (const [key,value] of Object.entries({
    COPILOT_BRIDGE_EVENTS_TOKEN:originalEvents,
    COPILOT_BRIDGE_ACCESS_KEY:originalAccess,
    COPILOT_BRIDGE_INSTANCE_ID:originalInstance
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

const capture = () => {
  const lines: string[] = []
  process.env.COPILOT_BRIDGE_EVENTS_TOKEN = "test-channel"
  const spy = spyOn(process.stdout,"write").mockImplementation((value: any) => {
    lines.push(String(value)); return true
  })
  undo = () => spy.mockRestore()
  return () => lines.flatMap(line=>line.split("\n")).filter(line=>line.startsWith("@@CBM:"))
    .map(line=>JSON.parse(line.slice(6)))
}

describe("optional native-supervisor support", () => {
  test("ordinary health response stays backward compatible",async()=>{
    delete process.env.COPILOT_BRIDGE_ACCESS_KEY
    delete process.env.COPILOT_BRIDGE_INSTANCE_ID
    expect(await (await createServer(config).request("/healthz")).json()).toEqual({ok:true})
  })
  test("instance health works without a LAN key, even with a stale key environment variable",async()=>{
    process.env.COPILOT_BRIDGE_ACCESS_KEY="obsolete-setting"
    process.env.COPILOT_BRIDGE_INSTANCE_ID="test-instance"
    const app=createServer(config)
    const good=await app.request("/healthz")
    expect(good.status).toBe(200)
    expect(await good.json()).toEqual({ok:true,instance:"test-instance"})
  })
  test("usage observation is opt-in and returns the original response when disabled",async()=>{
    delete process.env.COPILOT_BRIDGE_EVENTS_TOKEN
    const original=Response.json({usage:{input_tokens:3,output_tokens:2}})
    globalThis.fetch=(async()=>original) as unknown as typeof fetch
    expect(await fetchCopilot(provider,"/responses",{method:"POST",body:'{"model":"test"}'})).toBe(original)
  })
  test("counts final usage and each discarded retry, then cancels discarded body",async()=>{
    const events=capture()
    let calls=0,cancelled=false
    globalThis.fetch=(async()=>{
      if (++calls===1) return new Response(new ReadableStream({cancel(){cancelled=true}}),{status:503})
      return Response.json({usage:{input_tokens:30,output_tokens:4}})
    }) as unknown as typeof fetch
    const response=await fetchCopilot(provider,"/responses",{method:"POST",body:'{"model":"test"}'})
    await response.text()
    expect(cancelled).toBeTrue()
    expect(events()).toHaveLength(2)
    expect(events()[0]).toMatchObject({status:503,outcome:"http_error",input:null,channel:"test-channel"})
    expect(events()[1]).toMatchObject({status:200,outcome:"complete",input:30,output:4,channel:"test-channel"})
  })
  test("an already cancelled request is never sent or counted as an upstream attempt",async()=>{
    const events=capture()
    const abort=new AbortController();abort.abort()
    let calls=0
    globalThis.fetch=(async()=>{calls++;throw new Error("aborted")}) as unknown as typeof fetch
    await expect(fetchCopilot(provider,"/responses",{signal:abort.signal})).rejects.toThrow("aborted")
    expect(calls).toBe(0)
    expect(events()).toHaveLength(0)
  })
  test("Codex setup migrates WebSocket field and preserves explicit OpenAI auth",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"bridge-supervisor-test-"))
    const file=join(directory,"config.toml")
    await writeFile(file,'[model_providers.bridge] # user choice\nrequires_openai_auth = true\nprefer_websockets = false\n')
    await applyCodexConfig({configPath:file,baseUrl:"http://127.0.0.1:4142/v1",settings:CODEX_DEFAULTS})
    const content=await readFile(file,"utf8")
    expect(content).toContain("requires_openai_auth = true")
    expect(content).toContain("supports_websockets = false")
    expect(content).not.toContain("prefer_websockets")
  })
})
