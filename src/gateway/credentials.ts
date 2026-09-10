import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { GatewayError } from "./types"

export interface SecretStore {
  read(key: "codex" | "local"): Promise<unknown>
  write(key: "codex" | "local", value: unknown): Promise<void>
  remove(key: "codex" | "local"): Promise<void>
  close?(): void
}

/**
 * The signed native application owns Keychain access. A dedicated stdio broker
 * holds an OS lock for its lifetime; tokens never appear in argv, HTTP status
 * responses, diagnostic events, config files, or log output.
 */
export class KeychainBrokerStore implements SecretStore {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: Timer }>()
  private buffer = ""
  private executable?: string
  constructor(executable?: string) { this.executable = executable }
  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    if (!this.executable?.startsWith("/"))
      throw new GatewayError(503, "credential_store_unavailable", "The native credential broker is unavailable.")
    const child = spawn(this.executable, ["--credential-broker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    })
    this.child = child
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (data: string) => {
      this.buffer += data
      if (this.buffer.length > 262144) { this.close(); return }
      let newline: number
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1)
        try {
          const response = JSON.parse(line)
          const pending = this.pending.get(response.id)
          if (!pending) continue
          this.pending.delete(response.id); clearTimeout(pending.timer)
          if (response.ok === true) pending.resolve(response.value)
          else pending.reject(new GatewayError(503, "credential_store_unavailable",
            "Keychain access failed or another Codex Bridge owns the credential broker."))
        } catch { this.close(); return }
      }
    })
    // Drain without forwarding potentially sensitive operating-system diagnostics.
    child.stderr.resume()
    child.once("error", () => { if (this.child === child) this.fail() })
    child.once("close", () => { if (this.child === child) this.fail() })
    return child
  }
  private fail(): void {
    this.child = undefined; this.buffer = ""
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new GatewayError(503, "credential_store_unavailable", "The native credential broker stopped."))
    }
    this.pending.clear()
  }
  private send(operation: string, key: string, value?: unknown): Promise<unknown> {
    if (this.pending.size >= 32)
      throw new GatewayError(503, "credential_store_busy", "The credential store has too many pending operations.")
    const child = this.start(), id = randomUUID()
    const line = JSON.stringify({ id, operation, key, value }) + "\n"
    if (line.length > 131072) throw new GatewayError(400, "invalid_credential", "Credential exceeds the storage limit.")
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new GatewayError(503, "credential_store_unavailable", "Keychain access timed out."))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(line, error => {
        if (!error) return
        clearTimeout(timer); this.pending.delete(id)
        reject(new GatewayError(503, "credential_store_unavailable", "Could not contact the credential broker."))
      })
    })
  }
  read(key: "codex" | "local"): Promise<unknown> { return this.send("read", key) }
  async write(key: "codex" | "local", value: unknown): Promise<void> { await this.send("write", key, value) }
  async remove(key: "codex" | "local"): Promise<void> { await this.send("remove", key) }
  close(): void {
    const child = this.child
    this.fail()
    child?.stdin.end(); child?.kill()
  }
}
