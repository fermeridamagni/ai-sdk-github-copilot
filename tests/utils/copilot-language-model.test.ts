/**
 * Tests for copilot-language-model.ts
 *
 * `@github/copilot-sdk` is fully mocked so these tests never spawn a real
 * Copilot CLI process. Each test controls mock behaviour through the
 * `mockClient` / `mockSession` objects created via `vi.hoisted`.
 *
 * Coverage:
 *   - Constructor / static properties
 *   - `doGenerate`: text content, reasoning content, system-message forwarding,
 *     absent system message, `client.stop()` guarantee (success + error paths),
 *     and AbortSignal handling.
 *   - `doStream`: `stream-start` preamble, `text-start` / `text-delta` /
 *     `text-end` sequence, reasoning-delta sequence, `finish` on `session.idle`,
 *     `error` part on `session.error`, double-close guard, system-message
 *     forwarding, and AbortSignal cancellation.
 */

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { CopilotLanguageModel } from "@utils/copilot-language-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — must be hoisted so the vi.mock factory can reference the objects
// ---------------------------------------------------------------------------

/**
 * `vi.hoisted` runs the callback before any module imports are processed,
 * so `mockClient` and `mockSession` are ready when `vi.mock` builds the
 * `@github/copilot-sdk` module factory below.
 */
