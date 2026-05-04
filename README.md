# AI SDK — GitHub Copilot Provider

A community [Vercel AI SDK](https://sdk.vercel.ai) v6 provider that wraps the
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk) and bridges
GitHub Copilot's session-based SDK to the AI SDK's stateless request model.

Use `generateText`, `streamText`, and other AI SDK primitives with the full
catalogue of models available through your GitHub Copilot subscription — without managing CLI sessions or JSON-RPC plumbing yourself.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Streaming](#streaming)
- [Multi-turn Conversations](#multi-turn-conversations)
- [Available Model IDs](#available-model-ids)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Limitations](#limitations)
- [Links](#links)

---

## Prerequisites

| Requirement | Details |
|---|---|
| **GitHub Copilot CLI** | Install via `npm i -g @github/copilot` and authenticate with `gh auth login`. Run `gh copilot --version` to verify. |
| **Node.js 18+** | Or [Bun](https://bun.sh) 1.0+. |
| **Copilot subscription** | A GitHub account with an active GitHub Copilot Individual, Business, or Enterprise plan. |

> The `@github/copilot-sdk` spawns the Copilot CLI binary as a local server
> process. The CLI handles all authentication and proxying to GitHub's model
> endpoints; no API key is required beyond your Copilot subscription.

---

## Installation

```sh
# npm
npm i ai-sdk-github-copilot

# pnpm
pnpm add ai-sdk-github-copilot

# Bun
bun add ai-sdk-github-copilot
```

The package lists `@ai-sdk/provider`, `@ai-sdk/provider-utils`, and
`@github/copilot-sdk` as peer/production dependencies. Install the AI SDK
core package separately if you haven't already:

```sh
# npm
npm i ai

# pnpm
pnpm add ai

# Bun
bun add ai
```

---

## Quick Start

```ts
// generate.ts
import { generateText } from "ai";
import { copilot } from "ai-sdk-github-copilot";

// `copilot('gpt-5.5')` is shorthand for `copilot.languageModel('gpt-5.5')`.
const { text } = await generateText({
  model: copilot("gpt-5.5"),
  prompt: "Explain the difference between a monad and a functor in one paragraph.",
});

console.log(text);
```

Run with Bun:

```sh
bun run generate.ts
```

---

## Streaming

Stream tokens to the terminal (or to a `ReadableStream` in a web handler) with
`streamText`:

```ts
// stream.ts
import { streamText } from "ai";
import { copilot } from "ai-sdk-github-copilot";

const { textStream } = streamText({
  model: copilot("gpt-5.5"),
  prompt: "Write a haiku about software engineers at 2 AM.",
});

// Each chunk arrives as soon as the model produces it.
for await (const chunk of textStream) {
  process.stdout.write(chunk);
}

console.log(); // Trailing newline
```

---

## Multi-turn Conversations

Pass an array of `messages` to simulate a conversation. The provider
serialises the full history into a single Copilot session message — see
[Limitations](#limitations) for details.

```ts
// chat.ts
import { generateText } from "ai";
import { copilot } from "ai-sdk-github-copilot";

const { text } = await generateText({
  model: copilot("claude-sonnet-4.6"),
  messages: [
    {
      role: "system",
      content: "You are a concise assistant. Answer in at most two sentences.",
    },
    { role: "user", content: "My favourite language is TypeScript." },
    { role: "assistant", content: "Great choice! TypeScript brings type safety to JavaScript." },
    { role: "user", content: "What is my favourite language?" },
  ],
});

// Expected: mentions TypeScript
console.log(text);
```

---

## Available Model IDs

Pass any model ID that is available on your Copilot subscription as the first
argument to `copilot()`. The string is forwarded verbatim to the Copilot CLI
session.

> **Get the live list** — available models depend on your subscription tier and
> can change over time. Fetch the current list at runtime:
>
> ```ts
> import { CopilotClient } from "@github/copilot-sdk";
>
> const client = new CopilotClient();
> const models = await client.listModels();
> console.log(models.map((m) => m.id));
> await client.stop();
> ```

---

## Configuration

Use `createCopilot` when you need to customise authentication or connection
settings. All options map directly to `CopilotClientOptions` from
`@github/copilot-sdk`.

```ts
// provider.ts
import { createCopilot } from "ai-sdk-github-copilot";

/**
 * Provider configured with an explicit GitHub token and reduced log noise.
 * Share this instance across your application to reuse the CLI process.
 */
export const copilotProvider = createCopilot({
  // ── Authentication ────────────────────────────────────────────────────────
  // Explicit GitHub token (PAT or OAuth token with `copilot` scope).
  // When omitted the CLI uses the token stored by `gh auth login`.
  gitHubToken: process.env.GITHUB_TOKEN,

  // ── CLI Connection ────────────────────────────────────────────────────────
  // Connect to an existing CLI server instead of spawning a new process.
  // Format: "host:port" | "http://host:port" | "port"
  // cliUrl: "localhost:8080",

  // ── Logging ───────────────────────────────────────────────────────────────
  // Verbosity of the spawned CLI process.
  // "none" | "error" | "warning" | "info" | "debug" | "all"
  logLevel: "error",
});
```

```ts
// usage.ts
import { generateText } from "ai";
import { copilotProvider } from "./provider.ts";

const { text } = await generateText({
  model: copilotProvider("gpt-5.5"),
  prompt: "Summarise the history of the internet in three bullet points.",
});

console.log(text);
```

### `CopilotProviderSettings` reference

| Option | Type | Description |
|---|---|---|
| `gitHubToken` | `string` | GitHub token for authentication. Takes priority over other auth methods. |
| `cliUrl` | `string` | URL of a running CLI server to connect to (skips spawning a new process). |
| `logLevel` | `"none" \| "error" \| "warning" \| "info" \| "debug" \| "all"` | Log verbosity for the CLI process. |
| `cliPath` | `string` | Path to a custom CLI executable. Defaults to the bundled binary. |
| `useLoggedInUser` | `boolean` | Whether to use stored `gh` CLI credentials. Defaults to `true`. |

---

## Architecture

```
Your Application
       │
       ▼
 AI SDK (generateText / streamText)
       │  calls doGenerate() / doStream()
       ▼
 CopilotLanguageModel          ← LanguageModelV3 implementation
       │  creates / stops
       ▼
 CopilotClient                 ← from @github/copilot-sdk
       │  opens session, sends prompt, collects events
       ▼
 CopilotSession
       │  JSON-RPC over stdio (default) or TCP
       ▼
 GitHub Copilot CLI  (server mode, managed by the SDK)
       │  HTTPS
       ▼
 GitHub Models API             ← actual LLM inference
```

### Bridging two different models

The **AI SDK** expects a *stateless* interface — one `doGenerate` or `doStream`
call produces one result, with no persistent state between calls.

The **Copilot SDK** is *session-based* — you open a session, send one or more
messages, and subscribe to streaming events over the lifetime of that session.

This provider bridges the two as follows:

1. **Provider level** — `createCopilot(settings)` captures CLI/auth
   configuration. A single `CopilotClient` is lazily started the first time a
   model is used, and reused for subsequent requests.

2. **Request level** — each `doGenerate` / `doStream` call:
   - Opens a new `CopilotSession` for the requested model.
   - Serialises the AI SDK `LanguageModelV3Prompt` (which may contain system,
     user, and assistant turns) into a single string message.
   - Sends the message with `session.sendAndWait` (non-streaming) or
     `session.send` + event subscription (streaming).
   - Maps `assistant.message` / `assistant.message_delta` events to
     `LanguageModelV3GenerateResult` / `LanguageModelV3StreamPart`.
   - Closes the session once the response is complete.

3. **Streaming** — `assistant.message_delta` events are forwarded as
   `text-delta` stream parts. A `stream-start`, `response-metadata`, and
   `finish` part are emitted around them to satisfy the AI SDK stream contract.

---

## Limitations

| Limitation | Details |
|---|---|
| **No tool calling** | Tools and `toolChoice` passed via the AI SDK are silently ignored and not forwarded to the Copilot session. The Copilot SDK has its own tool system; bridging the two APIs is a planned future enhancement. |
| **Single prompt per session** | Each `doGenerate` / `doStream` call opens a *fresh* session. Multi-turn message history is concatenated into one user message rather than replayed as separate turns. True stateful multi-session support is not yet implemented. |
| **Copilot CLI required** | `@github/copilot-sdk` spawns the Copilot CLI binary. The CLI must be installed (`npm i -g @github/copilot`) and authenticated before use. |
| **Technical Preview** | `@github/copilot-sdk` is in Technical Preview and may introduce breaking changes in any release. This package will track those changes, but production use is not recommended until the SDK stabilises. |
| **No embeddings or images** | The GitHub Copilot API does not expose embedding or image generation endpoints. Calling `provider.embeddingModel()` or `provider.imageModel()` throws a `NoSuchModelError`. |

---

## Contributing
Contributions to this provider are very welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute, run tests, and submit changes.

## Links

- [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) — The underlying Copilot SDK this package wraps
- [Vercel AI SDK](https://sdk.vercel.ai) — Documentation for `generateText`, `streamText`, and the provider interface
- [AI SDK Provider Specification](https://sdk.vercel.ai/providers/community-providers/custom-providers) — How to build a custom AI SDK provider
- [GitHub Copilot](https://github.com/features/copilot) — Subscription plans and feature overview
