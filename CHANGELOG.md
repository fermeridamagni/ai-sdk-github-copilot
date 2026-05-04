# Changelog

## v1.0.0 - 2026-05-04

Compared to the initial repository history

### Features
- feat: add GitHub Actions workflow for package publishing (41b3f01)
- feat: add auto-assign workflow for issues and pull requests (9c9c313)
- feat: add changelog and update package.json metadata (83bc504)
- feat: update package.json for module exports and dependencies (b7d05f3)
- feat: add tsdown configuration for library bundling (f762314)
- feat: implement core Copilot provider and language model functionality (c1e0c34)

### Fixes
- fix: changed version before release (e51caa3)

### Documentation
- docs: clarify language usage in project rules (356a53d)
- docs: add contributing guide and README for AI SDK provider (7d22af0)

### Chores
- chore: add path alias for utils in tsconfig.json (d2f9f99)
- chore: update biome configuration to include JavaScript globals (9453284)
- chore: added new instructions to AGENTS.md (45a3005)

### Other Changes
- Add MIT License to the project (020287e)
- Add unit tests for Copilot language model and provider (4c4360d)
- initial commit (e769935)

All notable changes to `ai-sdk-github-copilot` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [1.0.0] — 2026-05-04

### Summary

Initial public release of `ai-sdk-github-copilot` — a community
[Vercel AI SDK](https://sdk.vercel.ai) v6 provider that bridges the
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk) (session-based,
CLI-driven) with the AI SDK's stateless `LanguageModelV3` interface.

Use `generateText`, `streamText`, and other AI SDK primitives with any model
available through your GitHub Copilot subscription — no API keys, no CLI
session management, no JSON-RPC plumbing required.

---

### Added

#### Core provider

- **`createCopilot(settings?)`** — factory function that creates a fully
  configured `CopilotProvider` satisfying the AI SDK `ProviderV3` (v3)
  contract. Accepts optional `CopilotProviderSettings` for authentication,
  connection, logging, and CLI path configuration. Lazily starts a
  `CopilotClient` that is reused across all requests vended by the same
  instance.

- **`copilot`** — a ready-to-use default provider instance created with no
  arguments. Relies on the GitHub Copilot CLI being installed on `$PATH` and
  the user being authenticated via `gh auth login` or the `GITHUB_TOKEN`
  environment variable.

- **Callable provider shorthand** — `copilot('gpt-4.1')` is equivalent to
  `copilot.languageModel('gpt-4.1')`, matching the convention used by other
  AI SDK community providers.

- **`CopilotProvider` interface** — exported TypeScript interface for typing
  variables that hold a provider instance.

#### Language model

- **`CopilotLanguageModel`** — full `LanguageModelV3` implementation that
  bridges each AI SDK request to a `CopilotSession`:

  - **`doGenerate`** — non-streaming path. Opens a `CopilotSession`, calls
    `session.sendAndWait`, maps the completed `assistant.message` event to a
    `LanguageModelV3GenerateResult`, and closes the session. Handles abort
    signals by stopping the session mid-flight.

  - **`doStream`** — streaming path. Opens a `CopilotSession`, subscribes to
    `assistant.message_delta` and `assistant.reasoning_delta` events, and
    forwards each delta as the corresponding AI SDK stream part
    (`text-start`, `text-delta`, `text-end`, `reasoning-start`,
    `reasoning-delta`, `reasoning-end`). Emits `stream-start`,
    `response-metadata`, and `finish` parts to fulfil the AI SDK stream
    contract. Handles abort signals and session errors by closing the stream
    cleanly.

  - **Reasoning support** — `assistant.reasoning_delta` events are mapped to
    `reasoning-delta` stream parts so extended-thinking models surface their
    chain-of-thought through the standard AI SDK interface.

  - **Finish reason mapping** — Copilot session termination signals are
    normalised to the AI SDK's unified finish-reason vocabulary (`stop`,
    `length`, `tool-calls`, `content-filter`, `error`, `other`).

  - **Token usage** — prompt and completion token counts are extracted from
    session metadata and forwarded as `LanguageModelV3Usage`. Fields that the
    Copilot SDK does not expose (e.g. cache-read/write tokens) are reported as
    `0` rather than omitted, keeping downstream usage aggregators happy.

  - **Abort signal propagation** — both `doGenerate` and `doStream` honour the
    `AbortSignal` passed by the AI SDK, stopping the underlying Copilot session
    and surface a cancellation error to the caller.

