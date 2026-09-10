import { z } from "zod"
import { normalizeEndpoint } from "./http"
import { GatewayError } from "./types"
import type { SecretStore } from "./credentials"

const schema = z.object({
  codexEnabled: z.boolean().default(true),
  copilotEnabled: z.boolean().default(true),
  localEnabled: z.boolean().default(false),
  localURL: z.string().max(2048).default(""),
  localRequiresKey: z.boolean().default(false),
  copilotModelOverride: z.string().max(128).refine(s => !/[\r\n]/.test(s)).default(""),
  debug: z.boolean().default(false),
  rateLimitSeconds: z.number().int().min(0).max(3600).default(0),
  rateLimitWait: z.boolean().default(false),
  autoMode: z.boolean().default(false),
}).strict()

export function gatewaySettings(value: unknown) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new GatewayError(400, "invalid_settings", "The gateway settings file contains invalid fields or types.")
  const settings = parsed.data
  if (settings.localEnabled || settings.localURL) normalizeEndpoint(settings.localURL)
  return settings
}

/** A key saved for one URL must not follow a settings change to another host. */
export async function readLocalKey(store: SecretStore, endpoint: URL): Promise<string | undefined> {
  const value = await store.read("local")
  if (!value || typeof value !== "object") return undefined
  const record = value as { version?: unknown; endpoint?: unknown; value?: unknown }
  if (record.version !== 1 || record.endpoint !== endpoint.href || typeof record.value !== "string"
    || !record.value || record.value.length > 32768 || /[\r\n]/.test(record.value)) return undefined
  return record.value
}
