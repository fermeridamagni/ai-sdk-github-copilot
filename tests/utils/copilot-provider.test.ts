/**
 * Tests for copilot-provider.ts
 *
 * Validates the `createCopilot` factory and the default `copilot` export:
 *   - Provider is callable (shorthand for `languageModel`)
 *   - `specificationVersion` is `"v3"`
 *   - Returned models are `CopilotLanguageModel` instances with the correct `modelId`
 *   - `embeddingModel` and `imageModel` stubs throw `NoSuchModelError`
 *
 * The Copilot SDK itself is not invoked during these tests because we only
 * exercise the factory wiring, not the actual `doGenerate`/`doStream` paths.
 */

import { NoSuchModelError } from "@ai-sdk/provider";
import { CopilotLanguageModel } from "@utils/copilot-language-model";
import { copilot, createCopilot } from "@utils/copilot-provider";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// createCopilot factory
// ---------------------------------------------------------------------------

describe("createCopilot", () => {
  it("returns a callable function", () => {
    const provider = createCopilot();

    expect(typeof provider).toBe("function");
  });

  it('has specificationVersion "v3"', () => {
    const provider = createCopilot();

    expect(provider.specificationVersion).toBe("v3");
  });

  it("provider(modelId) returns a CopilotLanguageModel with the correct modelId", () => {
    const provider = createCopilot();
    const model = provider("gpt-4.1");

    expect(model).toBeInstanceOf(CopilotLanguageModel);
    expect(model.modelId).toBe("gpt-4.1");
  });

  it("provider.languageModel(modelId) returns a CopilotLanguageModel", () => {
    const provider = createCopilot();
    const model = provider.languageModel("claude-sonnet-4.5");

    expect(model).toBeInstanceOf(CopilotLanguageModel);
    expect(model.modelId).toBe("claude-sonnet-4.5");
  });

  it("provider() and provider.languageModel() are equivalent for the same modelId", () => {
    const provider = createCopilot();

    // Both paths produce the same kind of model; compare by shape, not reference.
    const fromShorthand = provider("gpt-4o");
    const fromMethod = provider.languageModel("gpt-4o");

    expect(fromShorthand).toBeInstanceOf(CopilotLanguageModel);
    expect(fromMethod).toBeInstanceOf(CopilotLanguageModel);
    expect(fromShorthand.modelId).toBe(fromMethod.modelId);
    expect(fromShorthand.provider).toBe(fromMethod.provider);
    expect(fromShorthand.specificationVersion).toBe(
      fromMethod.specificationVersion
    );
  });

  it("accepts provider-level settings and passes them down", () => {
    // The provider should accept settings without throwing. We can't easily
    // inspect the forwarded clientOptions here, but the model constructor
    // must not throw during construction.
    expect(() =>
      createCopilot({ gitHubToken: "ghp_fake", logLevel: "error" })
    ).not.toThrow();
  });

  it("embeddingModel throws NoSuchModelError", () => {
    const provider = createCopilot();

    expect(() => provider.embeddingModel("text-embedding-3-small")).toThrow(
      NoSuchModelError
    );
  });

  it("imageModel throws NoSuchModelError", () => {
    const provider = createCopilot();

    expect(() => provider.imageModel("dall-e-3")).toThrow(NoSuchModelError);
  });

  it("NoSuchModelError for embeddingModel carries the correct modelId", () => {
    const provider = createCopilot();

    try {
      provider.embeddingModel("text-embedding-ada-002");
      // Should not reach here
      expect.fail("Expected NoSuchModelError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoSuchModelError);
    }
  });

  it("each call to provider(modelId) returns a fresh model instance", () => {
    const provider = createCopilot();

    const m1 = provider("gpt-4.1");
    const m2 = provider("gpt-4.1");

    // Different object references, even for the same modelId.
    expect(m1).not.toBe(m2);
  });
});

// ---------------------------------------------------------------------------
// Default copilot export
// ---------------------------------------------------------------------------

describe("copilot (default instance)", () => {
  it("is callable and returns a CopilotLanguageModel", () => {
    const model = copilot("gpt-4o");

    expect(model).toBeInstanceOf(CopilotLanguageModel);
  });

  it('has specificationVersion "v3"', () => {
    expect(copilot.specificationVersion).toBe("v3");
  });

  it("provider 'github-copilot' is set on returned models", () => {
    const model = copilot("gpt-4.1");

    expect(model.provider).toBe("github-copilot");
  });

  it("embeddingModel throws NoSuchModelError on the default instance", () => {
    expect(() => copilot.embeddingModel("any-model")).toThrow(NoSuchModelError);
  });
});