- **`NoSuchModelError` for unsupported model types** — calling
  `provider.embeddingModel(id)` or `provider.imageModel(id)` throws a typed
  `NoSuchModelError` from `@ai-sdk/provider`, matching the error contract
  expected by the AI SDK runtime.

#### Prompt conversion

- **`convertToPrompt(prompt)`** — converts a `LanguageModelV3Prompt` (the
  structured array of system / user / assistant / tool messages) into the flat
  string accepted by `session.send()`. Rendering rules:

  | Scenario | Output |
  |---|---|
  | Single user message with one text part | Raw text (no `Human:` prefix) |
  | Multi-turn conversation | `Human: …` / `Assistant: …` blocks separated by `\n\n` |
  | Assistant tool-call part | `[Called toolName(args)]` annotation |
  | Tool-result message | `[Result from toolName: value]` annotation |
  | File parts | Silently omitted (Copilot session is plain-text only) |

- **`extractSystemMessage(prompt)`** — extracts and concatenates all
  `system`-role messages into a single string so the caller can forward them
  to the Copilot session via `systemMessage: { mode: 'append', content }` at
  session-creation time, keeping system instructions separate from the user
  prompt.

#### Configuration & types

- **`CopilotProviderSettings`** — exported TypeScript interface covering all
  provider-level options:
  - `gitHubToken` — explicit GitHub PAT or OAuth token for authentication.
  - `cliUrl` — URL of an existing Copilot CLI server (skips spawning a process).
  - `cliPath` — path to a custom Copilot CLI binary.
  - `logLevel` — verbosity of the spawned CLI process
    (`"none"` | `"error"` | `"warning"` | `"info"` | `"debug"` | `"all"`).

- **`CopilotModelSettings`** — exported TypeScript type for per-model overrides
  passed to `languageModel(modelId, settings?)`. Currently an empty interface,
  reserved for future per-model configuration (e.g. temperature, top-p).

#### Package & build

- **Dual CJS + ESM output** — the package ships both `dist/main.mjs` (ESM) and
  `dist/main.cjs` (CommonJS) with co-located TypeScript declaration files
  (`dist/main.d.mts` / `dist/main.d.cts`) generated by
  [tsdown](https://tsdown.dev). The `exports` map in `package.json` wires the
  correct entry point for each module system automatically.

- **Peer dependency on `ai >= 6.0.174`** — the package is compatible with AI
  SDK v6 and tracks the `LanguageModelV3` specification version `"v3"`.

- **Vitest test suite** — unit tests for `convertToPrompt`,
  `CopilotLanguageModel`, and `CopilotProvider` covering key behaviours and
  edge cases.

- **Ultracite / Biome** — zero-config linting and formatting enforced via
  `bun x ultracite check` / `bun x ultracite fix`.

---

### Known Limitations

| Limitation | Details |
|---|---|
| **No tool calling** | `tools` and `toolChoice` passed through the AI SDK are silently ignored. Bridging AI SDK tools with the Copilot SDK's own tool system is planned for a future release. |
| **Single prompt per session** | Each `doGenerate` / `doStream` call opens a fresh `CopilotSession`. Multi-turn message history is concatenated into one user message rather than replayed as separate turns. |
| **Copilot CLI required** | `@github/copilot-sdk` spawns the GitHub Copilot CLI binary. The CLI must be installed (`npm i -g @github/copilot`) and authenticated before use. |
| **Technical Preview upstream** | `@github/copilot-sdk` is in Technical Preview and may introduce breaking changes. Production use is not recommended until the upstream SDK stabilises. |
| **No embeddings or image generation** | The GitHub Copilot API does not expose embedding or image generation endpoints. |

---

### Dependencies

| Package | Version | Role |
|---|---|---|
| `@ai-sdk/provider` | `^3.0.10` | `LanguageModelV3`, `ProviderV3`, and error types |
| `@ai-sdk/provider-utils` | `^4.0.26` | Utility helpers (`NoSuchModelError`, etc.) |
| `@github/copilot-sdk` | `^0.3.0` | `CopilotClient` and `CopilotSession` |
| `ai` *(peer)* | `>=6.0.174` | AI SDK core (`generateText`, `streamText`, …) |

---

### Contributors

- [@fermeridamagni](https://github.com/fermeridamagni) — initial implementation

[1.0.0]: https://github.com/fermeridamagni/ai-sdk-github-copilot/releases/tag/v1.0.0

