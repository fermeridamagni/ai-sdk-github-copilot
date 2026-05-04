/**
 * main.ts — package entry point
 *
 * Re-exports the complete public API of `ai-sdk-github-copilot` so that
 * consumers only need a single import path:
 *
 * ```ts
 * import { copilot, createCopilot } from 'ai-sdk-github-copilot';
 * import type { CopilotProvider, CopilotProviderSettings } from 'ai-sdk-github-copilot';
 * ```
 *
 * Barrel structure
 * ────────────────
 *  copilot-provider  ─  CopilotProvider interface, createCopilot factory,
 *                       and the default `copilot` instance.
 *  copilot-language-model  ─  CopilotLanguageModel class (LanguageModelV3 impl).
 *  types  ─  CopilotProviderSettings and CopilotModelSettings interfaces.
 */

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * `CopilotProvider` — the interface type returned by `createCopilot`.
 * Use this when you need to type a variable that holds a provider instance.
 */
export type { CopilotProvider } from "@utils/copilot-provider";

/**
 * `createCopilot` — factory function for building a configured provider.
 * `copilot`       — the default provider instance, ready to use out of the box.
 */
// biome-ignore lint/performance/noBarrelFile: main.ts is the declared package entry point (package.json "module"/"types"). Aggregating the public API here is intentional and required for library consumers.
export { copilot, createCopilot } from "@utils/copilot-provider";

// ─── Language Model ───────────────────────────────────────────────────────────

/**
 * `CopilotLanguageModel` — the `LanguageModelV3` implementation that backs
 * every model returned by `copilot(modelId)` or `provider.languageModel(modelId)`.
 *
 * Advanced use only: most consumers should interact with models through the AI
 * SDK's `generateText` / `streamText` functions rather than constructing a
 * `CopilotLanguageModel` directly.
 */
export { CopilotLanguageModel } from "@utils/copilot-language-model";

// ─── Settings Types ───────────────────────────────────────────────────────────

/**
 * `CopilotProviderSettings` — configuration options accepted by `createCopilot`.
 * `CopilotModelSettings`    — per-model overrides accepted by `languageModel`.
 */
export type {
  CopilotModelSettings,
  CopilotProviderSettings,
} from "@/types";
