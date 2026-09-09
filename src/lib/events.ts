export const BRIDGE_EVENT_PREFIX = "@@CBM:"

/** Opt-in, bounded metadata channel for native supervisors. Never include prompts or tokens. */
export const emitBridgeEvent = (event: object): void => {
  const channel = process.env.COPILOT_BRIDGE_EVENTS_TOKEN
  if (!channel) return
  process.stdout.write(`${BRIDGE_EVENT_PREFIX}${JSON.stringify({ ...event, channel })}\n`)
}

export const bridgeEventsEnabled = (): boolean =>
  Boolean(process.env.COPILOT_BRIDGE_EVENTS_TOKEN)
