/**
 * Utilities for converting an AI SDK v3 `LanguageModelV3Prompt` into the
 * flat-string format consumed by the @github/copilot-sdk session API.
 *
 * The Copilot SDK's `session.send()` accepts a single string. This module
 * bridges the structured AI SDK message array and that string contract by:
 *
 *   1. Extracting any system instructions with `extractSystemMessage` so the
 *      caller can pass them to `session.create({ instructions })`.
 *   2. Serialising the remaining conversational turns with `convertToPrompt`.
 *
 * @module convert-to-copilot-prompt
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Internal helpers — tool output serialisation
// ---------------------------------------------------------------------------

/**
 * Serialises a `LanguageModelV3ToolResultOutput` discriminated union to a
 * human-readable string suitable for embedding in a dialogue turn.
 *
 * Variant mapping:
 * - `text`             → value verbatim
 * - `error-text`       → value verbatim (errors surface as plain text)
 * - `json`             → JSON.stringify(value)
 * - `error-json`       → JSON.stringify(value)
 * - `execution-denied` → bracketed notice with optional reason
 * - `content`          → text items joined by newlines; binary items omitted
 */
function serializeToolOutput(output: LanguageModelV3ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") {
    return output.value;
  }

  if (output.type === "json" || output.type === "error-json") {
    return JSON.stringify(output.value);
  }

  if (output.type === "execution-denied") {
    // The tool call was blocked (e.g. the user denied a permission prompt).
    return output.reason == null
      ? "[Execution denied]"
      : `[Execution denied: ${output.reason}]`;
  }

  if (output.type === "content") {
    // Rich content arrays may contain text, file-data, and file-url items.
    // Only text items can be surfaced as plain text; binary/URL items are
    // omitted because the Copilot SDK prompt is a flat string.
    const textParts = output.value
      .filter(
        (item): item is Extract<typeof item, { type: "text" }> =>
          item.type === "text"
      )
      .map((item) => item.text);

    return textParts.join("\n");
  }

  // Forward-compatible fallback: emit a placeholder for future output variants
  // so the prompt remains valid even against newer AI SDK versions.
  return "[Unsupported output]";
}

// ---------------------------------------------------------------------------
// Internal helpers — per-role turn renderers
// ---------------------------------------------------------------------------

/**
 * Renders a single assistant content part to a string fragment.
 *
 * - `text` / `reasoning` → trimmed text (empty parts are dropped)
 * - `tool-call`           → `[Called toolName(args)]`
 * - `tool-result`         → `[Result from toolName: value]`
 * - `file`                → omitted (not representable as plain text)
 */
