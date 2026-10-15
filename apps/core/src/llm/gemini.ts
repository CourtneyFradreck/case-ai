import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { BriefModel, ModelResult } from "./provider.js";

export class GeminiBriefModel implements BriefModel {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string, public readonly name: string, private readonly modelTimeoutMs: number) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(system: string, user: string, jsonSchema: object): Promise<ModelResult> {
    const response = await this.ai.models.generateContent({
      model: this.name,
      contents: user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        httpOptions: { timeout: this.modelTimeoutMs },
      },
    });
    const raw = response.text;
    if (!raw?.trim()) throw new Error("Empty model response");
    const usage = response.usageMetadata;
    return {
      raw, model: this.name,
      inputTokens: usage?.promptTokenCount,
      outputTokens: usage?.candidatesTokenCount === undefined && usage?.thoughtsTokenCount === undefined
        ? undefined : (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    };
  }
}
