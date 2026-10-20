import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.hoisted(() => vi.fn());
vi.mock("@google/genai", () => ({
  ThinkingLevel: { LOW: "LOW" },
  GoogleGenAI: class { models = { generateContent }; },
}));
import { GeminiBriefModel } from "../src/llm/gemini.js";

describe("Gemini provider", () => {
  beforeEach(() => vi.resetAllMocks());
  it("requests schema-constrained JSON with low thinking and the configured timeout", async () => {
    generateContent.mockResolvedValue({ text: "{}", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 3 } });
    const provider = new GeminiBriefModel("test-key", "test-model", 1234);
    expect(await provider.generate("system", "user", { type: "object" })).toEqual({ raw: "{}", model: "test-model", inputTokens: 10, outputTokens: 23 });
    expect(generateContent).toHaveBeenCalledWith({
      model: "test-model", contents: "user",
      config: { systemInstruction: "system", responseMimeType: "application/json", responseJsonSchema: { type: "object" }, thinkingConfig: { thinkingLevel: "LOW" }, httpOptions: { timeout: 1234 } },
    });
  });
  it("handles missing token metadata and missing thought counts", async () => {
    generateContent.mockResolvedValueOnce({ text: "{}" }).mockResolvedValueOnce({ text: "{}", usageMetadata: { candidatesTokenCount: 4 } });
    const provider = new GeminiBriefModel("test-key", "test-model", 1234);
    expect((await provider.generate("s", "u", {})).outputTokens).toBeUndefined();
    expect((await provider.generate("s", "u", {})).outputTokens).toBe(4);
  });
  it.each([undefined, "", "   "])("rejects empty output (%s)", async (text) => {
    generateContent.mockResolvedValue({ text });
    await expect(new GeminiBriefModel("key", "model", 1000).generate("s", "u", {})).rejects.toThrow("Empty model response");
  });
});
