import { getModelCapability, isReasoningEffort } from "~/lib/model-capabilities"
import type { Model, ModelsResponse } from "~/providers/copilot/get-models"

const canUseCodex = (model: Model): boolean =>
  model.model_picker_enabled
  && model.capabilities.type === "chat"
  && model.capabilities.supports.tool_calls === true
  && (!model.policy || model.policy.state === "enabled")
  && (
    model.supported_endpoints?.includes("/responses") === true
    || getModelCapability(model.id) !== undefined
  )

export const toCodexModelCatalog = (catalog: ModelsResponse) => ({
  models: catalog.data.filter(canUseCodex).map((model, priority) => {
    const capability = getModelCapability(model.id)
    const { limits, supports } = model.capabilities
    const efforts = capability ?
        (supports.reasoning_effort ?? capability.reasoning?.supported ?? [])
          .filter((effort) => capability.reasoning?.supported.some((value) => value === effort))
      : (supports.reasoning_effort ?? []).filter(isReasoningEffort)
    const defaultEffort =
      capability?.reasoning && efforts.includes(capability.reasoning.default) ?
        capability.reasoning.default
      : efforts[0]
    const nativeResponses = capability?.fallback !== "chat-completions"

    return {
      slug: model.id,
      display_name: model.name,
      description: `${model.name} via GitHub Copilot`,
      default_reasoning_level: defaultEffort,
      supported_reasoning_levels: efforts.map((effort) => ({
        effort,
        description: `${effort} reasoning effort`,
      })),
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority,
      support_verbosity: false,
      default_reasoning_summary: "none",
      supports_parallel_tool_calls: supports.parallel_tool_calls === true,
      apply_patch_tool_type: nativeResponses ? "freeform" : undefined,
      tool_mode: "direct",
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [],
      input_modalities: supports.vision ? ["text", "image"] : ["text"],
      context_window: limits.max_context_window_tokens,
      // Copilot's prompt budget can be lower than its total context window.
      auto_compact_token_limit: limits.max_prompt_tokens ?
          Math.floor(limits.max_prompt_tokens * 0.9)
        : undefined,
      include_apps_usage_instructions: false,
      // Codex requires an instruction source when decoding a remote catalog.
      base_instructions:
        "You are a coding assistant working in the user's workspace. Follow the user's instructions, use the available tools when needed, and verify changes before reporting completion.",
    }
  }),
})
