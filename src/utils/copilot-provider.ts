/**
 * copilot-provider.ts
 *
 * Exports the `CopilotProvider` interface and the `createCopilot` factory
 * function that builds a provider satisfying the AI SDK `ProviderV3` contract.
 *
 * Design overview
 * ───────────────
 * The AI SDK `ProviderV3` interface describes a *stateless* model registry:
 * call `provider.languageModel(id)` (or the callable shorthand `provider(id)`)
 * to get a model object, then call `doGenerate` / `doStream` on that object.
 *
 * This file wires the three pieces together:
 *   1. Provider-level settings (auth token, CLI URL, …) captured at
 *      `createCopilot()` call time and shared by every model.
 *   2. Per-model settings (system prompt, temperature, …) that can be passed
 *      alongside the model ID.
 *   3. `CopilotLanguageModel` — the actual LanguageModelV3 implementation that
 *      does the heavy lifting using `@github/copilot-sdk`.
 */

import type { ProviderV3 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import { CopilotLanguageModel } from "@utils/copilot-language-model";
import type { CopilotModelSettings, CopilotProviderSettings } from "@/types";

// ─── Public Interface ────────────────────────────────────────────────────────

/**
 * A GitHub Copilot AI SDK provider.
 *
 * `CopilotProvider` extends `ProviderV3` with two enhancements:
 *  - It is **callable**: `provider('gpt-4.1')` is shorthand for
 *    `provider.languageModel('gpt-4.1')`.
 *  - `languageModel` accepts an optional second argument for per-model
 *    settings (e.g. system prompt, temperature) in addition to the model ID.
 *
 * All other model types (embedding, image, …) are unsupported and will throw
 * a `NoSuchModelError` when accessed.
 *
 * @example
 * ```ts
 * import { copilot } from 'ai-sdk-github-copilot';
 *
 * // Call the provider directly — equivalent to copilot.languageModel('gpt-4.1')
 * const model = copilot('gpt-4.1');
 * ```
 */
export interface CopilotProvider extends ProviderV3 {
  /**
   * Returns a `CopilotLanguageModel` for the given model ID.
   * Per-model `settings` are merged with the provider-level configuration
   * supplied to `createCopilot`.
   *
   * @param modelId  - A Copilot model identifier, e.g. `'claude-sonnet-4.5'`.
   * @param settings - Optional per-model overrides.
   */
  languageModel(
    modelId: string,
    settings?: CopilotModelSettings
  ): CopilotLanguageModel;
  /**
   * Call the provider as a function to obtain a `CopilotLanguageModel`.
   * Shorthand for `provider.languageModel(modelId, settings)`.
   *
   * @param modelId  - A Copilot model identifier, e.g. `'gpt-4.1'`.
   * @param settings - Optional per-model overrides (system prompt, etc.).
   */
  (modelId: string, settings?: CopilotModelSettings): CopilotLanguageModel;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a GitHub Copilot provider that satisfies the AI SDK `ProviderV3`
 * interface and can be used with `generateText`, `streamText`, and other AI
 * SDK functions.
 *
 * Under the hood every `doGenerate` / `doStream` call:
 *  1. Starts (or reuses) a `CopilotClient` from `@github/copilot-sdk`.
 *  2. Opens a short-lived `CopilotSession` for the requested model.
 *  3. Sends the prompt and collects the response.
 *  4. Maps the result back to the AI SDK stream/generate shape.
 *
 * @param settings - Optional provider-level configuration shared by all models
 *   vended by this instance. Includes `gitHubToken`, `cliUrl`, `logLevel`, etc.
 *   When omitted the provider relies on the locally authenticated Copilot CLI.
 *
 * @returns A {@link CopilotProvider} that is also callable as a function.
 *
 * @example
 * ```ts
 * import { createCopilot } from 'ai-sdk-github-copilot';
 *
 * const provider = createCopilot({
 *   gitHubToken: process.env.GITHUB_TOKEN,
 *   logLevel: 'error',
 * });
 *
 * const model = provider('gpt-4.1');
 * ```
 */
export function createCopilot(
  settings?: CopilotProviderSettings
): CopilotProvider {
  /**
   * Internal helper: constructs a `CopilotLanguageModel` that carries both
   * provider-level settings (captured via closure) and per-request model
   * settings.
   *
   * @param modelId       - The Copilot model identifier.
   * @param modelSettings - Optional per-call overrides for this model.
   */
  const createModel = (
    modelId: string,
    modelSettings?: CopilotModelSettings
  ): CopilotLanguageModel =>
    new CopilotLanguageModel(modelId, modelSettings ?? {}, settings ?? {});

  /**
   * The provider is implemented as a plain function so that users can write
   * `copilot('gpt-4.1')` instead of `copilot.languageModel('gpt-4.1')`.
   * All `ProviderV3` properties are then attached via `Object.assign`.
   */
  const provider = (
    modelId: string,
    modelSettings?: CopilotModelSettings
  ): CopilotLanguageModel => createModel(modelId, modelSettings);

  return Object.assign(provider, {
    /**
     * Required by `ProviderV3`. Identifies this as a v3-compatible provider
     * so the AI SDK runtime knows which interface version to use.
     */
    specificationVersion: "v3" as const,

    /**
     * Returns a `CopilotLanguageModel` for the given model ID, merging the
     * optional per-model settings with the provider-level configuration.
     */
    languageModel: (
      modelId: string,
      modelSettings?: CopilotModelSettings
    ): CopilotLanguageModel => createModel(modelId, modelSettings),

    /**
     * Embedding models are **not** supported by this provider.
     * Throws `NoSuchModelError` on every call so that the AI SDK can surface
     * a clear, actionable error to the caller.
     */
    embeddingModel: (modelId: string) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },

    /**
     * Image models are **not** supported by this provider.
     * Throws `NoSuchModelError` on every call.
     */
    imageModel: (modelId: string) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
  }) as unknown as CopilotProvider;
  // `as unknown as CopilotProvider` is necessary because TypeScript cannot
  // verify that the throw-returning `embeddingModel` / `imageModel` stubs
  // satisfy the EmbeddingModelV3 / ImageModelV3 return types from ProviderV3
  // without widening through `unknown` first. The cast is safe: callers
  // receive a `NoSuchModelError` before any return value is ever used.
}

// ─── Default Instance ─────────────────────────────────────────────────────────

/**
 * A ready-to-use GitHub Copilot provider instance with default settings.
 *
 * This instance relies on the Copilot CLI being installed on `$PATH` and the
 * user being authenticated (via `gh auth login` or the `GITHUB_TOKEN`
 * environment variable).
 *
 * For custom auth or connection settings use `createCopilot(settings)` instead.
 *
 * @example
 * ```ts
 * import { generateText } from 'ai';
 * import { copilot } from 'ai-sdk-github-copilot';
 *
 * const { text } = await generateText({
 *   model: copilot('gpt-4.1'),
 *   prompt: 'What year was TypeScript first released?',
 * });
 * ```
 */
export const copilot = createCopilot();