const { mockSession, mockClient } = vi.hoisted(() => {
  const session = {
    /** Non-streaming generation — returns a full AssistantMessageEvent. */
    sendAndWait: vi.fn(),
    /** Streaming generation — kicks off event delivery via `session.on`. */
    send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    /**
     * Subscribes to session events.
     * Returns an unsubscribe function (mimics the real SDK contract).
     */
    // @ts-expect-error - on() is called before send(), so the handler exists but no events fire.
    on: vi.fn<[(event: unknown) => void], () => void>().mockReturnValue(() => {
      /* no-op unsubscribe stub */
    }),
    /** Gracefully cancels an in-progress turn. */
    abort: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  const client = {
    createSession: vi.fn().mockResolvedValue(session),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  return { mockSession: session, mockClient: client };
});

/**
 * Replace the entire `@github/copilot-sdk` package with lightweight stubs.
 * `CopilotClient` is mocked as a class whose constructor always returns
 * `mockClient`. `approveAll` is a no-op spy.
 */
vi.mock("@github/copilot-sdk", () => ({
  // A regular `function` (not an arrow function) is required here because
  // `new CopilotClient()` must be constructable. Arrow functions cannot be
  // used as constructors; returning an object from a regular constructor
  // function makes JS use that object as the `new` result.
  CopilotClient: vi.fn(function MockCopilotClient() {
    return mockClient;
  }),
  approveAll: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimum-viable call options — only the `prompt` field is required by the
 * actual code paths under test. We cast to the full type so TypeScript is
 * satisfied without repeating every optional field in every test.
 */
const makeOptions = (
  overrides: Partial<LanguageModelV3CallOptions> = {}
): LanguageModelV3CallOptions =>
  ({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello!" }],
      },
    ],
    ...overrides,
  }) as unknown as LanguageModelV3CallOptions;

/**
 * Drains a `ReadableStream<T>` into an array, resolving once the stream closes.
 *
 * Because the Copilot session events are fired synchronously inside our mock
 * `send()` implementation, the stream's internal queue is fully populated
 * before the first `reader.read()` call, so this helper terminates without
 * any special async orchestration.
 */
async function collectStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const parts: T[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Shared reset — clear call history before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Restore predictable defaults after clearAllMocks wipes call counts.
  mockClient.createSession.mockResolvedValue(mockSession);
  mockClient.stop.mockResolvedValue(undefined);
  mockSession.send.mockResolvedValue(undefined);
  mockSession.abort.mockResolvedValue(undefined);
  // @ts-expect-error - on() is called before send(), so the handler exists but no events fire.
  mockSession.on.mockReturnValue(() => {
    /* no-op unsubscribe stub */
  });
});

// ---------------------------------------------------------------------------
// Constructor / properties
// ---------------------------------------------------------------------------

describe("CopilotLanguageModel — constructor and properties", () => {
  it('specificationVersion is "v3"', () => {
    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    expect(model.specificationVersion).toBe("v3");
  });

  it('provider is "github-copilot"', () => {
    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    expect(model.provider).toBe("github-copilot");
  });

  it("stores the given modelId", () => {
    const model = new CopilotLanguageModel("claude-sonnet-4.5", {}, {});

    expect(model.modelId).toBe("claude-sonnet-4.5");
  });

  it("exposes an empty supportedUrls map", () => {
    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    expect(model.supportedUrls).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// doGenerate
// ---------------------------------------------------------------------------

describe("CopilotLanguageModel.doGenerate", () => {
  it("returns a text content block from the session result", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "Hi there!", outputTokens: 10 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const result = await model.doGenerate(makeOptions());

    expect(result.content).toEqual([{ type: "text", text: "Hi there!" }]);
  });

  it("appends a reasoning content block when reasoningText is present", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: {
        content: "The answer is 42.",
        reasoningText: "I thought carefully.",
        outputTokens: 20,
      },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const result = await model.doGenerate(makeOptions());

    expect(result.content).toEqual([
      { type: "text", text: "The answer is 42." },
      { type: "reasoning", text: "I thought carefully." },
    ]);
  });

  it("maps outputTokens to usage.outputTokens.total", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK", outputTokens: 7 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const result = await model.doGenerate(makeOptions());

    expect(result.usage.outputTokens.total).toBe(7);
  });

  it("returns undefined inputToken fields (Copilot API does not expose them)", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK", outputTokens: 5 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const result = await model.doGenerate(makeOptions());

    expect(result.usage.inputTokens.total).toBeUndefined();
    expect(result.usage.inputTokens.noCache).toBeUndefined();
    expect(result.usage.inputTokens.cacheRead).toBeUndefined();
    expect(result.usage.inputTokens.cacheWrite).toBeUndefined();
  });

  it('finishReason.unified is always "stop" (Copilot does not surface raw reasons)', async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "Done.", outputTokens: 1 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const result = await model.doGenerate(makeOptions());

    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined });
  });

  it("returns an empty warnings array", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK", outputTokens: 1 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const result = await model.doGenerate(makeOptions());

    expect(result.warnings).toEqual([]);
  });

  it("passes the system message to createSession via systemMessage.content", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK.", outputTokens: 5 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doGenerate(
      makeOptions({
        prompt: [
          { role: "system", content: "Be helpful." },
          {
            role: "user",
            content: [{ type: "text", text: "Hi." }],
          },
        ],
      })
    );

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemMessage: { mode: "append", content: "Be helpful." },
      })
    );
  });

  it("does NOT include systemMessage in createSession when the prompt has none", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK.", outputTokens: 5 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doGenerate(makeOptions());

    const callArgs = mockClient.createSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;

    expect(callArgs).not.toHaveProperty("systemMessage");
  });

  it("calls client.stop() after a successful generate call", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "Done.", outputTokens: 5 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doGenerate(makeOptions());

    expect(mockClient.stop).toHaveBeenCalledOnce();
  });

  it("calls client.stop() even when sendAndWait throws", async () => {
    mockSession.sendAndWait.mockRejectedValue(new Error("Network error"));

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    await expect(model.doGenerate(makeOptions())).rejects.toThrow(
      "Network error"
    );

    // The finally block must still run.
    expect(mockClient.stop).toHaveBeenCalledOnce();
  });

  it("calls client.stop() even when createSession throws", async () => {
    mockClient.createSession.mockRejectedValue(new Error("Auth failed"));

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    await expect(model.doGenerate(makeOptions())).rejects.toThrow(
      "Auth failed"
    );

    expect(mockClient.stop).toHaveBeenCalledOnce();
  });

  it("calls session.abort() when the AbortSignal fires before sendAndWait resolves", async () => {
    const controller = new AbortController();

    // Block sendAndWait until we explicitly resolve it.
    let resolveCall!: (value: unknown) => void;
    mockSession.sendAndWait.mockImplementation(
      () =>
        new Promise((res) => {
          resolveCall = res;
        })
    );

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    // Start the generate call without awaiting it yet.
    const generatePromise = model.doGenerate(
      makeOptions({ abortSignal: controller.signal })
    );

    // Yield to the microtask queue so that:
    //   1. `createSession()` resolves (its mock is a `mockResolvedValue`), and
    //   2. The async continuation runs and registers the AbortSignal listener.
    // Without these ticks the signal would already be aborted by the time
    // `addEventListener` is called, and the handler would never fire.
    await Promise.resolve();
    await Promise.resolve();

    // Abort while sendAndWait is genuinely "in flight".
    controller.abort();

    // Resolve the pending sendAndWait so doGenerate can finish.
    resolveCall({ data: { content: "Partial", outputTokens: 0 } });

    await generatePromise;

    expect(mockSession.abort).toHaveBeenCalledOnce();
  });

  it("passes the modelId to createSession", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK", outputTokens: 1 },
    });

    const model = new CopilotLanguageModel("my-custom-model", {}, {});
    await model.doGenerate(makeOptions());

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "my-custom-model" })
    );
  });

  it("creates a non-streaming session (streaming: false)", async () => {
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: "OK", outputTokens: 1 },
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doGenerate(makeOptions());

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ streaming: false })
    );
  });
});

