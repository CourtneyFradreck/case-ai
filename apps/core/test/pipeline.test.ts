import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finding, snap } from "./fixtures.js";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(), query: vi.fn(), release: vi.fn(), collectAll: vi.fn(), runRules: vi.fn(),
  startRun: vi.fn(), finishRun: vi.fn(), storeSnapshots: vi.fn(), storeFindings: vi.fn(), storeBrief: vi.fn(),
  env: { briefMode: "rules", geminiApiKey: "test", geminiModel: "test-model", repos: ["me/demo"] },
}));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
vi.mock("../src/db.js", () => ({ pool: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock("../src/github/collect.js", () => ({ collectAll: mocks.collectAll }));
vi.mock("../src/rules/index.js", () => ({ runRules: mocks.runRules }));
vi.mock("../src/store.js", () => ({ startRun: mocks.startRun, finishRun: mocks.finishRun, storeSnapshots: mocks.storeSnapshots, storeFindings: mocks.storeFindings, storeBrief: mocks.storeBrief }));
vi.mock("../src/llm/gemini.js", () => ({ GeminiBriefModel: class { name = "test-model"; generate = mocks.generate; } }));
import { runBrief } from "../src/pipeline.js";
import { render } from "../src/render.js";
import { yesterdayWindow } from "../src/time.js";

describe("model pipeline", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T05:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.env.briefMode = "rules";
    mocks.query.mockResolvedValue({ rows: [{ ok: true }] });
    mocks.startRun.mockResolvedValue(7);
    mocks.collectAll.mockResolvedValue([snap()]);
    mocks.runRules.mockReturnValue([finding()]);
    mocks.generate.mockResolvedValue({ raw: JSON.stringify({ yesterday: [{ text: "Model progress", sources: ["F1"] }], attention: [], focus: [] }), model: "test-model", inputTokens: 10, outputTokens: 4 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it.each([
    ["rules", "schedule", false], ["rules", "command", false],
    ["command", "schedule", false], ["command", "command", true],
    ["all", "schedule", true], ["all", "command", true],
  ] as const)("selects mode %s for %s", async (mode, source, usesModel) => {
    mocks.env.briefMode = mode;
    const result = await runBrief(source);
    expect(Object.keys(result).sort()).toEqual(["runId", "text"]);
    expect(mocks.generate).toHaveBeenCalledTimes(usesModel ? 1 : 0);
    if (usesModel) expect(result.text).toContain("Model progress");
    else {
      expect(result).toEqual({ runId: 7, text: render([finding()], [snap()], yesterdayWindow(), 3800, undefined, { userName: "Courtney" }) });
      expect(mocks.storeBrief).toHaveBeenCalledWith(7, result.text, undefined);
    }
    expect(console.info).toHaveBeenCalledTimes(1);
  });
  it("returns a model brief after a failed first attempt", async () => {
    mocks.env.briefMode = "all";
    const valid = mocks.generate.getMockImplementation()!;
    mocks.generate.mockResolvedValueOnce({ raw: "invalid", model: "test-model", inputTokens: 2, outputTokens: 1 }).mockImplementation(valid);
    const result = await runBrief("command");
    expect(result.text).toContain("Model progress");
    expect(mocks.storeBrief.mock.calls[0][2]).toMatchObject({ inputTokens: 12, outputTokens: 5, json: { attempts: 2 } });
  });
  it.each(["invalid", "exception"])("sends and stores the fallback after two %s attempts", async (failure) => {
    mocks.env.briefMode = "all";
    if (failure === "exception") mocks.generate.mockRejectedValue(new Error("unavailable"));
    else mocks.generate.mockResolvedValue({ raw: "invalid", model: "test-model" });
    const result = await runBrief("command");
    expect(result.text).toBe(render([finding()], [snap()], yesterdayWindow(), 3800, "Rule-only brief: model unavailable", { userName: "Courtney" }));
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.storeBrief.mock.calls[0][2]).toMatchObject({ json: { attempts: 2, fallbackReason: failure === "exception" ? "provider_error" : "invalid_json" } });
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "ok");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("skips the model on a quiet day", async () => {
    mocks.env.briefMode = "all";
    mocks.runRules.mockReturnValue([]);
    expect((await runBrief("command")).text).toContain("Quiet day");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.storeBrief.mock.calls[0][2]).toBeUndefined();
  });
  it("still propagates database failures", async () => {
    mocks.storeFindings.mockRejectedValue(new Error("DB unavailable"));
    await expect(runBrief("command")).rejects.toThrow("DB unavailable");
    expect(mocks.finishRun).toHaveBeenCalledWith(7, "failed", "Error: DB unavailable");
  });
});
