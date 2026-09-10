#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { start } from "./start"
import { gateway } from "./gateway/main"

const main = defineCommand({
  meta: {
    name: "copilot-bridge",
    description:
      "Codex App model gateway for Codex subscription, GitHub Copilot and local Unsloth Studio.",
  },
  subCommands: { auth, start, gateway },
})

await runMain(main)
