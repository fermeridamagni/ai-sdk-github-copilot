/**
 * Core language model implementation for GitHub Copilot via the AI SDK V3 provider interface.
 *
 * Each `doGenerate` / `doStream` call creates an isolated `CopilotClient` (CLI process) and
 * a dedicated single-turn session, so concurrent calls never share mutable state or process
 * handles. `client.stop()` is always called in a `finally` block (generate) or inside the
 * `closeStream` helper (stream) to ensure the CLI process is cleaned up regardless of outcome.
 *
 * @module copilot-language-model
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type { SessionEvent } from "@github/copilot-sdk";
import { approveAll, CopilotClient } from "@github/copilot-sdk";
import {
  convertToPrompt,
  extractSystemMessage,
} from "@utils/convert-to-copilot-prompt";
import type { CopilotModelSettings, CopilotProviderSettings } from "@/types";

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Mutable state threaded through the stream event handler and the
 * `closeStream` helper so both can coordinate without a shared closure.
 */
interface CopilotStreamState {
  /** True once the stream has been finalised (success or error). */
  closed: boolean;
  /**
   * Set to the unsubscribe function returned by `session.on()` after it is
   * registered. Calling it stops event delivery before the stream closes.
   */
  unsubscribe: (() => void) | undefined;
}

/**
 * Maps a single Copilot `SessionEvent` to one or more AI SDK V3 stream parts.
 *
 * Extracted from the `ReadableStream` `start` callback to keep that callback's
 * cognitive complexity within the project's 20-branch limit. The function is
 * pure with respect to the stream controller — it only reads from `state` and
 * the open-ID sets, never from external async resources.
 *
 * @param event         - The session event to handle.
 * @param controller    - Stream controller to enqueue parts into.
 * @param openTextIds   - Text-block IDs opened with `text-start` awaiting `text-end`.
 * @param openReasoningIds - Reasoning-block IDs opened with `reasoning-start` awaiting `reasoning-end`.
 * @param state         - Shared mutable state (closed flag and unsubscribe reference).
 * @param closeStream   - Finalises and closes the stream, optionally with an error.
 */
