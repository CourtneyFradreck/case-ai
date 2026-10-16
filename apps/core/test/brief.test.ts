import { afterEach, describe, expect, it, vi } from "vitest";
import { generateModelBrief } from "../src/llm/brief.js";
import { finding, snap } from "./fixtures.js";
import { DateTime } from "luxon";

const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "yesterday" };
const cfg = { modelIncludePrivate: false, modelTimeoutMs: 1000, maxBriefChars: 3800 };
const raw = JSON.stringify({ yesterday: [{ text: "You made progress.", sources: ["F1"] }], attention: [], focus: [] });

describe("model brief generation", () => {
  afterEach(() => vi.useRealTimers());
  it("retries an invalid response and sums tokens from both attempts", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ raw: "invalid", model: "test", inputTokens: 10, outputTokens: 2 }).mockResolvedValueOnce({ raw, model: "test", inputTokens: 12, outputTokens: 8 });
    const result = await generateModelBrief([finding()], [snap()], w, cfg, { name: "test", generate });
    expect(result).toMatchObject({ model: "test", inputTokens: 22, outputTokens: 10, json: { attempts: 2, fallbackReason: null, raw, brief: { yesterday: [{ text: "You made progress.", sources: ["F1"] }] } } });
    expect("text" in result && result.text).toContain("• Made progress.");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("records fallback metadata after two invalid outputs", async () => {
    const generate = vi.fn().mockResolvedValue({ raw: "invalid", model: "test", inputTokens: 10, outputTokens: 2 });
    expect(await generateModelBrief([finding()], [snap()], w, cfg, { name: "test", generate })).toMatchObject({ fallbackReason: "invalid_json", inputTokens: 20, outputTokens: 4, json: { attempts: 2, fallbackReason: "invalid_json", brief: null } });
  });
  it("falls back after provider exceptions and bounds attempts", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("network"));
    expect(await generateModelBrief([finding()], [snap()], w, cfg, { name: "test", generate })).toMatchObject({ fallbackReason: "provider_error", json: { attempts: 2 } });
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("times out a provider that never settles", async () => {
    vi.useFakeTimers();
    const generate = vi.fn(() => new Promise<never>(() => {}));
    const result = generateModelBrief([finding()], [snap()], w, cfg, { name: "test", generate });
    await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toMatchObject({ fallbackReason: "model_timeout", json: { attempts: 2 } });
  });
  it("restores excluded private findings without calling the provider when nothing can be sent", async () => {
    const generate = vi.fn();
    const result = await generateModelBrief([finding()], [snap({ private: true })], w, cfg, { name: "test", generate });
    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ model: null, json: { attempts: 0, fallbackReason: null } });
    expect("text" in result && result.text).toContain("<b>demo</b>\n• 3 commits on main.");
  });
  it("passes the configured name to the model prompt and renders with the injected time", async () => {
    const generate = vi.fn().mockResolvedValue({ raw, model: "test" });
    const result = await generateModelBrief([finding()], [snap()], w, { ...cfg, userName: "Alex" }, { name: "test", generate }, DateTime.fromISO("2026-10-14T16:00:00Z"));
    expect(generate.mock.calls[0][0]).toContain('Address Alex as "you".');
    expect("text" in result && result.text).toContain("<b>Good evening, Alex. Here's your morning brief.</b>\nWednesday, 14 Oct 2026");
  });
});
