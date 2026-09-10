import { readFile } from "node:fs/promises"
import { defineCommand } from "citty"
import { serve } from "@hono/node-server"
import { readBridgeConfig } from "~/lib/config"
import { setupBridgeAuth } from "~/lib/auth"
import { configureProxyFromEnv } from "~/lib/proxy"
import { emitBridgeEvent } from "~/lib/events"
import { runtimeState } from "~/lib/state"
import { enableAutoMode } from "~/lib/auto-session"
import { CodexAuth } from "./codex-auth"
import { KeychainBrokerStore } from "./credentials"
import { CodexProvider } from "./codex"
import { CopilotProvider } from "./copilot"
import { LocalProvider } from "./local"
import { createGateway } from "./server"
import { gatewaySettings, readLocalKey } from "./settings"

export const gateway = defineCommand({
  meta: { name: "gateway", description: "Run the Codex App multi-provider gateway." },
  args: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4142" },
    settings: { type: "string", description: "Native application's non-secret gateway settings JSON." },
  },
  async run({ args }) {
    const port = Number(args.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535
      || !["127.0.0.1", "0.0.0.0"].includes(args.host)) throw new Error("Invalid gateway listening address or port.")
    const cfg = readBridgeConfig({ host: args.host, port })
    let value: unknown = {}
    if (args.settings) {
      const raw = await readFile(args.settings, "utf8")
      if (raw.length > 65536) throw new Error("Gateway settings are too large.")
      value = JSON.parse(raw)
    }
    const settings = gatewaySettings(value)
    if (settings.localEnabled && typeof settings.localURL === "string") {
      // Keep the explicitly configured local inference endpoint out of the
      // cloud HTTP proxy path; no credentials or prompts should traverse it.
      const host = new URL(settings.localURL).hostname
      process.env.NO_PROXY = [...new Set([...(process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(","), host])].filter(Boolean).join(",")
      delete process.env.no_proxy
    }
    configureProxyFromEnv()
    runtimeState.debug = settings.debug === true
    runtimeState.rateLimitSeconds = Number.isInteger(settings.rateLimitSeconds) && settings.rateLimitSeconds > 0
      && settings.rateLimitSeconds <= 3600 ? settings.rateLimitSeconds : undefined
    runtimeState.rateLimitWait = settings.rateLimitWait === true
    const store = new KeychainBrokerStore(process.env.CODEX_BRIDGE_CREDENTIAL_HELPER)
    const auth = new CodexAuth(store)
    const official = new CodexProvider(auth, settings.codexEnabled !== false)
    const copilot = new CopilotProvider(cfg, settings.copilotEnabled !== false)
    const local = new LocalProvider({ enabled: settings.localEnabled, url: settings.localURL,
      requiresKey: settings.localRequiresKey })
    if (typeof settings.copilotModelOverride === "string" && settings.copilotModelOverride)
      runtimeState.modelOverride = settings.copilotModelOverride
    const { app, refresh } = createGateway({
      providers: [official, copilot, local], auth,
      secrets: store, localEndpoint: local.endpoint?.href,
      onLocalKeyChange: value => { local.requireApiKey(Boolean(value)); local.setApiKey(value) },
      controlToken: process.env.CODEX_BRIDGE_CONTROL_TOKEN ?? "",
      instance: process.env.COPILOT_BRIDGE_INSTANCE_ID,
      onAuthChange: () => { official.invalidate(); void refresh("0.153.4", true) },
    })
    auth.onChange = () => { official.invalidate(); void refresh("0.153.4", true) }
    const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port })
    server.on("error", () => {
      emitBridgeEvent({ kind: "fatal", message: "Codex Bridge could not bind its listening port." })
      store.close(); process.exit(1)
    })
    const timer = setInterval(() => { void refresh() }, 30_000)
    timer.unref()
    const shutdown = () => { clearInterval(timer); auth.cancel(); store.close(); server.close(); setTimeout(() => process.exit(0), 5000).unref() }
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown)
    // Listen before any optional account/network dependency. Local must not
    // become unavailable because a cloud account is disconnected.
    if (official.enabled) void auth.restore().then(() => refresh("0.153.4", true))
    if (local.enabled && local.endpoint && settings.localRequiresKey) {
      void readLocalKey(store, local.endpoint).then(key => {
        local.setApiKey(key); return refresh("0.153.4", true)
      }).catch(() => { console.warn("Local API credentials are unavailable. Other sources remain available.") })
    }
    if (copilot.enabled) {
      void setupBridgeAuth(cfg, { prompt: false }).then(async () => {
        if (settings.autoMode === true) await enableAutoMode(cfg)
        await refresh("0.153.4", true)
      })
        .catch(() => { console.warn("Copilot is not connected. Other sources remain available.") })
    }
    void refresh()
    console.log(`Codex Bridge listening on ${cfg.host}:${cfg.port}`)
  },
})
