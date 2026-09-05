import { Hono } from "hono"

import { toCodexModelCatalog } from "~/bridges/codex/models"
import type { BridgeEnv } from "~/lib/config"
import { BridgeNotImplementedError } from "~/lib/error"
import type { ModelsResponse } from "~/providers/copilot/get-models"
import {
  fetchCopilot,
  getCopilotProviderContext,
} from "~/providers/copilot/client"

export const modelRoutes = new Hono<BridgeEnv>()

modelRoutes.get("/", async (c) => {
  const config = c.get("config")
  const provider = getCopilotProviderContext(config)
  const search = new URL(c.req.url).search

  try {
    const upstream = await fetchCopilot(provider, `/models${search}`, {
      method: "GET",
      headers: {
        accept: c.req.header("accept") ?? "application/json",
      },
    })

    // Codex's versioned catalog uses ModelInfo entries, not OpenAI's data list.
    if (upstream.ok && c.req.query("client_version") !== undefined) {
      const catalog = await upstream.json() as ModelsResponse
      return c.json(toCodexModelCatalog(catalog))
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (error) {
    if (error instanceof BridgeNotImplementedError) {
      return c.json(
        {
          error: {
            type: error.name,
            message: error.message,
          },
        },
        500,
      )
    }

    throw error
  }
})