function handleCopilotStreamEvent(
  event: SessionEvent,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  openTextIds: Set<string>,
  openReasoningIds: Set<string>,
  state: CopilotStreamState,
  closeStream: (error?: unknown) => void
): void {
  // assistant.message_delta — incremental text from the model.
  if (event.type === "assistant.message_delta") {
    const { messageId, deltaContent } = event.data;
    if (!openTextIds.has(messageId)) {
      openTextIds.add(messageId);
      controller.enqueue({ type: "text-start", id: messageId });
    }
    controller.enqueue({
      type: "text-delta",
      id: messageId,
      delta: deltaContent,
    });
    return;
  }

  // assistant.reasoning_delta — incremental extended-thinking text.
  if (event.type === "assistant.reasoning_delta") {
    const { reasoningId, deltaContent } = event.data;
    if (!openReasoningIds.has(reasoningId)) {
      openReasoningIds.add(reasoningId);
      controller.enqueue({ type: "reasoning-start", id: reasoningId });
    }
    controller.enqueue({
      type: "reasoning-delta",
      id: reasoningId,
      delta: deltaContent,
    });
    return;
  }

  // assistant.message — full message received; close all open text/reasoning blocks.
  if (event.type === "assistant.message") {
    for (const id of openTextIds) {
      controller.enqueue({ type: "text-end", id });
    }
    openTextIds.clear();
    for (const id of openReasoningIds) {
      controller.enqueue({ type: "reasoning-end", id });
    }
    openReasoningIds.clear();
    return;
  }

  // session.idle — the agentic turn is complete; emit finish and close the stream.
  if (event.type === "session.idle") {
    // Copilot does not expose a raw finish-reason string through the event API.
    const finishReason: LanguageModelV3FinishReason = {
      unified: "stop",
      raw: undefined,
    };
    // Token usage is unavailable in streaming events; report undefined to avoid zeros.
    const usage: LanguageModelV3Usage = {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
    controller.enqueue({ type: "finish", finishReason, usage });
    state.unsubscribe?.();
    closeStream();
    return;
  }

  // session.error — emit an error part and close the stream.
  if (event.type === "session.error") {
    state.unsubscribe?.();
    closeStream(new Error(event.data.message));
  }
}

// ---------------------------------------------------------------------------
// CopilotLanguageModel class
// ---------------------------------------------------------------------------

/**
 * Implements the AI SDK `LanguageModelV3` interface for GitHub Copilot.
 *
 * Each call to `doGenerate` or `doStream` spawns a fresh `CopilotClient` (which manages
 * the Copilot CLI process) and a dedicated session for that single turn, ensuring clean
 * process lifecycles and isolation between concurrent calls.
 *
 * @example
 * ```ts
 * const model = new CopilotLanguageModel("gpt-4o", {}, { gitHubToken: "ghp_..." });
 * const result = await model.doGenerate({ prompt: [...] });
 * console.log(result.content); // [{ type: "text", text: "..." }]
 * ```
 */
export class CopilotLanguageModel implements LanguageModelV3 {
  /** AI SDK V3 interface version tag — must be the literal `"v3"`. */
  readonly specificationVersion = "v3" as const;

  /** Provider identifier surfaced to the AI SDK and its telemetry layer. */
  readonly provider = "github-copilot";

  /** The Copilot model ID to target (e.g. `"gpt-4o"`, `"claude-sonnet-4.5"`). */
  readonly modelId: string;

  /**
   * Copilot does not expose downloadable media URLs, so this map is empty.
   * The field satisfies the `LanguageModelV3` contract without enabling URL pass-through.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /**
   * Per-model settings spread into every `createSession` call.
   * This allows callers to pass optional `SessionConfig` fields such as
   * `reasoningEffort` or `modelCapabilities` as part of the model definition.
   */
  private readonly settings: CopilotModelSettings;

  /** Client-level options forwarded to every `CopilotClient` instance. */
  private readonly clientOptions: CopilotProviderSettings;

  constructor(
    modelId: string,
    settings: CopilotModelSettings,
    clientOptions: CopilotProviderSettings
  ) {
    this.modelId = modelId;
    this.settings = settings;
    this.clientOptions = clientOptions;
  }

  /**
   * Constructs a new `CopilotClient` from the provider-level settings.
   *
   * A fresh client is created on every `doGenerate` / `doStream` call so each
   * invocation runs in its own isolated CLI process. The caller **must** call
   * `client.stop()` in a `finally` block to release the process.
   */
  private createClient(): CopilotClient {
    return new CopilotClient(this.clientOptions);
  }

  /**
   * Performs a single, non-streaming generation turn.
   *
   * Creates a short-lived Copilot session, sends the prompt, awaits the complete
   * assistant reply via `session.sendAndWait`, and converts the result into the AI
   * SDK `LanguageModelV3GenerateResult` shape.
   *
   * The session is configured with `streaming: false` so the CLI accumulates the
   * full response before delivering it. If the caller provides an `AbortSignal`,
   * `session.abort()` is called as soon as the signal fires.
   *
   * @param options - Call options including the structured prompt, optional abort
   *   signal, and generation parameters (unused Copilot-unsupported parameters are
   *   silently ignored).
   * @returns The generated content blocks, finish reason, token usage, and an empty
   *   warnings array (Copilot does not surface per-call warnings through this API).
   */
  async doGenerate(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> {
    const { prompt, abortSignal } = options;

    // Convert the AI SDK structured prompt into a flat string and extract any
    // system-level instructions so they can be forwarded to the session config.
    const systemMessageContent = extractSystemMessage(prompt);
    const userPrompt = convertToPrompt(prompt);

    const client = this.createClient();

    try {
      const session = await client.createSession({
        // Model-level overrides (e.g. reasoningEffort) take the lowest precedence;
        // the required fields below will always win if there is a conflict.
        ...this.settings,
        onPermissionRequest: approveAll,
        model: this.modelId,
        streaming: false,
        // Only set systemMessage when there is content to add; omitting it
        // lets the Copilot SDK keep its default system prompt intact.
        ...(systemMessageContent == null
          ? {}
          : {
              systemMessage: {
                mode: "append" as const,
                content: systemMessageContent,
              },
            }),
      });

      // Register the abort handler before sending so cancellation is never missed,
      // even if the AbortSignal is already in the "aborted" state.
      const abortHandler = (): void => {
        // Fire-and-forget: the session remains usable after abort, but since this
        // is a single-turn call, we don't need to handle the returned promise.
        session.abort();
      };
      abortSignal?.addEventListener("abort", abortHandler, { once: true });

      let result: Awaited<ReturnType<typeof session.sendAndWait>>;
      try {
        // Wait up to 5 minutes. This high ceiling is intentional because agentic
        // turns on complex prompts can take substantial time.
        result = await session.sendAndWait({ prompt: userPrompt }, 300_000);
      } finally {
        // Always remove the listener to prevent a memory leak when the promise
        // settles before the abort signal fires.
        abortSignal?.removeEventListener("abort", abortHandler);
      }

      // Build the ordered content array from the assistant response.
      // Reasoning text (if present) is placed after the main text so consumers
      // can trim the tail when extended-thinking output is not needed.
      const content: LanguageModelV3Content[] = [];
      if (result?.data.content) {
        content.push({ type: "text", text: result.data.content });
      }
      if (result?.data.reasoningText) {
        content.push({ type: "reasoning", text: result.data.reasoningText });
      }

      // Copilot does not expose a raw finish-reason string through this API.
      const finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: undefined,
      };

      // Input token counts are not available via `sendAndWait`; only the output
      // token count is reported through `AssistantMessageEvent.data.outputTokens`.
      const usage: LanguageModelV3Usage = {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: result?.data.outputTokens,
          text: undefined,
          reasoning: undefined,
        },
      };

      const warnings: SharedV3Warning[] = [];

      return { content, finishReason, usage, warnings };
    } finally {
      // Unconditionally stop the CLI process to avoid zombie processes.
      await client.stop();
    }
  }

  /**
   * Performs a streaming generation turn.
   *
   * Creates a short-lived Copilot session with streaming enabled, subscribes to
   * all session events via `session.on()`, and maps them onto AI SDK V3 stream
   * parts inside a `ReadableStream`. The stream is returned immediately; data flows
   * asynchronously from the CLI process.
   *
   * **Stream lifecycle:**
   * 1. `{ type: "stream-start", warnings: [] }` — enqueued synchronously.
   * 2. `assistant.message_delta` events open a text block on first delta per
   *    `messageId`, then emit `text-delta` parts.
   * 3. `assistant.reasoning_delta` events similarly open/emit reasoning blocks.
   * 4. `assistant.message` closes all open text and reasoning blocks.
   * 5. `session.idle` emits `finish` and closes the stream cleanly.
   * 6. `session.error` emits `error` and closes the stream.
   *
   * `client.stop()` is called on every terminal path. A `closed` boolean flag
   * inside `CopilotStreamState` prevents double-close when multiple terminal
   * conditions fire concurrently (e.g. `session.idle` and an `AbortSignal`).
   *
   * @param options - Call options including the structured prompt and abort signal.
   * @returns An object whose `stream` property carries the AI SDK V3 stream parts.
   */
  async doStream(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3StreamResult> {
    const { prompt, abortSignal } = options;

    const systemMessageContent = extractSystemMessage(prompt);
    const userPrompt = convertToPrompt(prompt);

    const client = this.createClient();

    // Await session creation before constructing the ReadableStream so that the
    // `start` callback can call `session.send()` immediately without an extra
    // async boundary that could cause early events to be missed.
    const session = await client.createSession({
      ...this.settings,
      onPermissionRequest: approveAll,
      model: this.modelId,
      streaming: true,
      ...(systemMessageContent == null
        ? {}
        : {
            systemMessage: {
              mode: "append" as const,
              content: systemMessageContent,
            },
          }),
    });

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        /**
         * Shared state between the event handler (`session.on`) and the close
         * helper so both can read/write `closed` and `unsubscribe` atomically.
         */
        const state: CopilotStreamState = {
          closed: false,
          unsubscribe: undefined,
        };

        /** Text-block IDs opened with `text-start` awaiting `text-end`. */
        const openTextIds = new Set<string>();

        /** Reasoning-block IDs opened with `reasoning-start` awaiting `reasoning-end`. */
        const openReasoningIds = new Set<string>();

        /**
         * Optionally enqueues an `error` part, closes the controller, and stops
         * the Copilot CLI. The `state.closed` guard prevents double-close.
         */
        const closeStream = (error?: unknown): void => {
          if (state.closed) {
            return;
          }
          state.closed = true;
          if (error !== undefined) {
            controller.enqueue({ type: "error", error });
          }
          controller.close();
          // `client.stop()` is async; we intentionally do not await it here
          // so that the stream consumer is never blocked on CLI teardown.
          client.stop();
        };

        // First required part of the V3 stream protocol.
        controller.enqueue({ type: "stream-start", warnings: [] });

        // Subscribe to all session events. The unsubscribe function is stored in
        // `state` so the event handler itself can call it before closing the stream.
        state.unsubscribe = session.on((event) => {
          if (state.closed) {
            return;
          }
          handleCopilotStreamEvent(
            event,
            controller,
            openTextIds,
            openReasoningIds,
            state,
            closeStream
          );
        });

        // Handle external cancellation via AbortSignal.
        if (abortSignal != null) {
          const abortHandler = (): void => {
            state.unsubscribe?.();
            // Attempt graceful abort; close the stream once it settles (success or
            // failure), passing the original abort reason as the error value.
            session.abort().finally(() => {
              closeStream(abortSignal.reason);
            });
          };
          abortSignal.addEventListener("abort", abortHandler, { once: true });
        }

        // Kick off the turn. Errors from `send()` itself (e.g. connection failures
        // before any event fires) are caught and forwarded to the stream.
        session.send({ prompt: userPrompt }).catch((error: unknown) => {
          if (!state.closed) {
            state.unsubscribe?.();
            closeStream(error);
          }
        });
      },
    });

    return { stream };
  }
}