function renderAssistantPart(
  part:
    | LanguageModelV3TextPart
    | LanguageModelV3FilePart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
    | LanguageModelV3ToolResultPart
): string | null {
  if (part.type === "text" || part.type === "reasoning") {
    const trimmed = part.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (part.type === "tool-call") {
    // Compact annotation: [Called readFile({"path":"src/index.ts"})]
    return `[Called ${part.toolName}(${JSON.stringify(part.input)})]`;
  }

  if (part.type === "tool-result") {
    // Tool result inlined into the assistant turn (uncommon but valid).
    return `[Result from ${part.toolName}: ${serializeToolOutput(part.output)}]`;
  }

  // `file` parts and any future part types are intentionally omitted.
  return null;
}

/**
 * Renders a `role: 'user'` message as a `Human: …` block.
 *
 * File parts are silently omitted — the Copilot SDK prompt is a flat string
 * and does not support inline binary or URL-referenced content.
 *
 * Returns `null` when the message yields no renderable text.
 */
function renderUserTurn(
  content: ReadonlyArray<LanguageModelV3TextPart | LanguageModelV3FilePart>
): string | null {
  const text = content
    .filter((part): part is LanguageModelV3TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return text.length > 0 ? `Human: ${text}` : null;
}

/**
 * Renders a `role: 'assistant'` message as an `Assistant: …` block.
 *
 * The content may be a heterogeneous mix of text, reasoning traces, tool
 * invocations, and inlined tool results — each rendered by `renderAssistantPart`.
 *
 * Returns `null` when the message yields no renderable content.
 */
function renderAssistantTurn(
  content: ReadonlyArray<
    | LanguageModelV3TextPart
    | LanguageModelV3FilePart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
    | LanguageModelV3ToolResultPart
  >
): string | null {
  const parts = content
    .map(renderAssistantPart)
    .filter((s): s is string => s !== null);

  return parts.length > 0 ? `Assistant: ${parts.join("\n")}` : null;
}

/**
 * Renders a `role: 'tool'` message as one or more bracketed result annotations.
 *
 * Tool messages carry results produced by client-side tool execution after an
 * assistant turn requested them. `tool-approval-response` parts carry no
 * textual content and are silently omitted.
 *
 * Returns `null` when the message yields no renderable content.
 */
function renderToolTurn(
  content: ReadonlyArray<
    LanguageModelV3ToolResultPart | { type: "tool-approval-response" }
  >
): string | null {
  const parts = content
    .filter(
      (part): part is LanguageModelV3ToolResultPart =>
        part.type === "tool-result"
    )
    .map(
      (part) =>
        `[Result from ${part.toolName}: ${serializeToolOutput(part.output)}]`
    );

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Routes a single non-system message to the appropriate turn renderer.
 *
 * Returns `null` for roles that produce no output (e.g. unknown future roles).
 */
function renderTurn(message: LanguageModelV3Message): string | null {
  if (message.role === "user") {
    return renderUserTurn(message.content);
  }
  if (message.role === "assistant") {
    return renderAssistantTurn(message.content);
  }
  if (message.role === "tool") {
    return renderToolTurn(message.content);
  }
  // `system` was filtered out upstream; future roles are silently skipped.
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts and concatenates all `system`-role message contents from a prompt
 * into a single string, with constituent messages separated by `\n\n`.
 *
 * Returns `undefined` when the prompt contains no system messages.
 *
 * System instructions are surfaced to the Copilot SDK at session-creation
 * time (e.g. via `session.create({ instructions })`) rather than being
 * embedded in the conversational prompt string, so they must be separated
 * out before calling `convertToPrompt`.
 *
 * @example
 * ```ts
 * const systemPrompt = extractSystemMessage(prompt);
 * const userPrompt   = convertToPrompt(prompt);
 *
 * const session = await client.session.create({ instructions: systemPrompt });
 * await session.send(userPrompt);
 * ```
 */
export function extractSystemMessage(
  prompt: LanguageModelV3Prompt
): string | undefined {
  const parts: string[] = [];

  for (const message of prompt) {
    // TypeScript narrows `message.content` to `string` here because
    // `system` role has `content: string` in the LanguageModelV3Message union.
    if (message.role === "system") {
      parts.push(message.content);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Converts an AI SDK v3 `LanguageModelV3Prompt` into the flat string format
 * expected by the Copilot SDK's `session.send()` API.
 *
 * **System messages are excluded** — use `extractSystemMessage` to retrieve
 * them separately for session-level configuration.
 *
 * ### Rendering rules
 *
 * | Scenario | Output |
 * |---|---|
 * | Single user message, one text part | Raw text (no `Human:` prefix) |
 * | Multi-turn conversation | `Human: …` / `Assistant: …` blocks joined by `\n\n` |
 * | Tool-call part (inside an assistant message) | `[Called toolName(args)]` |
 * | Tool-result part (inside a `tool` message) | `[Result from toolName: result]` |
 * | File parts | Silently omitted (Copilot SDK does not support inline binary content) |
 *
 * @example Single-turn
 * ```ts
 * convertToPrompt([
 *   { role: 'user', content: [{ type: 'text', text: 'Explain async/await.' }] },
 * ]);
 * // => "Explain async/await."
 * ```
 *
 * @example Multi-turn with a tool call
 * ```ts
 * convertToPrompt([
 *   { role: 'user',      content: [{ type: 'text', text: 'List files.' }] },
 *   { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'readDir', input: { path: '.' } }] },
 *   { role: 'tool',      content: [{ type: 'tool-result', toolCallId: '1', toolName: 'readDir', output: { type: 'text', value: 'src/ tests/' } }] },
 *   { role: 'user',      content: [{ type: 'text', text: 'Thanks.' }] },
 * ]);
 * // =>
 * // "Human: List files.\n\nAssistant: [Called readDir({\"path\":\".\"})]"
 * // + "\n\n[Result from readDir: src/ tests/]\n\nHuman: Thanks."
 * ```
 */
export function convertToPrompt(prompt: LanguageModelV3Prompt): string {
  // Strip system messages — handled separately via session config.
  const conversation = prompt.filter((message) => message.role !== "system");

  // Fast-path: a single bare user text part needs no Human/Assistant prefixes.
  // This is the most common single-turn invocation pattern and avoids adding
  // labels that would alter the Copilot session prompt semantics.
  if (conversation.length === 1) {
    const [only] = conversation;
    if (
      only !== undefined &&
      only.role === "user" &&
      only.content.length === 1
    ) {
      const [firstPart] = only.content;
      if (firstPart !== undefined && firstPart.type === "text") {
        return firstPart.text;
      }
    }
  }

  // Multi-turn: delegate to per-role helpers, drop empty turns, join with a
  // blank line so the Copilot model can parse turn boundaries clearly.
  return conversation
    .map(renderTurn)
    .filter((block): block is string => block !== null)
    .join("\n\n");
}
