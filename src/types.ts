/**
 * Configuration interfaces for the GitHub Copilot AI SDK provider.
 *
 * These types bridge the AI SDK v3 provider contract with the options
 * accepted by @github/copilot-sdk's CopilotClient constructor, allowing
 * callers to configure connection, auth, and logging at provider-creation time.
 */

/**
 * Settings for creating a GitHub Copilot AI SDK provider instance.
 * These map directly to CopilotClientOptions from @github/copilot-sdk.
 *
 * @example
 * ```ts
 * import { createCopilotProvider } from '@/provider';
 *
 * const copilot = createCopilotProvider({
 *   gitHubToken: process.env.GITHUB_TOKEN,
 *   logLevel: 'warning',
 * });
 * ```
 */
export interface CopilotProviderSettings {
  /**
   * Path to the GitHub Copilot CLI executable.
   * When omitted, the SDK uses the bundled CLI from @github/copilot.
   */
  cliPath?: string;

  /**
   * URL of an existing Copilot CLI server to connect to.
   * Format: "host:port", e.g. "localhost:4321".
   * When set, the SDK will not spawn a new CLI process.
   */
  cliUrl?: string;

  /**
   * GitHub personal access token for authentication.
   * When provided, this takes priority over the logged-in GitHub CLI user.
   */
  gitHubToken?: string;

  /**
   * Log level for the Copilot CLI server process.
   * @default 'info'
   */
  logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
}

/**
 * Per-model settings when constructing a CopilotLanguageModel instance.
 * Reserved for future per-model configuration options.
 */
// biome-ignore lint/complexity/noBannedTypes: intentionally empty — reserved for future per-model options
export type CopilotModelSettings = {};