// ---------------------------------------------------------------------------
// doStream
// ---------------------------------------------------------------------------

describe("CopilotLanguageModel.doStream", () => {
  /**
   * Builds a `send` mock whose async body fires the supplied `SessionEvent`
   * objects via the `session.on` handler in-order, then lets the stream
   * naturally close via the final `session.idle`.
   *
   * Because the async body has no `await` it executes synchronously within
   * the `ReadableStream.start` callback, so every part is buffered before
   * the test reads them.
   */
  // Intentionally typed as `unknown[]` rather than a specific SDK event type
  // so that tests can pass ad-hoc event shapes without importing internal types.
  const makeSendMock = (events: unknown[]) => {
    // Capture the handler registered by `session.on` just before `send` is
    // called, then fire every event through it synchronously.
    // Returns a resolved Promise (not an async function) so that Biome's
    // `useAwait` rule is satisfied while still honouring the `send(): Promise`
    // contract expected by `.catch()` in the stream's `start` callback.
    return vi.fn(() => {
      // Retrieve the handler registered in the most recent `session.on` call.
      const handler = mockSession.on.mock.calls.at(-1)?.[0] as
        | ((event: unknown) => void)
        | undefined;

      if (handler) {
        for (const event of events) {
          handler(event);
        }
      }

      return Promise.resolve();
    });
  };

  it("first part is always { type: 'stream-start', warnings: [] }", async () => {
    mockSession.send = makeSendMock([{ type: "session.idle" }]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
  });

  it("emits text-start → text-delta(s) → text-end for message_delta events", async () => {
    mockSession.send = makeSendMock([
      {
        type: "assistant.message_delta",
        data: { messageId: "msg-1", deltaContent: "Hello" },
      },
      {
        type: "assistant.message_delta",
        data: { messageId: "msg-1", deltaContent: " world" },
      },
      {
        type: "assistant.message",
        data: { messageId: "msg-1", content: "Hello world" },
      },
      { type: "session.idle" },
    ]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    expect(parts).toContainEqual({ type: "text-start", id: "msg-1" });
    expect(parts).toContainEqual({
      type: "text-delta",
      id: "msg-1",
      delta: "Hello",
    });
    expect(parts).toContainEqual({
      type: "text-delta",
      id: "msg-1",
      delta: " world",
    });
    expect(parts).toContainEqual({ type: "text-end", id: "msg-1" });
  });

  it("only opens a text block once even when multiple deltas share the same messageId", async () => {
    mockSession.send = makeSendMock([
      {
        type: "assistant.message_delta",
        data: { messageId: "msg-x", deltaContent: "A" },
      },
      {
        type: "assistant.message_delta",
        data: { messageId: "msg-x", deltaContent: "B" },
      },
      { type: "assistant.message", data: {} },
      { type: "session.idle" },
    ]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    const startCount = parts.filter(
      (p) => p.type === "text-start" && (p as { id: string }).id === "msg-x"
    ).length;

    expect(startCount).toBe(1);
  });

  it("emits reasoning-start → reasoning-delta → reasoning-end sequence", async () => {
    mockSession.send = makeSendMock([
      {
        type: "assistant.reasoning_delta",
        data: { reasoningId: "r-1", deltaContent: "Thinking…" },
      },
      { type: "assistant.message", data: {} },
      { type: "session.idle" },
    ]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    expect(parts).toContainEqual({ type: "reasoning-start", id: "r-1" });
    expect(parts).toContainEqual({
      type: "reasoning-delta",
      id: "r-1",
      delta: "Thinking…",
    });
    expect(parts).toContainEqual({ type: "reasoning-end", id: "r-1" });
  });

  it("last part is { type: 'finish', finishReason: { unified: 'stop' } } on session.idle", async () => {
    mockSession.send = makeSendMock([{ type: "session.idle" }]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    const last = parts.at(-1) as LanguageModelV3StreamPart;

    expect(last).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
    });
  });

  it("finish usage fields are undefined (streaming events lack token counts)", async () => {
    mockSession.send = makeSendMock([{ type: "session.idle" }]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    const finish = parts.find(
      (p): p is Extract<LanguageModelV3StreamPart, { type: "finish" }> =>
        p.type === "finish"
    );

    expect(finish?.usage.inputTokens.total).toBeUndefined();
    expect(finish?.usage.outputTokens.total).toBeUndefined();
  });

  it("emits an error part and closes the stream on session.error", async () => {
    mockSession.send = makeSendMock([
      {
        type: "session.error",
        data: { message: "Connection lost" },
      },
    ]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: "Connection lost" }),
      })
    );
  });

  it("does not enqueue duplicate parts after the stream is closed (double-close guard)", async () => {
    // Fire both an error and an idle event — only the first close should be
    // processed; the second must be silently ignored.
    mockSession.send = makeSendMock([
      { type: "session.error", data: { message: "oops" } },
      { type: "session.idle" }, // should be ignored
    ]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());

    // Draining the stream should not throw a "controller is closed" error.
    await expect(collectStream(stream)).resolves.not.toThrow();
  });

  it("passes the system message to createSession in streaming mode", async () => {
    mockSession.send = makeSendMock([{ type: "session.idle" }]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doStream(
      makeOptions({
        prompt: [
          { role: "system", content: "Be concise." },
          {
            role: "user",
            content: [{ type: "text", text: "Hello." }],
          },
        ],
      })
    );

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemMessage: { mode: "append", content: "Be concise." },
      })
    );
  });

  it("does NOT include systemMessage in createSession when the prompt has none", async () => {
    mockSession.send = makeSendMock([{ type: "session.idle" }]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doStream(makeOptions());

    const callArgs = mockClient.createSession.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;

    expect(callArgs).not.toHaveProperty("systemMessage");
  });

  it("creates a streaming session (streaming: true)", async () => {
    mockSession.send = makeSendMock([{ type: "session.idle" }]);

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    await model.doStream(makeOptions());

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ streaming: true })
    );
  });

  it("emits an error part and closes the stream when send() itself rejects", async () => {
    // Simulate a connection failure before any events are delivered.
    mockSession.send = vi.fn().mockRejectedValue(new Error("send failed"));
    // Since on() is called before send(), the handler exists but no events fire.
    // @ts-expect-error - on() is called before send(), so the handler exists but no events fire.
    mockSession.on.mockReturnValue(() => {
      /* no-op unsubscribe stub */
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});
    const { stream } = await model.doStream(makeOptions());
    const parts = await collectStream(stream);

    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: "send failed" }),
      })
    );
  });

  it("calls session.abort() and closes the stream when AbortSignal fires", async () => {
    const controller = new AbortController();

    // Never fire any session events — stream closure is driven solely by abort.
    mockSession.send = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error - on() is called before send(), so the handler exists but no events fire.
    mockSession.on.mockReturnValue(() => {
      /* no-op unsubscribe stub */
    });

    const model = new CopilotLanguageModel("gpt-4.1", {}, {});

    // Await doStream first so that the ReadableStream.start callback runs
    // synchronously and registers the AbortSignal listener. Aborting before
    // this point would leave the signal already-aborted when addEventListener
    // is called, which means the handler would never fire.
    const { stream } = await model.doStream(
      makeOptions({ abortSignal: controller.signal })
    );

    // Now abort — the listener is already registered, so it fires synchronously.
    // The abort handler calls session.abort().finally(() => closeStream(reason)).
    controller.abort(new Error("Cancelled by user"));

    // Drain the stream. The .finally() microtask runs between reads, closing
    // the stream via closeStream(abortSignal.reason).
    const parts = await collectStream(stream);

    expect(mockSession.abort).toHaveBeenCalledOnce();
    // stream-start is always the first part regardless of how the stream ends.
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
  });
});
