import type { OAuthAuth, OAuthCredential, AuthPrompt } from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import type { SecretStore } from "./credentials"
import { GatewayError } from "./types"
import { createHash } from "node:crypto"

registerBunOAuthFlows()
export interface CodexLoginState {
  state: "disconnected" | "connected" | "signing-in" | "error"
  message?: string
  url?: string
  code?: string
  awaitingCode?: boolean
  canCancel?: boolean
  accountFingerprint?: string
  accountLabel?: string
}
export function accountFingerprint(value: OAuthCredential): string {
  return createHash("sha256").update(String(value.accountId)).digest("hex")
}
function credential(value: unknown): OAuthCredential | undefined {
  if (value === undefined || value === null) return undefined
  const c = value as OAuthCredential
  if (c.type !== "oauth" || typeof c.access !== "string" || !c.access || c.access.length > 32768
    || typeof c.refresh !== "string" || !c.refresh || c.refresh.length > 32768
    || !Number.isFinite(c.expires) || typeof c.accountId !== "string" || !c.accountId || c.accountId.length > 512)
    throw new GatewayError(401, "invalid_credential", "Stored Codex credentials are invalid. Reconnect your account.")
  return c
}

export class CodexAuth {
  private loginState: CodexLoginState = { state: "disconnected" }
  private queue: Promise<unknown> = Promise.resolve()
  private active?: AbortController
  private answer?: { resolve(value: string): void; reject(error: Error): void }
  private generation = 0
  private committing = false
  private store: SecretStore
  private oauth: OAuthAuth
  onChange?: () => void
  constructor(store: SecretStore, oauth: OAuthAuth = openaiCodexProvider().auth.oauth!) {
    this.store = store; this.oauth = oauth
  }
  snapshot(): CodexLoginState {
    return { ...this.loginState, ...(this.loginState.state === "signing-in" ? { canCancel: !this.committing } : {}) }
  }
  private connected(value: OAuthCredential): void {
    this.loginState = {
      state: "connected", accountFingerprint: accountFingerprint(value),
      accountLabel: "Account …" + String(value.accountId).slice(-8),
    }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }
  async restore(): Promise<void> {
    const generation = this.generation
    try {
      const found = credential(await this.exclusive(() => this.store.read("codex")))
      if (!this.active && generation === this.generation) {
        if (found) this.connected(found)
        else this.loginState = { state: "disconnected" }
      }
    } catch {
      if (generation === this.generation)
        this.loginState = { state: "error", message: "Could not read Codex credentials from Keychain." }
    }
  }
  async credentials(forceRefresh = false, rejectedAccessToken?: string): Promise<OAuthCredential> {
    return this.exclusive(async () => {
      let current = credential(await this.store.read("codex"))
      if (!current) throw new GatewayError(401, "codex_not_connected", "Connect a Codex subscription in Codex Bridge.")
      if ((forceRefresh && (!rejectedAccessToken || current.access === rejectedAccessToken))
        || current.expires <= Date.now() + 60_000) {
        try {
          current = credential(await this.oauth.refresh(current, AbortSignal.timeout(30_000)))!
          // Persistence must succeed before an inference uses the rotated token.
          await this.store.write("codex", current)
        } catch {
          this.loginState = { state: "error", message: "Codex authentication could not be refreshed. Reconnect if the problem persists." }
          throw new GatewayError(401, "codex_refresh_failed", this.loginState.message!)
        }
      }
      if (!this.active) this.connected(current)
      return current
    })
  }
  start(method: "browser" | "device" = "browser"): void {
    this.cancel()
    const controller = new AbortController(), generation = ++this.generation
    this.active = controller
    this.loginState = { state: "signing-in", message: "Preparing secure Codex sign-in…" }
    const prompt = async (p: AuthPrompt): Promise<string> => {
      if (p.type === "select") {
        const option = p.options.find(o => method === "device" ? /device/i.test(o.label) : /browser/i.test(o.label))
        if (!option) throw new Error("Login method unavailable")
        return option.id
      }
      if (p.type !== "manual_code") throw new Error("Unsupported login interaction")
      this.loginState.awaitingCode = true
      return new Promise((resolve, reject) => {
        const abort = () => { this.answer = undefined; reject(new Error("Cancelled")) }
        p.signal?.addEventListener("abort", abort, { once: true })
        controller.signal.addEventListener("abort", abort, { once: true })
        if (p.signal?.aborted || controller.signal.aborted) { abort(); return }
        this.answer = {
          resolve: value => {
            p.signal?.removeEventListener("abort", abort)
            controller.signal.removeEventListener("abort", abort)
            this.answer = undefined; resolve(value)
          }, reject,
        }
      })
    }
    void this.oauth.login({
      signal: controller.signal, prompt,
      notify: event => {
        if (controller.signal.aborted || generation !== this.generation) return
        if (event.type === "auth_url") {
          const url = new URL(event.url)
          if (url.protocol !== "https:" || url.hostname !== "auth.openai.com")
            throw new Error("Unexpected authorization endpoint")
          this.loginState = { state: "signing-in", url: event.url, message: "Complete sign-in in your browser." }
        } else if (event.type === "device_code") {
          const url = new URL(event.verificationUri)
          if (url.protocol !== "https:" || url.hostname !== "auth.openai.com")
            throw new Error("Unexpected device authorization endpoint")
          this.loginState = { state: "signing-in", url: event.verificationUri, code: event.userCode,
            message: "Enter this code on OpenAI's authorization page." }
        }
      },
    }).then(value => this.exclusive(async () => {
      if (controller.signal.aborted || generation !== this.generation) return
      const valid = credential(value)!
      // Keychain writes cannot be cancelled atomically. Once committing starts,
      // reject a user Cancel with 409 rather than claiming cancellation and then
      // unexpectedly saving that account. Logout still queues removal after it.
      this.committing = true
      this.loginState.message = "Finishing secure sign-in…"
      try {
        await this.store.write("codex", valid)
        if (controller.signal.aborted || generation !== this.generation) return
        this.connected(valid)
        this.loginState.message = "Codex account connected independently of Codex App."
        this.onChange?.()
      } finally { this.committing = false }
    })).catch(() => {
      if (!controller.signal.aborted && generation === this.generation)
        this.loginState = { state: "error", message: "Codex sign-in failed. Retry or use device-code sign-in." }
    }).finally(() => {
      if (this.active === controller) { this.active = undefined; this.answer = undefined }
    })
  }
  respond(value: string): void {
    if (!this.answer || value.length > 8192)
      throw new GatewayError(409, "no_login_prompt", "No authorization callback is pending.")
    this.answer.resolve(value)
  }
  cancel(force = false): void {
    if (this.committing && !force)
      throw new GatewayError(409, "login_commit_in_progress", "Secure sign-in is already being saved. Wait for completion, then Disconnect if needed.")
    ++this.generation
    this.active?.abort(); this.active = undefined
    this.answer?.reject(new Error("Cancelled")); this.answer = undefined
    if (this.loginState.state === "signing-in") this.loginState = { state: "disconnected", message: "Sign-in cancelled." }
  }
  async logout(): Promise<void> {
    this.cancel(true)
    await this.exclusive(() => this.store.remove("codex"))
    this.loginState = { state: "disconnected" }
  }
}
