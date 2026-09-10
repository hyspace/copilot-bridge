/**
 * Opt-in end-to-end test of an installed Codex engine against the new gateway.
 * Isolated CODEX_HOME, synthetic workspace, read-only sandbox, no login material.
 * This is a test harness, never the production inference implementation.
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { spawn } from "node:child_process"
import { createGateway } from "~/gateway/server"
import { LocalProvider } from "~/gateway/local"

const { values } = parseArgs({
  args: process.argv.slice(2), options: {
    "base-url": { type: "string" }, "codex-bin": { type: "string" },
    "disable-search": { type: "boolean", default: false },
  },
})
if (!values["base-url"] || !values["codex-bin"]) throw new Error("--base-url and --codex-bin are required.")
const root = await mkdtemp(path.join(tmpdir(), "codex-bridge-e2e-"))
const workspace = path.join(root, "workspace"), home = path.join(root, "codex-home")
await mkdir(workspace); await mkdir(home, { mode: 0o700 }); await mkdir(".artifacts", { recursive: true })
await writeFile(path.join(workspace, "README.md"), "Synthetic fixture. The verification marker is CLIENT_TOOL_OK_912.\n")
const local = new LocalProvider({ url: values["base-url"] })
const models = await local.discover("0.153.4")
if (!models.length) throw new Error("No loaded local model. No model was loaded by this test.")
const catalogPath = path.join(home, "models.json")
await writeFile(catalogPath, JSON.stringify({ models: models.map(m => m.catalog) }), { mode: 0o600 })
const audit: unknown[] = []
const gateway = createGateway({ providers: [local], controlToken: "synthetic-control-token-not-for-production" })
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.method === "POST") {
      try {
        const body = await request.clone().json() as any
        audit.push({ model: body.model,
          tools: body.tools?.map((t: any) => ({ type: t.type, name: t.name,
            ...(t.type === "web_search" ? { options: t } : {}),
            nested: t.tools?.map((n: any) => ({ type: n.type, name: n.name })) })),
          inputTypes: Array.isArray(body.input) ? body.input.map((i: any) => i.type ?? i.role) : typeof body.input,
        })
      } catch { audit.push({ invalidRequest: true }) }
    }
    const response = await gateway.app.fetch(request)
    if (!response.ok) audit.push({ status: response.status, error: await response.clone().text() })
    return response
  },
})
const config = [
  `model = ${JSON.stringify(models[0].id)}`,
  'model_provider = "bridge_test"',
  'model_reasoning_effort = "none"',
  `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  'approval_policy = "never"', // Test remains read-only; approval-requiring tools fail.
  'sandbox_mode = "read-only"',
  ...(values["disable-search"] ? ['web_search = "disabled"'] : []),
  '[analytics]', 'enabled = false',
  '[model_providers.bridge_test]', 'name = "Codex Bridge test"',
  `base_url = "http://127.0.0.1:${server.port}/v1"`,
  'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
].join("\n")
await writeFile(path.join(home, "config.toml"), config, { mode: 0o600 })
const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(values["codex-bin"]!, [
    "exec", "--skip-git-repo-check", "--ephemeral", "--json", "-s", "read-only", "-C", workspace,
    "Read ONLY README.md in the current directory using a provided file or shell tool. Reply only with the verification marker it contains. Do not inspect any other paths, modify files, or use network/search.",
  ], {
    detached: true,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, CODEX_HOME: home,
      TMPDIR: root, LANG: "en_US.UTF-8",
    }, stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "", stderr = ""
  const timer = setTimeout(() => { if (child.exitCode === null && child.pid) process.kill(-child.pid, "SIGTERM") }, 180000)
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", data => { if (stdout.length < 2 * 1024 * 1024) stdout += data })
  child.stderr.on("data", data => { if (stderr.length < 2 * 1024 * 1024) stderr += data })
  child.on("error", error => { clearTimeout(timer); reject(error) })
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
})
server.stop(true)
const events = result.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const marker = events.some(e => e.type === "item.completed" && e.item?.type === "agent_message"
  && e.item.text?.includes("CLIENT_TOOL_OK_912"))
const executed = events.some(e => e.type === "item.completed" && e.item?.type === "command_execution")
const report = {
  at: new Date().toISOString(), code: result.code, marker, executedTool: executed, audit,
  isolatedHome: home, syntheticWorkspace: workspace,
  scope: "Codex engine read-only synthetic file task; not desktop Computer Use.",
  stderr: result.stderr.slice(-16000), events,
}
const filename = values["disable-search"] ? ".artifacts/codex-client-no-search.json" : ".artifacts/codex-client.json"
await writeFile(filename, JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ code: result.code, marker, executed, requests: audit.length, report: filename }))
console.log("Fixture unchanged:", (await readFile(path.join(workspace, "README.md"), "utf8")).includes("CLIENT_TOOL_OK_912"))
if (!marker || !executed || result.code !== 0) process.exitCode = 1
